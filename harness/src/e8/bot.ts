// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channel-bot` steps 1, 2, 3 and 5 (commands, points cost, timer, song requests)
 * (docs/testing/e8-selectors.md, "Scenarios"). Set up through the API (`bot.updateSettings`,
 * `bot.commands.upsert`, `bot.timers.upsert`, `bot.songRequests.*`, `bot.points.adjust`) and
 * observed in chat: every reply must come from the channel's bot account.
 */
import type { ServerFrame } from "@commonair/contracts";
import type { BotConfig } from "@commonair/contracts/shapes";
import type { ChatClient } from "../chat-client.ts";
import { FixturePublisher } from "../safety-io.ts";
import { benignPatternSource, runSeed } from "../safety.ts";
import { rtmpPublishUrl } from "../streamer.ts";
import type { SignedInUser } from "../users.ts";
import { sleep, waitFor } from "../wait.ts";
import { botTitle } from "./steps.ts";
import { API_SETTLE_MS, type E8Run, waitLive } from "./kit.ts";

type MessageFrame = Extract<ServerFrame, { op: "message" }>;

/** How long a bot reply may take (the API's control message, then one chat round trip). */
export const REPLY_TIMEOUT_MS = 15_000;
/** How long the step watches for a reply that must not come. */
export const SILENCE_MS = 4_000;
/** The engine checks timers every 15 s: a timer posts within one interval plus a tick. */
export const TIMER_TICK_MS = 15_000;

/**
 * The config the steps run with: filters off (so a step's own messages are never dropped), points
 * on, song requests on. The API refuses nothing here; every field is the contract's shape.
 */
export function harnessBotConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    displayName: "HarnessBot",
    filters: {
      spam: { enabled: false, maxRepeatedChars: 12 },
      links: { enabled: false, allowSubscribers: true, allowlist: [] },
      caps: { enabled: false, minLength: 15, maxRatio: 0.7 },
      timeoutSeconds: 0,
    },
    loyalty: { enabled: true, pointsName: "points" },
    songRequests: { enabled: true, maxQueue: 25 },
    ...over,
  };
}

/** A chat message from the bot account, optionally with a body test. */
export function isBotMessage(f: ServerFrame, botUserId: string, body?: (text: string) => boolean): f is MessageFrame {
  return f.op === "message" && f.message.user.id === botUserId && (body === undefined || body(f.message.body));
}

/** A unique song link per run, so reruns on the same stack never see each other's rows. */
export const songUrl = (runId: string): string => `https://example.org/song/${encodeURIComponent(runId)}`;

interface BotHandle {
  botUserId: string;
  botUsername: string;
}

/** Turn the bot on with `config`; returns its account (created the first time). */
async function enableBot(run: E8Run, config: BotConfig): Promise<BotHandle> {
  const s = run.streamer;
  const settings = await s.user.api.client.bot.updateSettings({ channel: s.channel, enabled: true, config });
  if (!settings.enabled || settings.botUser === null) throw new Error("bot.updateSettings did not enable the bot");
  return { botUserId: settings.botUser.id, botUsername: settings.botUser.username };
}

async function chatFor(run: E8Run, user: SignedInUser): Promise<ChatClient> {
  const chat = await run.ctx.platform.chat(user);
  run.ctx.defer(() => chat.close());
  await chat.join(run.streamer.channel);
  return chat;
}

/** Send and require the message itself to be accepted (a refused `!` message proves nothing). */
async function sendAccepted(run: E8Run, chat: ChatClient, body: string): Promise<void> {
  const ack = await chat.send(run.streamer.channel, body);
  run.ctx.assert(`chat accepted "${body}"`, ack.id !== null, ack);
}

