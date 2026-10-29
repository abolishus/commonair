// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel bot engine (E8, ADR 0026 decision 6). Filters run in `process` (before a message is
 * accepted); commands, `!points`, `!sr` and `!commands` in `onMessage`; timers on an interval.
 * Every reply is `host.say` as the channel's bot account. Several chat instances host the same
 * room, so whatever is counted or claimed across them lives in Valkey or Postgres: chat lines,
 * cooldowns, timer marks and locks in Valkey; timer firings, points and use counts in Postgres.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { BUS, BotControlMessage, CHAT_LIMITS } from "@commonair/contracts";
import { KEYS } from "@commonair/contracts/internal";
import { InsufficientPointsError, pointsBalance, postPointsInTx, schema, uuidv7, type Database } from "@commonair/db";
import { emitEvent, pointsChangePayload } from "@commonair/interact";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { MAX_TIMEOUT_SECONDS } from "../../commands.ts";
import { parseJson } from "../../control.ts";
import { errorFields } from "../../errors.ts";
import type { MessageContext, MiddlewareResult, PluginHost } from "../../pipeline.ts";
import type { ChannelState } from "../../types.ts";
import { checkFilters, type FilterKind } from "./filters.ts";
import { bypassesCooldown, exemptFromFilters, meetsLevel } from "./levels.ts";
import { acceptSongUrl, type BuiltinCommand, parseBang, resolveCommand, toUser } from "./parse.ts";
import { BotState, type ChannelBotConfig, type CommandDef, type CommandSet, type TimerDef } from "./state.ts";
import { cutText, formatUptime, renderTemplate, templateNeeds, type TemplateVars } from "./template.ts";

/** How often timers are checked. */
export const TIMER_TICK_MS = 15_000;
/** `KEYS.botTimerLock`: held across render-and-say so a slow instance cannot double-post. */
export const TIMER_LOCK_MS = 10_000;
/** Timer marks expire after a week without a firing; the timer then waits for fresh lines. */
export const TIMER_MARK_TTL_SECONDS = 7 * 86_400;
/** Per viewer, for `!points` and `!commands` (the broadcaster and moderators skip it). */
export const BUILTIN_COOLDOWN_SECONDS = 5;
/** Queued song requests one viewer may have in a channel. */
export const MAX_QUEUED_PER_REQUESTER = 3;
const UPTIME_CACHE_MAX = 1_000;
const NOTICED_MAX = 10_000;

export interface BotEngineOptions {
  /** Timer check interval (default 15 s); tests shorten it. 0 turns the interval off. */
  timerTickMs?: number;
  /** State cache TTL (default 60 s). */
  stateTtlMs?: number;
}

type Channel = Pick<ChannelState, "id" | "slug" | "displayName" | "ownerId" | "liveBroadcastId">;

/** The command was removed between the cache load and its use: answer nothing. */
class CommandGone extends Error {}

export class BotEngine {
  readonly state: BotState;
  private readonly db: Database;
  private readonly valkey: ValkeyClient;
  private readonly logger: Logger;
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Channels whose bot got a notice back (banned, rate-limited, …): logged once, never retried. */
  private readonly noticed = new Set<string>();
  private readonly broadcastStarts = new Map<string, Date>();

  constructor(
    private readonly host: PluginHost,
    private readonly opts: BotEngineOptions = {},
  ) {
    this.db = host.db;
    this.valkey = host.valkey;
    this.logger = host.logger;
    this.state = new BotState(host.db, host.logger, { ttlMs: opts.stateTtlMs });
  }

