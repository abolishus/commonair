// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `timeline-sync` steps 1, 3 and 4 (docs/testing/w1-selectors.md, "Scenarios"; ADR 0012
 * amendment 1):
 *
 * 1. Live media time: a signed-in API chat client's `mediaTs` hints are stored and fanned out
 *    clamped to [max(receive − 60 s, started_at), receive]; `dvr` stores null; a tmi.js line through
 *    the IRC gateway is placed at receive − the channel's median latency (`KEYS.chatLatency`, written
 *    once three gate-eligible sessions report one), else at receive time; an offline channel
 *    accepts the line with a null media time.
 * 2. (W1-player, `timeline-web.ts`.)
 * 3. Replay exclusions: on the step's own channel, seeded rows and real moderation calls (`/clear`,
 *    `/delete`, `/ban`, `/timeout`); a block (`me.blocks.add`, or a seeded `user_blocks` row while
 *    W1-calm-chat has not merged); `vods.chat` hides what decision 7 hides; a private VOD's replay is
 *    refused to a stranger; `clips.chat` returns the clip window.
 * 4. Retention: backdated rows on the step's own channel and the `chat-retention` ops tick.
 *
 * Steps that create named things use their own actors (never the run's shared streamer).
 */
import { RedisClient } from "bun";
import { KEYS } from "@commonair/contracts/internal";
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import type { ChatClient } from "../chat-client.ts";
import { valkeyUrl } from "../multi/replicas.ts";
import { apiError, isNotFound } from "../safety.ts";
import type { SignedInUser } from "../users.ts";
import type { Viewer } from "../viewer.ts";
import { sleep, waitFor } from "../wait.ts";
import type { W1Run } from "./kit.ts";

// ------------------------------------------------------------------ pure expectations

/** ADR 0012 amendment 1 decision 2: how far before receive time a line may be placed. */
export const MEDIA_TS_WINDOW_MS = 60_000;
/** Chat caches `KEYS.chatLatency` this long per channel. */
export const CHAT_LATENCY_CACHE_MS = 5_000;

export interface ClampCase {
  receivedAt: Date;
  hint: Date | null;
  playbackMode: "live" | "dvr";
  liveStartedAt: Date | null;
  /** `KEYS.chatLatency` in seconds (null = no key); used only without a hint. */
  latencySeconds: number | null;
}

/** What chat must store for a send (decisions 2 and 4), written independently of the service. */
export function expectedMediaTs(c: ClampCase): Date | null {
  if (c.playbackMode === "dvr" || c.liveStartedAt === null) return null;
  const r = c.receivedAt.getTime();
  const lower = Math.min(r, Math.max(r - MEDIA_TS_WINDOW_MS, c.liveStartedAt.getTime()));
  const latencyMs = c.latencySeconds !== null && c.latencySeconds > 0 ? c.latencySeconds * 1000 : 0;
  const wanted = c.hint ? c.hint.getTime() : r - latencyMs;
  return new Date(Math.min(r, Math.max(lower, wanted)));
}

/**
 * A hint-less line's placement (receive − stored media time, ms) matches one of the median values
 * chat could have used (sampled from Valkey around the send; `null` = no key = 0).
 */
export function latencyMatches(offsetMs: number, sampledSeconds: readonly (number | null)[]): boolean {
  return sampledSeconds.some((s) => {
    const want = Math.min(MEDIA_TS_WINDOW_MS, Math.max(0, Math.round((s ?? 0) * 1000)));
    return Math.abs(offsetMs - want) <= 1;
  });
}

/** One replay item as `vods.chat` / `clips.chat` returns it (the fields the steps read). */
export interface ReplayItemLike {
  id: string;
  at: string;
  mediaTs?: string | null;
  createdAt: string;
  catchingUp: boolean;
}

/** Items are in media-time order (`at`, then id), and `at` is the media time or, flagged, the receive time. */
/**
 * `at` as a sortable [milliseconds, sub-millisecond digits] pair: replay sends Postgres's
 * microseconds, and two rows in the same millisecond must still compare in order.
 */
export function atKey(iso: string): [number, number] {
  const frac = /\.(\d+)/.exec(iso)?.[1] ?? "";
  return [Date.parse(iso), Number(frac.slice(3, 6).padEnd(3, "0"))];
}

export function replayOrderProblems(items: readonly ReplayItemLike[]): string[] {
  const problems: string[] = [];
  items.forEach((it, i) => {
    const want = it.mediaTs ?? it.createdAt;
    if (Date.parse(it.at) !== Date.parse(want)) problems.push(`${it.id}: at ${it.at}, expected ${want}`);
    if (it.catchingUp !== (it.mediaTs === null || it.mediaTs === undefined))
      problems.push(`${it.id}: catchingUp ${it.catchingUp} with mediaTs ${String(it.mediaTs)}`);
    const prev = items[i - 1];
    if (!prev) return;
    const [a, au] = atKey(prev.at);
    const [b, bu] = atKey(it.at);
    const cmp = a - b || au - bu;
    if (cmp > 0 || (cmp === 0 && prev.id > it.id)) problems.push(`${prev.id} before ${it.id} out of order`);
  });
  return problems;
}

export interface RetentionRow {
  ageDays: number;
  /** The broadcast still has a VOD (not deleted, not removed). */
  vodAlive: boolean;
  /** The author is under an unreleased legal hold. */
  held: boolean;
}

/** Decision 6 for one row: deleted or kept by the `chat-retention` run. */
export function retentionDeletes(r: RetentionRow, cfg = { retentionDays: 30, maxDays: 60 }): boolean {
  if (r.held) return false;
  if (r.ageDays > cfg.maxDays) return true;
  return r.ageDays > cfg.retentionDays && !r.vodAlive;
}

// ------------------------------------------------------------------ shared helpers

const DAY_MS = 86_400_000;
const PERSIST_TIMEOUT_MS = 15_000;
const LATENCY_KEY_TIMEOUT_MS = 5 * 60_000;
const LIVE_TIMEOUT_MS = 30_000;

interface Stored {
  id: string;
  createdAt: Date;
  mediaTs: Date | null;
}

const marker = (what: string) => `w1t ${what} ${crypto.randomUUID().slice(0, 8)}`;

type Sql = DbHandle["sql"];

/**
 * Raw-client timestamps go both ways as ISO text: drizzle's postgres-js driver turns the shared
 * client's timestamp parsers and serializers off. Reads are cut to milliseconds in SQL (a float
 * epoch can land a hair under the millisecond); writes pass `toISOString()` cast to timestamptz.
 */
const isoMs = (sql: Sql, column: string) =>
  sql.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const msDate = (text: string | null): Date | null => (text === null ? null : new Date(text));
const handles = new WeakMap<W1Run, Sql>();

/** A raw SQL connection for reads and updates (inserts go through `run.db`); closed when the scenario ends. */
function rawSql(run: W1Run): Sql {
  let sql = handles.get(run);
  if (!sql) {
    const handle = createDb({ url: run.databaseUrl, max: 2, applicationName: "commonair-harness-w1-timeline" });
    run.ctx.defer(() => handle.close());
    sql = handle.sql;
    handles.set(run, sql);
  }
  return sql;
}

async function storedRow(sql: Sql, where: { id: string } | { body: string }, signal: AbortSignal): Promise<Stored> {
  return waitFor(
    `chat row ${"id" in where ? where.id : JSON.stringify(where.body)} persisted`,
    async () => {
      const rows = await sql<{ id: string; created_at: string; media_ts: string | null }[]>`
        select id, ${isoMs(sql, "created_at")} as created_at, ${isoMs(sql, "media_ts")} as media_ts
          from chat_messages
         where ${"id" in where ? sql`id = ${where.id}` : sql`body = ${where.body}`}
         limit 1`;
      const row = rows[0];
      return row ? { id: row.id, createdAt: new Date(row.created_at), mediaTs: msDate(row.media_ts) } : null;
    },
    { timeoutMs: PERSIST_TIMEOUT_MS, intervalMs: 100, signal },
  );
}

/** Send one line with an optional hint; the ack id, the fanned-out `mediaTs` and the stored row. */
async function sendHinted(
  run: W1Run,
  chat: ChatClient,
  channel: string,
  body: string,
  hint: { mediaTs?: string; playbackMode?: "live" | "dvr" },
): Promise<{ live: string | null; row: Stored }> {
  const nonce = `w1t${crypto.randomUUID().slice(0, 8)}`;
  const ack = chat.next("ack", (f) => f.nonce === nonce, 10_000);
  const fanned = chat.next("message", (f) => f.channel === channel && f.message.body === body, 10_000);
  ack.catch(() => undefined);
  fanned.catch(() => undefined);
  chat.raw({ op: "send", channel, body, nonce, isAction: false, ...hint });
  const a = await ack;
  if (!a.id) {
    const notice = chat.frames.findLast((f) => f.op === "notice");
    throw new Error(`"${body}" was refused: ${JSON.stringify(notice ?? null)}`);
  }
  const frame = await fanned;
  const row = await storedRow(rawSql(run), { id: a.id }, run.ctx.signal);
  return { live: frame.message.mediaTs ?? null, row };
}

async function liveStartedAt(sql: Sql, channelId: string): Promise<Date | null> {
  const rows = await sql<{ started_at: string }[]>`
    select ${isoMs(sql, "b.started_at")} as started_at
      from channels c join broadcasts b on b.id = c.live_broadcast_id where c.id = ${channelId}`;
  return msDate(rows[0]?.started_at ?? null);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Assert the stored and fanned-out media time equal the expectation (ms). */
function expectPlaced(run: W1Run, name: string, got: { live: string | null; row: Stored }, want: Date | null): void {
  run.ctx.assert(name, iso(got.row.mediaTs) === iso(want) && got.live === iso(want), {
    stored: iso(got.row.mediaTs),
    live: got.live,
    expected: iso(want),
    receivedAt: iso(got.row.createdAt),
  });
}

/** Read `KEYS.chatLatency` for the channel in the background, keeping every value seen. */
function sampleLatency(channelId: string, signal: AbortSignal) {
  const client = new RedisClient(valkeyUrl(process.env));
  const seen: { at: number; value: number | null }[] = [];
  let stopped = false;
  const read = async () => {
    const raw = await client.get(KEYS.chatLatency(channelId));
    const n = raw === null ? null : Number(raw);
    seen.push({ at: Date.now(), value: n !== null && Number.isFinite(n) ? n : null });
  };
  const loop = (async () => {
    await client.connect();
    while (!stopped && !signal.aborted) {
      await read().catch(() => undefined);
      await sleep(250, signal).catch(() => undefined);
    }
  })();
  return {
    /** Values seen since `sinceMs` (epoch ms). */
    since: (sinceMs: number) => seen.filter((s) => s.at >= sinceMs).map((s) => s.value),
    latest: () => seen.at(-1)?.value ?? null,
    async stop() {
      stopped = true;
      await loop.catch(() => undefined);
      client.close();
    },
  };
}

// ------------------------------------------------------------------ step 1

export async function stepLiveMediaTime(run: W1Run): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const [sender, offlineOwner, botOwner] = run.viewers;
  if (!sender || !offlineOwner || !botOwner) throw new Error("timeline-sync step 1 needs three signed-in viewers");
  const channel = run.streamer.channel;
  const startedAt = await ctx.step("live broadcast start (database)", async () => {
    const s = await liveStartedAt(rawSql(run), run.streamer.channelId);
    if (!s) throw new Error(`${channel} has no live broadcast`);
    return s;
  });

  const chat = await ctx.step("sender: chat socket joins the live channel", async () => {
    const c = await p.chat(sender);
    ctx.defer(() => c.close());
    await c.join(channel);
    return c;
  });

  const clamp = (receivedAt: Date, hint: Date | null, mode: "live" | "dvr") =>
    expectedMediaTs({ receivedAt, hint, playbackMode: mode, liveStartedAt: startedAt, latencySeconds: null });

  await ctx.step("hint 5 s back is kept", async () => {
    // A hint before `started_at` is clamped up to it (decision 2): when this scenario runs first in
    // its shard the broadcast is only seconds old, so wait until 5 s back is inside the broadcast.
    await sleep(Math.max(0, startedAt.getTime() + 6_000 - Date.now()), ctx.signal);
    const hint = new Date(Date.now() - 5_000);
    const got = await sendHinted(run, chat, channel, marker("minus5"), { mediaTs: hint.toISOString() });
    expectPlaced(run, "now − 5 s: stored and live mediaTs", got, clamp(got.row.createdAt, hint, "live"));
    ctx.check("now − 5 s: inside the window (not clamped)", iso(got.row.mediaTs) === hint.toISOString(), {
      receivedAt: iso(got.row.createdAt),
    });
  });

  await ctx.step("hint 10 s ahead is receive time", async () => {
    const got = await sendHinted(run, chat, channel, marker("plus10"), {
      mediaTs: new Date(Date.now() + 10_000).toISOString(),
    });
    expectPlaced(run, "now + 10 s: receive time", got, got.row.createdAt);
  });

  await ctx.step("hint 120 s back is receive − 60 s", async () => {
    const hint = new Date(Date.now() - 120_000);
    const got = await sendHinted(run, chat, channel, marker("minus120"), { mediaTs: hint.toISOString() });
    expectPlaced(run, "now − 120 s: receive − 60 s", got, clamp(got.row.createdAt, hint, "live"));
  });

  await ctx.step("dvr mode stores null", async () => {
    const got = await sendHinted(run, chat, channel, marker("dvr"), {
      mediaTs: new Date(Date.now() - 5_000).toISOString(),
      playbackMode: "dvr",
    });
    expectPlaced(run, "playbackMode dvr: null", got, null);
  });

  await ctx.step("offline channel: accepted, null media time", async () => {
    const offline = offlineOwner.me.channelSlug ?? offlineOwner.username;
    await chat.join(offline);
    const got = await sendHinted(run, chat, offline, marker("offline"), {
      mediaTs: new Date(Date.now() - 5_000).toISOString(),
    });
    expectPlaced(run, "offline channel: null", got, null);
  });

  await stepStartedAtBound(run, sender);
  await stepIrcMedian(run, botOwner, startedAt);
}

/** A broadcast younger than the window: a hint before it starts is raised to `started_at`. */
async function stepStartedAtBound(run: W1Run, sender: SignedInUser): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const owner = await ctx.step("own streamer: sign up", () => p.signUp({ prefix: "w1tsa" }));
  const channel = owner.me.channelSlug ?? owner.username;
  const info = await owner.api.client.channels.get({ channel });
  const encoder = await p.streamerFor(owner, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
  ctx.defer(() => encoder.stop());
  await ctx.step("own streamer: goes live", async () => {
    await encoder.start();
    await p.waitForLive(channel, true, LIVE_TIMEOUT_MS);
  });
  try {
    const startedAt = await ctx.step("own streamer: broadcast start", async () => {
      const s = await liveStartedAt(rawSql(run), info.id);
      if (!s) throw new Error(`${channel} has no live broadcast`);
      return s;
    });
    const chat = await p.chat(sender);
    ctx.defer(() => chat.close());
    await chat.join(channel);
    await ctx.step("hint before started_at is started_at", async () => {
      const got = await sendHinted(run, chat, channel, marker("prestart"), {
        mediaTs: new Date(startedAt.getTime() - 30_000).toISOString(),
      });
      const young = got.row.createdAt.getTime() - startedAt.getTime() < MEDIA_TS_WINDOW_MS;
      ctx.check("broadcast younger than the 60 s window when the line arrived", young, {
        startedAt: iso(startedAt),
        receivedAt: iso(got.row.createdAt),
      });
      const want = expectedMediaTs({
        receivedAt: got.row.createdAt,
        hint: new Date(startedAt.getTime() - 30_000),
        playbackMode: "live",
        liveStartedAt: startedAt,
        latencySeconds: null,
      });
      expectPlaced(run, "before started_at: started_at", got, want);
      if (young) ctx.assert("before started_at: exactly started_at", iso(got.row.mediaTs) === iso(startedAt));
    });
  } finally {
    await encoder.stop();
  }
}

/** tmi.js through the IRC gateway: receive time without a median, receive − median with one. */
async function stepIrcMedian(run: W1Run, botOwner: SignedInUser, startedAt: Date): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const channel = run.streamer.channel;
  const account = await ctx.step("tmi.js bot account", () => p.createBot(botOwner, "w1tbot"));
  const bot = p.tmiBot(account, [channel]);
  ctx.defer(() => bot.disconnect());
  await ctx.step("tmi.js bot joins through the IRC gateway", async () => {
    await bot.connect();
    await bot.events.waitForJoin(channel, { signal: ctx.signal });
  });
  const sampler = sampleLatency(run.streamer.channelId, ctx.signal);
  ctx.defer(() => sampler.stop());

  /** Send through IRC and check the placement against the median values chat could have used. */
  const ircLine = async (what: string): Promise<{ offsetMs: number; sampled: (number | null)[] }> => {
    // Chat may serve a value cached up to CHAT_LATENCY_CACHE_MS before the send.
    const since = Date.now() - CHAT_LATENCY_CACHE_MS - 1_000;
    const body = marker(what);
    await bot.say(channel, body);
    const row = await storedRow(rawSql(run), { body }, ctx.signal);
    const sampled = sampler.since(since);
    if (row.mediaTs === null) throw new Error(`IRC line ${body} stored without a media time on a live channel`);
    const lower = Math.max(row.createdAt.getTime() - MEDIA_TS_WINDOW_MS, startedAt.getTime());
    ctx.assert(
      `IRC ${what}: inside [max(receive − 60 s, started_at), receive]`,
      row.mediaTs.getTime() >= lower && row.mediaTs <= row.createdAt,
    );
    return { offsetMs: row.createdAt.getTime() - row.mediaTs.getTime(), sampled };
  };

  await sleep(1_500, ctx.signal);
  if (sampler.latest() === null) {
    await ctx.step("IRC line without a channel median: receive time", async () => {
      const r = await ircLine("no-median");
      ctx.assert("IRC without a median: receive time", latencyMatches(r.offsetMs, r.sampled), r);
    });
  } else {
    ctx.skipStep(
      "IRC line without a channel median",
      "the channel already has a median (verified viewers report latency)",
    );
  }

  const viewers: Viewer[] = await ctx.step("three HTTP viewers report latency", () =>
    p.openViewers(channel, { http: 3 }),
  );
  for (const v of viewers) ctx.defer(() => v.stop());
  await ctx.step("the worker writes the channel median (≥ 3 gate-eligible sessions)", () =>
    waitFor("KEYS.chatLatency written", () => sampler.latest() !== null, {
      timeoutMs: LATENCY_KEY_TIMEOUT_MS,
      intervalMs: 1_000,
      signal: ctx.signal,
    }),
  );
  // Past the chat service's cache, so the next line reads the key.
  await sleep(CHAT_LATENCY_CACHE_MS + 1_000, ctx.signal);
  await ctx.step("IRC line with a channel median: receive − median", async () => {
    const r = await ircLine("median");
    ctx.data("w1.timeline.ircMedian", r);
    ctx.assert("IRC with a median: receive − the channel median", latencyMatches(r.offsetMs, r.sampled), r);
  });
}