/** Send and wait for the bot's reply matching `body`. */
async function expectReply(
  run: E8Run,
  chat: ChatClient,
  bot: BotHandle,
  send: string,
  body: (text: string) => boolean,
): Promise<MessageFrame> {
  const reply = chat.next("message", (f) => isBotMessage(f, bot.botUserId, body), REPLY_TIMEOUT_MS);
  reply.catch(() => undefined);
  await sendAccepted(run, chat, send);
  return reply;
}

/** Send, watch for `ms`, and return every bot message seen meanwhile. */
async function botMessagesAfter(
  run: E8Run,
  chat: ChatClient,
  bot: BotHandle,
  send: string | null,
  ms: number,
): Promise<string[]> {
  const seen: string[] = [];
  const off = chat.onFrame((f) => {
    if (isBotMessage(f, bot.botUserId)) seen.push(f.message.body);
  });
  try {
    if (send !== null) await sendAccepted(run, chat, send);
    await sleep(ms, run.ctx.signal);
  } finally {
    off();
  }
  return seen;
}

// ---------------------------------------------------------------- step 1

export async function stepCommands(run: E8Run): Promise<void> {
  const { ctx, streamer: s } = run;
  const t = (w: string) => botTitle(1, w);
  const [v0, v1, v2] = viewers(run);
  const bot = await ctx.step(t("streamer enables the bot"), () => enableBot(run, harnessBotConfig()));
  ctx.data("botUser", bot);
  const api = s.user.api.client.bot.commands;
  await ctx.step(t("add !hello (cooldown 30 s) and a moderator-level !modcheck"), async () => {
    await api.upsert({
      channel: s.channel,
      name: "hello",
      aliases: [],
      response: "Hi ${user}!",
      userLevel: "everyone",
      cooldownSeconds: 30,
      costPoints: 0,
      enabled: true,
    });
    await api.upsert({
      channel: s.channel,
      name: "modcheck",
      aliases: [],
      response: "moderators only",
      userLevel: "moderator",
      cooldownSeconds: 0,
      costPoints: 0,
      enabled: true,
    });
  });
  const [c0, c1, c2] = await ctx.step(
    t("three viewers join chat"),
    async () => [await chatFor(run, v0), await chatFor(run, v1), await chatFor(run, v2)] as const,
  );

  const reply = await ctx.step(t("a viewer's !hello gets one reply from the bot account"), () =>
    expectReply(run, c0, bot, "!hello", (b) => b.startsWith("Hi ")),
  );
  // The name chat shows for the viewer (its own welcome frame), which is what `${user}` renders.
  const shown = c0.welcome?.user?.displayName ?? v0.displayName;
  ctx.assert("reply names the caller", reply.message.body === `Hi ${shown}!`, reply.message.body);
  ctx.assert("reply is from a bot account", reply.message.user.accountType === "bot", reply.message.user);
  const extra = await botMessagesAfter(run, c0, bot, null, SILENCE_MS);
  ctx.assert("exactly one reply", extra.filter((b) => b.startsWith("Hi ")).length === 0, extra);

  const cooled = await ctx.step(t("a second !hello inside the cooldown gets none"), () =>
    botMessagesAfter(run, c1, bot, "!hello", SILENCE_MS),
  );
  ctx.assert("no reply inside the cooldown", !cooled.some((b) => b.startsWith("Hi ")), cooled);

  const denied = await ctx.step(t("a viewer's moderator-level command gets none"), () =>
    botMessagesAfter(run, c2, bot, "!modcheck", SILENCE_MS),
  );
  ctx.assert("no reply below the command's level", !denied.includes("moderators only"), denied);
}

// ---------------------------------------------------------------- step 2