  async start(): Promise<void> {
    await this.host.subscribe(BUS.botControl, (raw) => this.onControl(raw));
    const tickMs = this.opts.timerTickMs ?? TIMER_TICK_MS;
    if (tickMs > 0) {
      this.interval = setInterval(() => {
        this.tickTimers().catch((err: unknown) => this.logger.error("bot timers failed", errorFields(err)));
      }, tickMs);
      this.interval.unref?.();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  onControl(raw: string): void {
    const msg = parseJson(BotControlMessage, raw);
    if (!msg) return;
    this.state.drop(msg.channelId, msg.scope);
    if (msg.scope === "config") this.noticed.delete(msg.channelId);
  }

  // ── filters ────────────────────────────────────────────────────────────────

  async process(ctx: MessageContext): Promise<MiddlewareResult> {
    const bot = await this.state.config.get(ctx.channel.id);
    if (!bot || ctx.user.id === bot.botUserId || exemptFromFilters(ctx.standing)) return "continue";
    const verdict = checkFilters(ctx.body, bot.config.filters, ctx.standing);
    if (!verdict) return "continue";
    const seconds = Math.min(bot.config.filters.timeoutSeconds, MAX_TIMEOUT_SECONDS);
    if (seconds > 0) this.timeout(ctx.channel, bot, ctx.user.username, seconds, verdict.kind);
    return { drop: verdict.code, text: verdict.text };
  }

  /** Fire-and-forget: the drop must not wait on the moderation write. */
  private timeout(channel: Channel, bot: ChannelBotConfig, username: string, seconds: number, kind: FilterKind): void {
    this.host
      .command({
        channel: channel.slug,
        userId: bot.botUserId,
        command: "timeout",
        args: [username, String(seconds), `channel bot: ${kind} filter`],
      })
      .then((codes) => {
        if (!codes.includes("cmd_success"))
          this.logger.warn("bot timeout refused", { channelId: channel.id, notice: codes.join(",") });
      })
      .catch((err: unknown) => this.logger.error("bot timeout failed", { ...errorFields(err), channelId: channel.id }));
  }

  // ── commands ───────────────────────────────────────────────────────────────

  async onMessage(ctx: MessageContext): Promise<void> {
    const bot = await this.state.config.get(ctx.channel.id);
    // The bot's own messages reach onMessage too (`say` skips only `process`): never count or answer them.
    if (!bot || ctx.user.id === bot.botUserId) return;
    const linesKey = KEYS.botLines(ctx.channel.id);
    await this.valkey.incr(linesKey);
    // Expires with the timer marks, so a channel that stops chatting leaves nothing behind.
    await this.valkey.expire(linesKey, TIMER_MARK_TTL_SECONDS);
    // Other bots never trigger commands, so two bots cannot answer each other in a loop.
    if (ctx.isAction || ctx.user.accountType === "bot") return;
    const bang = parseBang(ctx.body);
    if (!bang) return;
    const commands = await this.state.commands.get(ctx.channel.id);
    const resolved = resolveCommand(bang.name, commands.index);
    if (!resolved) return;
    if (resolved.kind === "builtin") return this.builtin(resolved.name, ctx, bot, bang.args, commands);
    return this.custom(resolved.command, ctx, bot, bang.args);
  }

  private async custom(cmd: CommandDef, ctx: MessageContext, bot: ChannelBotConfig, args: string[]): Promise<void> {
    const { channel, user, standing } = ctx;
    if (!meetsLevel(standing, cmd.userLevel)) return;
    const cooldown = KEYS.botCooldown(channel.id, cmd.name);
    let claimed = false;
    if (cmd.cooldownSeconds > 0 && !bypassesCooldown(standing)) {
      if ((await this.valkey.set(cooldown, "1", "EX", cmd.cooldownSeconds, "NX")) === null) return;
      claimed = true;
    }
    const release = async () => {
      if (claimed) await this.valkey.del(cooldown);
    };
    let count: number;
    let balance: number | null = null;
    try {
      if (cmd.costPoints > 0) {
        if (!bot.config.loyalty.enabled) return await release();
        ({ count, balance } = await this.spend(cmd, channel, ctx));
      } else {
        count = await this.bumpUseCount(cmd.id);
      }
    } catch (err) {
      await release();
      if (err instanceof CommandGone) return;
      if (!(err instanceof InsufficientPointsError)) throw err;
      const have = await pointsBalance(this.db, channel.id, user.id);
      const name = bot.config.loyalty.pointsName;
      return this.say(
        channel,
        bot,
        `@${user.displayName}, !${cmd.name} costs ${cmd.costPoints} ${name} and you have ${have}.`,
      );
    }
    const needs = templateNeeds(cmd.response);
    const vars: TemplateVars = {
      user: user.displayName,
      touser: toUser(args) ?? user.displayName,
      count,
      channel: channel.displayName,
      pointsName: bot.config.loyalty.pointsName,
      uptime: needs.uptime ? await this.uptime(channel) : undefined,
      points: needs.points ? (balance ?? (await pointsBalance(this.db, channel.id, user.id))) : undefined,
      variables: needs.variables ? await this.state.variables.get(channel.id) : undefined,
    };
    await this.say(channel, bot, renderTemplate(cmd.response, vars));
  }

  /** One transaction: use count, the ledger row (a SAVEPOINT refuses an overdraw) and its event. */
  private spend(cmd: CommandDef, channel: Channel, ctx: MessageContext): Promise<{ count: number; balance: number }> {
    const { user } = ctx;
    return this.db.transaction(async (tx) => {
      const t = schema.botCommands;
      const [row] = await tx
        .update(t)
        .set({ useCount: sql`${t.useCount} + 1` })
        .where(and(eq(t.id, cmd.id), eq(t.enabled, true)))
        .returning({ useCount: t.useCount });
      if (!row) throw new CommandGone();
      const { balance } = await postPointsInTx(tx, {
        channelId: channel.id,
        userId: user.id,
        delta: -cmd.costPoints,
        reason: "command",
        refId: cmd.id,
      });
      await emitEvent(
        tx,
        "channel.points.change",
        channel.id,
        pointsChangePayload(
          channel,
          { id: user.id, username: user.username, name: user.displayName },
          { delta: -cmd.costPoints, balance, reason: "command" },
        ),
      );
      return { count: row.useCount, balance };
    });
  }

  private async bumpUseCount(commandId: string): Promise<number> {
    const t = schema.botCommands;
    const [row] = await this.db
      .update(t)
      .set({ useCount: sql`${t.useCount} + 1` })
      .where(and(eq(t.id, commandId), eq(t.enabled, true)))
      .returning({ useCount: t.useCount });
    if (!row) throw new CommandGone();
    return row.useCount;
  }

  // ── built-ins ──────────────────────────────────────────────────────────────

  private async builtin(
    name: BuiltinCommand,
    ctx: MessageContext,
    bot: ChannelBotConfig,
    args: string[],
    commands: CommandSet,
  ): Promise<void> {
    const { channel, user, standing } = ctx;
    const { loyalty, songRequests } = bot.config;
    if (name === "points" && !loyalty.enabled) return;
    if (name === "sr" && !songRequests.enabled) return;
    // `!sr` has no plain cooldown: its queue limits bound it, and a refused link deserves an answer.
    // A refusal starts a per-user cooldown instead (see songRequest).
    if (name !== "sr" && !bypassesCooldown(standing)) {
      const key = KEYS.botCooldown(channel.id, `${name}:${user.id}`);
      if ((await this.valkey.set(key, "1", "EX", BUILTIN_COOLDOWN_SECONDS, "NX")) === null) return;
    }
    switch (name) {
      case "points": {
        const balance = await pointsBalance(this.db, channel.id, user.id);
        return this.say(channel, bot, `@${user.displayName}, you have ${balance} ${loyalty.pointsName}.`);
      }
      case "sr":
        return this.songRequest(ctx, bot, args[0]);
      case "commands":
        return this.say(channel, bot, commandList(commands, ctx, bot));
    }
  }

  private async songRequest(ctx: MessageContext, bot: ChannelBotConfig, raw: string | undefined): Promise<void> {
    const { channel, user, standing } = ctx;
    // After a refusal the requester waits a few seconds: repeated junk gets neither an answer nor a
    // queue transaction, so `!sr` cannot turn chat lines into bot lines one for one.
    const refusedKey = KEYS.botCooldown(channel.id, `sr-refused:${user.id}`);
    const exempt = bypassesCooldown(standing);
    if (!exempt && (await this.valkey.exists(refusedKey)) > 0) return;
    const refuse = async (text: string) => {
      if (!exempt) await this.valkey.set(refusedKey, "1", "EX", BUILTIN_COOLDOWN_SECONDS);
      return this.say(channel, bot, text);
    };
    const url = acceptSongUrl(raw);
    if (!url) return refuse(`@${user.displayName}, !sr takes a link: !sr https://…`);
    const result = await this.queueSong(channel.id, user.id, url, bot.config.songRequests.maxQueue);
    if (result.ok === true)
      return this.say(channel, bot, `@${user.displayName}, your request is number ${result.position} in the queue.`);
    return refuse(
      result.reason === "full"
        ? `@${user.displayName}, the song request queue is full.`
        : `@${user.displayName}, you already have ${MAX_QUEUED_PER_REQUESTER} songs in the queue.`,
    );
  }

  /** Count and insert under a per-channel lock, so two instances cannot overfill the queue. */
  private queueSong(
    channelId: string,
    userId: string,
    url: string,
    maxQueue: number,
  ): Promise<{ ok: true; position: number } | { ok: false; reason: "full" | "requester" }> {
    const t = schema.songRequests;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bot-sr:${channelId}`}, 0))`);
      const [counts] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          mine: sql<number>`(count(*) filter (where ${t.requesterId} = ${userId}))::int`,
        })
        .from(t)
        .where(and(eq(t.channelId, channelId), eq(t.status, "queued")));
      const total = counts?.total ?? 0;
      if (total >= maxQueue) return { ok: false, reason: "full" } as const;
      if ((counts?.mine ?? 0) >= MAX_QUEUED_PER_REQUESTER) return { ok: false, reason: "requester" } as const;
      await tx.insert(t).values({ id: uuidv7(), channelId, requesterId: userId, url });
      return { ok: true, position: total + 1 } as const;
    });
  }

  // ── timers ─────────────────────────────────────────────────────────────────

  /** One pass over this instance's hosted rooms whose bot is on and which are live. */
  async tickTimers(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const ids = new Set(this.host.hostedChannels().map((h) => h.id));
      this.state.retain(ids);
      if (ids.size === 0) return;
      const c = schema.channels;
      const b = schema.botConfigs;
      const live = await this.db
        .select({
          id: c.id,
          slug: c.slug,
          displayName: c.displayName,
          ownerId: c.ownerId,
          liveBroadcastId: c.liveBroadcastId,
        })
        .from(c)
        .innerJoin(b, eq(b.channelId, c.id))
        .where(
          and(
            inArray(c.id, [...ids]),
            eq(b.enabled, true),
            isNotNull(b.botUserId),
            isNotNull(c.liveBroadcastId),
            isNull(c.suspendedAt),
          ),
        );
      for (const channel of live)
        await this.tickChannel(channel).catch((err: unknown) =>
          this.logger.error("bot timer failed", { ...errorFields(err), channelId: channel.id }),
        );
    } finally {
      this.ticking = false;
    }
  }

  private async tickChannel(channel: Channel): Promise<void> {
    const bot = await this.state.config.get(channel.id);
    if (!bot) return;
    const timers = await this.state.timers.get(channel.id);
    if (timers.length === 0) return;
    const lines = Number((await this.valkey.get(KEYS.botLines(channel.id))) ?? 0);
    for (const timer of timers) await this.tickTimer(channel, bot, timer, lines);
  }

  private async tickTimer(channel: Channel, bot: ChannelBotConfig, timer: TimerDef, lines: number): Promise<void> {
    const markKey = KEYS.botTimerMark(timer.id);
    const mark = await this.valkey.get(markKey);
    if (mark === null) {
      // First sight of this timer: count lines from now.
      await this.valkey.set(markKey, String(lines), "EX", TIMER_MARK_TTL_SECONDS, "NX");
      return;
    }
    if (lines - Number(mark) < timer.minChatLines) return;
    if ((await this.valkey.set(KEYS.botTimerLock(timer.id), "1", "PX", TIMER_LOCK_MS, "NX")) === null) return;
    const t = schema.botTimers;
    // The database decides "due": only one instance's update matches, however stale its cache.
    const [claimed] = await this.db
      .update(t)
      .set({ lastFiredAt: sql`now()` })
      .where(
        and(
          eq(t.id, timer.id),
          eq(t.enabled, true),
          sql`(${t.lastFiredAt} is null or ${t.lastFiredAt} <= now() - make_interval(mins => ${t.intervalMinutes}))`,
        ),
      )
      .returning({ message: t.message });
    if (!claimed) return;
    const needs = templateNeeds(claimed.message);
    const body = renderTemplate(claimed.message, {
      channel: channel.displayName,
      pointsName: bot.config.loyalty.pointsName,
      uptime: needs.uptime ? await this.uptime(channel) : undefined,
      variables: needs.variables ? await this.state.variables.get(channel.id) : undefined,
    });
    await this.say(channel, bot, body);
    await this.valkey.set(markKey, String(lines), "EX", TIMER_MARK_TTL_SECONDS);
  }

  // ── speaking ───────────────────────────────────────────────────────────────

  private async say(channel: Channel, bot: ChannelBotConfig, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const r = await this.host.say({ channel: channel.slug, userId: bot.botUserId, body });
    if (r.notice === null || this.noticed.has(channel.id)) return;
    if (this.noticed.size >= NOTICED_MAX) this.noticed.clear();
    this.noticed.add(channel.id);
    this.logger.warn("channel bot message refused", { channelId: channel.id, notice: r.notice });
  }

  private async uptime(channel: Channel): Promise<string> {
    const id = channel.liveBroadcastId;
    if (!id) return "offline";
    let started = this.broadcastStarts.get(id);
    if (!started) {
      const t = schema.broadcasts;
      const [row] = await this.db
        .select({ startedAt: t.startedAt })
        .from(t)
        .where(and(eq(t.id, id), isNull(t.endedAt)))
        .limit(1);
      if (!row) return "offline";
      started = row.startedAt;
      if (this.broadcastStarts.size >= UPTIME_CACHE_MAX) this.broadcastStarts.clear();
      this.broadcastStarts.set(id, started);
    }
    return formatUptime(Date.now() - started.getTime());
  }
}

/** `!commands`: what the caller may use, built-ins included, cut to whole entries in one message. */
export function commandList(
  commands: CommandSet,
  ctx: Pick<MessageContext, "standing">,
  bot: ChannelBotConfig,
): string {
  // A command with a cost is silent while loyalty is off, so it is not offered either.
  const names = commands.list
    .filter((c) => meetsLevel(ctx.standing, c.userLevel) && (c.costPoints === 0 || bot.config.loyalty.enabled))
    .map((c) => `!${c.name}`);
  if (bot.config.loyalty.enabled) names.push("!points");
  if (bot.config.songRequests.enabled) names.push("!sr");
  names.push("!commands");
  let out = "Commands:";
  for (const n of names) {
    const next = `${out} ${n}`;
    if (next.length > CHAT_LIMITS.maxBodyLength) break;
    out = next;
  }
  return cutText(out, CHAT_LIMITS.maxBodyLength);
}