// ------------------------------------------------------------------ step 3

interface Seed {
  id: string;
  body: string;
}

export async function stepReplayExclusions(run: W1Run): Promise<void> {
  const { ctx, db } = run;
  const sql = rawSql(run);
  const p = ctx.platform;
  const [plain, bannedUser, blockedUser] = run.viewers;
  if (!plain || !bannedUser || !blockedUser) throw new Error("timeline-sync step 3 needs three signed-in viewers");
  const [owner, timedOut, stranger] = await ctx.step("own streamer, a chatter to time out, a stranger", () =>
    Promise.all([p.signUp({ prefix: "w1trx" }), p.signUp({ prefix: "w1trt" }), p.signUp({ prefix: "w1trs" })]),
  );
  const channel = owner.me.channelSlug ?? owner.username;
  const channelId = (await owner.api.client.channels.get({ channel })).id;

  // A finished broadcast with a ready, public VOD, seeded; its end is set once moderation is done
  // (in the future until then, so the moderation lands inside its span).
  const startedAt = new Date(Date.now() - 10 * 60_000);
  const at = (sec: number) => new Date(startedAt.getTime() + sec * 1000);
  const broadcastId = uuidv7();
  const vodId = uuidv7();
  await ctx.step("seed a broadcast and its VOD", async () => {
    await db.insert(schema.broadcasts).values({
      id: broadcastId,
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${channel}`,
      startedAt,
      endedAt: new Date(Date.now() + 10 * 60_000),
    });
    await db.insert(schema.vods).values({
      id: vodId,
      channelId,
      broadcastId,
      title: "timeline-sync replay",
      status: "ready",
      visibility: "public",
      storagePrefix: `vods/${vodId}/`,
      durationSeconds: 600,
    });
  });

  const seed = async (
    userId: string,
    what: string,
    createdAt: Date,
    mediaTs: Date | null,
    extra: Partial<typeof schema.chatMessages.$inferInsert> = {},
  ): Promise<Seed> => {
    const id = uuidv7();
    const body = marker(what);
    await db
      .insert(schema.chatMessages)
      .values({ id, channelId, broadcastId, userId, body, createdAt, mediaTs, ...extra });
    return { id, body };
  };

  const mod = await p.chat(owner);
  ctx.defer(() => mod.close());
  await mod.join(channel);
  const command = async (name: string, args: string[]) => {
    const notice = await mod.command(channel, name, args);
    ctx.check(`/${name} accepted`, notice.code === "cmd_success", notice);
  };

  // Before the clear: hidden from everyone.
  const beforeClear = await seed(plain.id, "before-clear", new Date(Date.now() - 120_000), at(100));
  await ctx.step("/clear (real moderation)", () => command("clear", []));
  const clearedAt = await ctx.step("the clear is recorded", () =>
    waitFor(
      "clear_chat mod action",
      async () => {
        const rows = await sql<{ created_at: string }[]>`
          select ${isoMs(sql, "created_at")} as created_at from mod_actions
           where channel_id = ${channelId} and action = 'clear_chat'
           order by mod_actions.created_at limit 1`;
        return msDate(rows[0]?.created_at ?? null);
      },
      { timeoutMs: 10_000, intervalMs: 200, signal: ctx.signal },
    ),
  );
  const after = (ms: number) => new Date(clearedAt.getTime() + ms);

  const kept = await seed(plain.id, "kept", after(1_000), at(300));
  const held = await seed(plain.id, "held", after(1_100), at(305), { heldAt: after(1_100) });
  const deleted = await seed(plain.id, "deleted", after(1_200), at(310));
  const blocked = await seed(blockedUser.id, "blocked", after(1_300), at(320));
  const bannedBefore = await seed(bannedUser.id, "banned-before", after(1_400), at(330));
  const timedBefore = await seed(timedOut.id, "timed-before", after(1_500), at(340));
  // Received while catching up (no media time): placed at its receive time.
  const catchingUp = await seed(plain.id, "catching-up", after(1_600), null);

  await ctx.step("/delete, /ban, /timeout (real moderation)", async () => {
    // The moderators' lines are written after these rows exist.
    await sleep(Math.max(0, after(2_000).getTime() - Date.now()), ctx.signal);
    await command("delete", [deleted.id]);
    await command("ban", [bannedUser.username, "timeline-sync"]);
    await command("timeout", [timedOut.username, "1", "timeline-sync"]);
    await waitFor(
      "the delete and both bans recorded",
      async () => {
        const [d] = await sql<{ deleted_at: Date | null }[]>`
          select deleted_at from chat_messages where id = ${deleted.id}`;
        const bans = await sql<{ id: string }[]>`
          select id from chat_bans
           where channel_id = ${channelId} and user_id = any(${[bannedUser.id, timedOut.id]}::uuid[])`;
        return d?.deleted_at && bans.length >= 2 ? true : null;
      },
      { timeoutMs: 10_000, intervalMs: 200, signal: ctx.signal },
    );
  });
  const [lastBan] = await sql<{ at: string | null }[]>`
    select ${isoMs(sql, "max(created_at)")} as at from chat_bans where channel_id = ${channelId}`;
  const banAt = msDate(lastBan?.at ?? null) ?? new Date();
  // After the timeout ran out: shown.
  const timedAfter = await seed(timedOut.id, "timed-after", new Date(banAt.getTime() + 2_000), at(400));
  await sql`update broadcasts set ended_at = ${new Date(banAt.getTime() + 5_000).toISOString()}::timestamptz
             where id = ${broadcastId}`;

  const blockVia = await ctx.step("the stranger blocks a chatter", async () => {
    try {
      await stranger.api.client.me.blocks.add({ username: blockedUser.username });
      ctx.defer(() => stranger.api.client.me.blocks.remove({ username: blockedUser.username }).catch(() => undefined));
      return "me.blocks.add";
    } catch (err) {
      // W1-calm-chat not merged yet: the procedure is a 501 stub; seed the row it would write.
      if (apiError(err).code !== "NOT_IMPLEMENTED") throw err;
      await db.insert(schema.userBlocks).values({ userId: stranger.id, blockedUserId: blockedUser.id });
      ctx.defer(
        () => sql`delete from user_blocks where user_id = ${stranger.id} and blocked_user_id = ${blockedUser.id}`,
      );
      return "seeded user_blocks row";
    }
  });
  ctx.data("w1.timeline.blockVia", blockVia);

  const replay = async (who: SignedInUser | null, kind: "vods" | "clips", id: string) => {
    const client = (who?.api ?? p.api()).client;
    const items: (ReplayItemLike & { body: string })[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r =
        kind === "vods"
          ? await client.vods.chat({ id, cursor, limit: 2 })
          : await client.clips.chat({ id, cursor, limit: 2 });
      items.push(...r.items);
      if (!r.nextCursor) return { items, retained: r.retained };
      cursor = r.nextCursor;
    }
    throw new Error("replay did not end within 20 pages");
  };

  const visibleToAll = [kept, blocked, timedAfter, catchingUp].map((s) => s.id);
  const hiddenFromAll = [beforeClear, held, deleted, bannedBefore, timedBefore].map((s) => s.id);
  await ctx.step("vods.chat: exclusions (anonymous)", async () => {
    const r = await replay(null, "vods", vodId);
    const ids = r.items.map((i) => i.id);
    ctx.assert("anonymous replay shows exactly the surviving lines", sameSet(ids, visibleToAll), { ids, visibleToAll });
    for (const h of hiddenFromAll) ctx.assert(`hidden: ${labelOf(h)}`, !ids.includes(h));
    ctx.assert(
      "media-time order, catching-up line at receive time",
      replayOrderProblems(r.items).length === 0,
      replayOrderProblems(r.items),
    );
    ctx.assert("the catching-up line is flagged", r.items.find((i) => i.id === catchingUp.id)?.catchingUp === true);
    ctx.assert("retained", r.retained);
  });
  await ctx.step("vods.chat: the blocker does not see the blocked user", async () => {
    const ids = (await replay(stranger, "vods", vodId)).items.map((i) => i.id);
    ctx.assert(
      "the blocker's replay leaves the blocked user out",
      sameSet(
        ids,
        visibleToAll.filter((id) => id !== blocked.id),
      ),
      { ids },
    );
  });

  await ctx.step("clips.chat: the clip window", async () => {
    const clipId = uuidv7();
    // 290 s to 330 s from the broadcast start: `kept` (300) and `blocked` (320) only; 330 is the
    // banned line, hidden.
    await db.insert(schema.clips).values({
      id: clipId,
      channelId,
      broadcastId,
      vodId,
      creatorId: owner.id,
      title: "timeline-sync clip",
      startOffset: 290,
      durationSeconds: 40,
      status: "ready",
    });
    const ids = (await replay(null, "clips", clipId)).items.map((i) => i.id);
    ctx.assert("clips.chat returns the clip window", JSON.stringify(ids) === JSON.stringify([kept.id, blocked.id]), {
      ids,
    });
  });

  await ctx.step("a private VOD's replay is refused to a stranger", async () => {
    await sql`update vods set visibility = 'private' where id = ${vodId}`;
    const err = await stranger.api.client.vods
      .chat({ id: vodId, limit: 10 })
      .then(() => null)
      .catch((e: unknown) => e);
    ctx.assert("stranger: NOT_FOUND", err !== null && isNotFound(err), { code: apiError(err).code });
    const own = await owner.api.client.vods.chat({ id: vodId, limit: 10 });
    ctx.assert("the owner still gets it", own.items.length > 0);
  });

  function labelOf(id: string): string {
    const all: Record<string, Seed> = { beforeClear, held, deleted, bannedBefore, timedBefore };
    return Object.entries(all).find(([, s]) => s.id === id)?.[0] ?? id;
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

// ------------------------------------------------------------------ step 4

export async function stepRetention(run: W1Run): Promise<void> {
  const { ctx, db } = run;
  const sql = rawSql(run);
  const p = ctx.platform;
  const [owner, heldAuthor] = await ctx.step("own streamer and an author under a legal hold", () =>
    Promise.all([p.signUp({ prefix: "w1tret" }), p.signUp({ prefix: "w1treh" })]),
  );
  const [author] = run.viewers;
  if (!author) throw new Error("timeline-sync step 4 needs a signed-in viewer");
  const channel = owner.me.channelSlug ?? owner.username;
  const channelId = (await owner.api.client.channels.get({ channel })).id;
  const ago = (days: number) => new Date(Date.now() - days * DAY_MS);

  // Two broadcasts 61 and 45 days ago with a VOD that still exists, one 35 days ago without.
  const broadcast = async (days: number, withVod: boolean) => {
    const id = uuidv7();
    await db.insert(schema.broadcasts).values({
      id,
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${channel}`,
      startedAt: ago(days),
      endedAt: new Date(ago(days).getTime() + 60 * 60_000),
    });
    if (withVod) {
      const vodId = uuidv7();
      await db.insert(schema.vods).values({
        id: vodId,
        channelId,
        broadcastId: id,
        title: "timeline-sync retention",
        status: "ready",
        storagePrefix: `vods/${vodId}/`,
        expiresAt: new Date(Date.now() + DAY_MS),
      });
    }
    return id;
  };

  interface Case extends RetentionRow {
    id: string;
    name: string;
  }
  const cases: Case[] = await ctx.step("seed backdated chat rows", async () => {
    const b61 = await broadcast(61, true);
    const b45 = await broadcast(45, true);
    const b35 = await broadcast(35, false);
    const rows: Omit<Case, "id">[] = [
      { name: "offline, 31 days", ageDays: 31, vodAlive: false, held: false },
      { name: "offline, 29 days", ageDays: 29, vodAlive: false, held: false },
      { name: "no VOD, 34 days", ageDays: 34, vodAlive: false, held: false },
      { name: "VOD alive, 44 days", ageDays: 44, vodAlive: true, held: false },
      { name: "VOD alive, 60.5 days", ageDays: 60.5, vodAlive: true, held: false },
      { name: "legal hold, offline, 31 days", ageDays: 31, vodAlive: false, held: true },
    ];
    const broadcastOf = (r: Omit<Case, "id">) =>
      r.name.startsWith("VOD alive, 60")
        ? b61
        : r.name.startsWith("VOD alive")
          ? b45
          : r.name.startsWith("no VOD")
            ? b35
            : null;
    const out: Case[] = [];
    for (const r of rows) {
      const id = uuidv7();
      await db.insert(schema.chatMessages).values({
        id,
        channelId,
        broadcastId: broadcastOf(r),
        userId: r.held ? heldAuthor.id : author.id,
        body: marker(`retention ${r.name}`),
        createdAt: ago(r.ageDays),
      });
      out.push({ ...r, id });
    }
    return out;
  });

  await ctx.step("place a legal hold on one author", async () => {
    const [hold] = await db
      .insert(schema.legalHolds)
      .values({ userId: heldAuthor.id, reasonCode: "law_enforcement", reason: "harness timeline-sync retention" })
      .returning({ id: schema.legalHolds.id });
    // Released when the scenario ends (the trigger wants a release reason).
    if (hold)
      ctx.defer(
        () => sql`update legal_holds set released_at = now(), release_reason = 'harness cleanup'
                   where id = ${hold.id} and released_at is null`,
      );
  });

  const result = await ctx.step("chat-retention ops tick", () => run.hooks.client.tickRan("chat-retention"));
  ctx.data("w1.timeline.retention", result);
  const left = new Set(
    (await sql<{ id: string }[]>`select id from chat_messages where id = any(${cases.map((c) => c.id)}::uuid[])`).map(
      (r) => r.id,
    ),
  );
  for (const c of cases) {
    const deletes = retentionDeletes(c);
    ctx.assert(`${c.name}: ${deletes ? "deleted" : "kept"}`, left.has(c.id) !== deletes);
  }
  // Soft: the hourly schedule may have run between seeding and the tick.
  ctx.check("the run counts the held row", (result.held ?? 0) >= 1, result);
  ctx.check(
    "the run counts its deletions",
    (result.deleted ?? 0) >= cases.filter((c) => retentionDeletes(c)).length,
    result,
  );
}