export async function stepPointsCost(run: E8Run): Promise<void> {
  const { ctx, streamer: s } = run;
  const t = (w: string) => botTitle(2, w);
  const v = viewers(run)[2];
  const bot = await ctx.step(t("streamer enables the bot with points on"), () => enableBot(run, harnessBotConfig()));
  const hug = await ctx.step(t("add !hug costing 50"), () =>
    s.user.api.client.bot.commands.upsert({
      channel: s.channel,
      name: "hug",
      aliases: [],
      response: "${user} hugs ${touser}",
      userLevel: "everyone",
      cooldownSeconds: 0,
      costPoints: 50,
      enabled: true,
    }),
  );
  const balance = async () =>
    (await s.user.api.client.bot.points.balance({ channel: s.channel, username: v.username })).points;
  const before = await ctx.step(t("the viewer starts with no points"), balance);
  ctx.assert("viewer has 0 points", before === 0, { before });
  const chat = await chatFor(run, v);

  const refused = await ctx.step(t("!hug without points: the bot says they lack points"), () =>
    expectReply(run, chat, bot, "!hug", (b) => b.includes("costs 50")),
  );
  ctx.data("refusal", refused.message.body);
  ctx.assert("nothing debited", (await balance()) === 0);

  await ctx.step(t("streamer rewards the viewer 100 points"), () =>
    s.user.api.client.bot.points.adjust({ channel: s.channel, username: v.username, delta: 100, reason: "reward" }),
  );
  const answered = await ctx.step(t("!hug with points answers"), () =>
    expectReply(run, chat, bot, `!hug @${s.channel}`, (b) => b.includes("hugs")),
  );
  ctx.assert("reply hugs the target", answered.message.body.endsWith(`hugs ${s.channel}`), answered.message.body);
  const after = await ctx.step(t("balance is 50"), () =>
    waitFor("balance 50", async () => ((await balance()) === 50 ? 50 : null), {
      timeoutMs: API_SETTLE_MS,
      intervalMs: 250,
      signal: ctx.signal,
    }),
  );
  ctx.assert("balance after the spend", after === 50, { after });

  const event = await ctx.step(t("outbox: channel.points.change with reason command"), () =>
    waitFor(
      "channel.points.change (command)",
      async () => {
        const rows = await run.db.query.events.findMany({
          columns: { payload: true },
          where: (e, { and, eq, sql }) =>
            and(
              eq(e.channelId, s.channelId),
              eq(e.type, "channel.points.change"),
              sql`${e.payload}->>'user_id' = ${v.id}`,
              sql`${e.payload}->>'reason' = 'command'`,
            ),
        });
        return rows.length > 0 ? rows : null;
      },
      { timeoutMs: API_SETTLE_MS, intervalMs: 500, signal: ctx.signal },
    ),
  );
  ctx.assert("one command spend event", event.length === 1, event);
  ctx.assert(
    "event delta and balance",
    event[0]?.payload.delta === -50 && event[0]?.payload.balance === 50,
    event[0]?.payload,
  );
  ctx.data("hugCommandId", hug.id);
}

// ---------------------------------------------------------------- step 3

export async function stepTimer(run: E8Run): Promise<void> {
  const { ctx, streamer: s } = run;
  const t = (w: string) => botTitle(3, w);
  const [v0, v1] = viewers(run);
  const bot = await ctx.step(t("streamer enables the bot"), () => enableBot(run, harnessBotConfig()));
  const timer = await ctx.step(t("add a timer every minute after 3 chat lines"), () =>
    s.user.api.client.bot.timers.upsert({
      channel: s.channel,
      name: `follow-${ctx.runId}`.slice(0, 50),
      message: "Follow ${channel}! (timer)",
      intervalMinutes: 1,
      minChatLines: 3,
      enabled: true,
    }),
  );
  ctx.data("timerId", timer.id);

  const { key } = await s.user.api.client.stream.rotateKey({ channel: s.channel });
  const pub = new FixturePublisher(
    `publisher-${s.channel}`,
    {
      url: rtmpPublishUrl(ctx.env.HARNESS_RTMP_URL, key),
      lavfi: benignPatternSource((runSeed(ctx.runId) + 3) & 0x7fffffff),
    },
    ctx.log,
  );
  ctx.defer(() => pub.stop(1_000));
  await ctx.step(t("streamer goes live"), () => pub.start());
  await ctx.step(t("channel is live"), () => waitLive(ctx, s.channel));
  const [c0, c1] = await ctx.step(
    t("two viewers join chat"),
    async () => [await chatFor(run, v0), await chatFor(run, v1)] as const,
  );

  const isTimer = (b: string) => b.endsWith("(timer)");
  const silent = await ctx.step(t("a minute of silence: no post"), () =>
    botMessagesAfter(run, c0, bot, null, 60_000 + TIMER_TICK_MS + 5_000),
  );
  ctx.assert("no timer post in an empty room", !silent.some(isTimer), silent);

  const posted = c1.next("message", (f) => isBotMessage(f, bot.botUserId, isTimer), 2 * TIMER_TICK_MS + 15_000);
  posted.catch(() => undefined);
  await ctx.step(t("three chat lines"), async () => {
    await sendAccepted(run, c0, `timer line one ${ctx.runId}`);
    await sendAccepted(run, c1, `timer line two ${ctx.runId}`);
    await sendAccepted(run, c0, `timer line three ${ctx.runId}`);
  });
  const post = await ctx.step(t("the timer posts"), () => posted);
  ctx.assert("timer message rendered", post.message.body.startsWith("Follow "), post.message.body);
  const more = await ctx.step(t("and only once"), () => botMessagesAfter(run, c1, bot, null, TIMER_TICK_MS + 5_000));
  ctx.assert("one post", !more.some(isTimer), more);
}

// ---------------------------------------------------------------- step 5

export async function stepSongRequests(run: E8Run): Promise<void> {
  const { ctx, streamer: s } = run;
  const t = (w: string) => botTitle(5, w);
  const v = viewers(run)[1];
  const bot = await ctx.step(t("streamer enables the bot with song requests on"), () =>
    enableBot(run, harnessBotConfig()),
  );
  const chat = await chatFor(run, v);
  const url = songUrl(ctx.runId);
  const sr = s.user.api.client.bot.songRequests;
  const queuedWith = async (status: "queued" | "played") =>
    (await sr.list({ channel: s.channel, status })).filter((r) => r.url === url);

  const reply = await ctx.step(t("!sr <link> queues it"), () =>
    expectReply(run, chat, bot, `!sr ${url}`, (b) => b.includes("in the queue")),
  );
  ctx.data("srReply", reply.message.body);
  const queued = await ctx.step(t("bot.songRequests.list shows it queued"), () =>
    waitFor(
      "song request queued",
      async () => ((await queuedWith("queued")).length === 1 ? queuedWith("queued") : null),
      {
        timeoutMs: API_SETTLE_MS,
        intervalMs: 250,
        signal: ctx.signal,
      },
    ),
  );
  const row = queued[0];
  if (!row) throw new Error("queued song request vanished");
  ctx.assert("requested by the viewer", row.requester === v.username, row);

  await ctx.step(t("!sr not-a-link is refused"), () =>
    expectReply(run, chat, bot, "!sr not-a-link", (b) => b.includes("takes a link")),
  );
  const all = await sr.list({ channel: s.channel });
  ctx.assert(
    "nothing queued for the non-link",
    !all.some((r) => r.url === "not-a-link"),
    all.map((r) => r.url),
  );

  const moved = await ctx.step(t("setStatus played moves it"), () =>
    sr.setStatus({ channel: s.channel, id: row.id, status: "played" }),
  );
  ctx.assert("status played", moved.status === "played", moved);
  ctx.assert("no longer queued", (await queuedWith("queued")).length === 0);
  ctx.assert("listed as played", (await queuedWith("played")).length === 1);
}

function viewers(run: E8Run): [SignedInUser, SignedInUser, SignedInUser] {
  const [a, b, c] = run.viewers;
  if (!a || !b || !c) throw new Error("the E8 run has three viewers (kit.ts)");
  return [a, b, c];
}
