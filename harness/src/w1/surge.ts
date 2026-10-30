// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `surge-guard` steps 1–7 (docs/testing/w1-selectors.md, "Scenarios"; ADR 0015 "Consequences"):
 *
 * 1. Fetch-less bots (signed in, heartbeats only) that try to chat are refused with
 *    `msg_verified_watch`, after honest viewers started at the same time have unlocked.
 * 2. A signed-in bot the API placed on the CDN before the gate was on (`avoidCdn` did not apply
 *    yet) is refused: its session is `fetch_unjudged`. Skipped without the CDN adapter.
 * 3. Six accounts watching behind one address: exactly one (the last to start) stays refused.
 * 4. Real signed-in viewers chat after 60 s of verified watching + jitter + a scoring pass.
 * 5. A screen-reader viewer on the audio rung, driven through the accessibility tree, verifies
 *    and chats (needs W1-player's `?rendition=` parameter).
 * 6. A scripted burst of new unverified sessions trips the guard (the `surge` frame, the
 *    `chat.surge.begin` outbox and audit rows), a newcomer is refused while it is on, a moderator
 *    ends it (`suppressed`), the gate falls back to the channel's own setting, and after the
 *    cooldown the override is gone.
 * 7. `/chat` in the browser saves the settings; the moderator's `surge-banner` ends and starts
 *    surge mode; a viewer sees `chat-gate-hint`.
 *
 * Steps 1, 3 and 4 share one warm-up (their actors start together, once per run) so the scenario
 * waits for verification once. Every named actor is this module's own, never the run's streamer
 * as a chatter or a viewer.
 */
import { join } from "node:path";
import type { ServerFrame } from "@commonair/contracts";
import type { Page } from "playwright";
import { ChatClient } from "../chat-client.ts";
import { HttpViewer } from "../http-viewer.ts";
import { HeartbeatOnlyViewer, STEADY_TIMING } from "../integrity-viewers.ts";
import { playerBundles } from "../player-server.ts";
import { DEFAULT_REPORT_DIR } from "../report.ts";
import { excludedNeeds } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { sleep, waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { W1Run } from "./kit.ts";
import { W1_ROUTES, W1_TEST_IDS as T, byW1Id } from "./selectors.ts";

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** The gate the scenario sets (ADR 0015 decision 7's minimum). */
export const GATE_SECONDS = 60;
/** Decision 4's jitter is at most 30 s; one scoring pass is 15 s. */
export const JITTER_MAX_SECONDS = 30;
export const SCORING_PASS_SECONDS = 15;
/** Denied sends per minute before `msg_ratelimit` (`WATCH_GATE_ATTEMPTS`): retries stay below it. */
export const RETRY_INTERVAL_MS = 20_000;
/** How long an honest viewer may take to unlock: verification, the gate, the jitter, two passes, slack. */
export const UNLOCK_DEADLINE_MS = (GATE_SECONDS + JITTER_MAX_SECONDS + 2 * SCORING_PASS_SECONDS + 90) * 1000;
/** Mirrors `services/worker/src/chat-gate/hysteresis.ts`: max(20, 3 × the trailing 15-minute rate per 2 minutes). */
export function surgeThreshold(trailingSessions: number): number {
  return Math.max(20, Math.ceil((3 * Math.max(0, trailingSessions) * 2) / 15));
}
/** Sessions the scripted burst opens: comfortably above the threshold. */
export function surgeBurstSize(trailingSessions: number): number {
  return surgeThreshold(trailingSessions) + 10;
}

export interface SendResult {
  user: string;
  accepted: boolean;
  /** The refusal's notice code, or null when accepted (or no notice arrived). */
  code: string | null;
}

/** Step 3's expectation: every user but `refused` accepted, and `refused` refused with the gate's code. */
export function capOutcome(results: readonly SendResult[], refused: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const r of results) {
    if (r.user === refused && (r.accepted || r.code !== "msg_verified_watch"))
      problems.push(`${r.user}: expected msg_verified_watch, got ${r.accepted ? "accepted" : r.code}`);
    if (r.user !== refused && !r.accepted) problems.push(`${r.user}: refused with ${r.code}`);
  }
  if (!results.some((r) => r.user === refused)) problems.push(`${refused}: never tried`);
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------------ run state

interface Actor {
  user: SignedInUser;
  chat: ChatClient;
}

interface Warm {
  startedAt: number;
  bots: Actor[];
  /** In start order: the last one is the sixth on the shared address. */
  household: Actor[];
  viewers: Actor[];
}

const warmups = new WeakMap<W1Run, Promise<Warm>>();
const UI_TIMEOUT_MS = 20_000;
const BOTS = 3;
const HOUSEHOLD = 6;

const channelOf = (run: W1Run) => run.streamer.channel;

async function setGate(run: W1Run, seconds: number): Promise<void> {
  await run.streamer.user.api.client.chat.updateSettings({ channel: channelOf(run), minVerifiedWatchSeconds: seconds });
}

/** A chat socket for `user`, joined to the run's channel and closed when the scenario ends. */
async function chatter(run: W1Run, user: SignedInUser): Promise<ChatClient> {
  const chat = await ChatClient.connectWithApi(user.api.client, run.ctx.log);
  run.ctx.defer(() => chat.close());
  await chat.join(channelOf(run));
  return chat;
}

/** One send: accepted, or refused with the notice that answered it. */
export async function attempt(chat: ChatClient, channel: string, user: string, body: string): Promise<SendResult> {
  const codes: string[] = [];
  const off = chat.onFrame((f: ServerFrame) => {
    if (f.op === "notice" && f.channel === channel) codes.push(f.code);
  });
  try {
    const ack = await chat.send(channel, body);
    if (ack.id === null && codes.length === 0) await sleep(200);
    return { user, accepted: ack.id !== null, code: ack.id === null ? (codes[0] ?? null) : null };
  } finally {
    off();
  }
}

/** Retry `who`'s sends every 20 s until accepted or the deadline passes; returns the last result. */
async function sendUntilAccepted(run: W1Run, a: Actor, deadline: number, tag: string): Promise<SendResult> {
  let last: SendResult = { user: a.user.username, accepted: false, code: null };
  for (let i = 0; ; i++) {
    last = await attempt(a.chat, channelOf(run), a.user.username, `${tag} ${i} ${crypto.randomUUID().slice(0, 8)}`);
    if (last.accepted || Date.now() + RETRY_INTERVAL_MS > deadline) return last;
    await sleep(RETRY_INTERVAL_MS, run.ctx.signal);
  }
}

async function signUpActor(run: W1Run, prefix: string): Promise<SignedInUser> {
  return run.ctx.platform.signUp({ prefix });
}

/** Steps 1, 3 and 4 share their warm-up: the gate on, then every actor watching (or pretending to). */
function warmUp(run: W1Run): Promise<Warm> {
  let w = warmups.get(run);
  if (!w) {
    w = startWarmUp(run);
    warmups.set(run, w);
  }
  return w;
}

async function startWarmUp(run: W1Run): Promise<Warm> {
  const { ctx } = run;
  const p = ctx.platform;
  const channel = channelOf(run);
  await ctx.step("gate on: minVerifiedWatchSeconds 60 (streamer, API)", () => setGate(run, GATE_SECONDS));
  const [bots, household, viewers] = await ctx.step("sign up the bots, the household of six and the viewers", () =>
    Promise.all([
      Promise.all(Array.from({ length: BOTS }, () => signUpActor(run, "w1sb"))),
      Promise.all(Array.from({ length: HOUSEHOLD }, () => signUpActor(run, "w1sh"))),
      // The run's own viewers are the honest ones (they never stream or moderate).
      Promise.resolve(run.viewers),
    ]),
  );
  const startedAt = Date.now();
  await ctx.step("start watching: fetch-less bots, the household (one address, in order), real viewers", async () => {
    for (const u of bots) {
      const v = new HeartbeatOnlyViewer({
        id: `w1-bot-${u.username}`,
        api: p.api({ jar: u.api.jar }).client,
        channel,
        log: p.log,
      });
      ctx.defer(() => v.stop());
      await v.start();
    }
    const shared = p.residential.next();
    for (const u of household) {
      const v = new HttpViewer({
        id: `w1-household-${u.username}`,
        target: { channel },
        api: p.api({ jar: u.api.jar, clientIp: shared }).client,
        timing: STEADY_TIMING,
        log: p.log,
      });
      ctx.defer(() => v.stop());
      await v.start();
      // Distinct first-session times: the cap ranks by them.
      await sleep(1_500, ctx.signal);
    }
    for (const u of viewers) {
      const v = new HttpViewer({
        id: `w1-viewer-${u.username}`,
        target: { channel },
        api: p.api({ jar: u.api.jar }).client,
        timing: STEADY_TIMING,
        log: p.log,
      });
      ctx.defer(() => v.stop());
      await v.start();
    }
  });
  const actors = async (users: SignedInUser[]) =>
    Promise.all(users.map(async (user) => ({ user, chat: await chatter(run, user) })));
  return {
    startedAt,
    bots: await actors(bots),
    household: await actors(household),
    viewers: await actors(viewers),
  };
}

// ------------------------------------------------------------------ steps

export async function stepBotsRefused(run: W1Run): Promise<void> {
  const w = await warmUp(run);
  // Wait as long as an honest viewer needs, so the refusal is the gate's verdict and not "too early".
  await run.ctx.step("wait for honest viewers' unlock window", () =>
    sleep(Math.max(0, w.startedAt + UNLOCK_DEADLINE_MS - Date.now()), run.ctx.signal),
  );
  const results = await run.ctx.step("each fetch-less bot tries to chat", () =>
    Promise.all(w.bots.map((b) => attempt(b.chat, channelOf(run), b.user.username, `bot ${crypto.randomUUID()}`))),
  );
  run.ctx.data("surge.bots", results);
  run.ctx.assert(
    "every fetch-less bot is refused with msg_verified_watch",
    results.every((r) => !r.accepted && r.code === "msg_verified_watch"),
    results,
  );
}

export async function stepCdnBotRefused(run: W1Run): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const name = "2. CDN-assigned bot refused: a signed-in bot on the CDN";
  const off =
    excludedNeeds(["cdn"], ctx.profile).length > 0 ? "the no-proprietary profile has no CDN" : await p.probe("cdn");
  if (off) {
    ctx.skipStep(name, off);
    return;
  }
  // The CDN takes sessions only above CDN_BURST_VIEWER_THRESHOLD verified viewers: the ladder's viewers get there.
  await run.forceLadder();
  const user = await signUpActor(run, "w1sc");
  // Before the gate is on: with it on, `avoidCdn` keeps signed-in viewers off the CDN (decision 2).
  await setGate(run, 0);
  let bot: HeartbeatOnlyViewer | null = null;
  try {
    bot = await ctx.step("place a signed-in heartbeat-only bot on the CDN (gate off)", async () => {
      for (let i = 0; i < 12; i++) {
        const v = new HeartbeatOnlyViewer({
          id: `w1-cdn-${i}`,
          api: p.api({ jar: user.api.jar }).client,
          channel: channelOf(run),
          log: p.log,
        });
        ctx.defer(() => v.stop());
        await v.start();
        if (v.assignment?.source === "cdn") return v;
        await v.stop();
        await sleep(5_000, ctx.signal);
      }
      return null;
    });
  } finally {
    await setGate(run, GATE_SECONDS);
  }
  if (!bot) {
    ctx.skipStep(
      "2. CDN bot: refused",
      "no session was assigned the CDN in 12 tries: the API uses it only while the channel's verified viewers exceed CDN_BURST_VIEWER_THRESHOLD",
    );
    return;
  }
  const sid = bot.sessionId ?? "";
  const sql = new Bun.SQL(run.databaseUrl);
  try {
    await ctx.step("the CDN bot is scored fetch_unjudged", () =>
      waitFor(
        "fetch_unjudged on the CDN bot's session",
        async () => {
          const [r] = (await sql`select verdict_reasons from playback_sessions where id = ${sid}::uuid`) as {
            verdict_reasons: string[] | null;
          }[];
          return (r?.verdict_reasons ?? []).includes("fetch_unjudged") ? true : null;
        },
        { timeoutMs: 120_000, intervalMs: 3_000, signal: ctx.signal },
      ),
    );
  } finally {
    await sql.close();
  }
  await ctx.step("past the gate, the jitter and a scoring pass", () =>
    sleep((GATE_SECONDS + JITTER_MAX_SECONDS + 2 * SCORING_PASS_SECONDS) * 1000, ctx.signal),
  );
  const chat = await chatter(run, user);
  const r = await attempt(chat, channelOf(run), user.username, `cdn bot ${crypto.randomUUID()}`);
  ctx.data("surge.cdnBot", r);
  ctx.assert(
    "the CDN-assigned bot is refused with msg_verified_watch",
    !r.accepted && r.code === "msg_verified_watch",
    r,
  );
}

export async function stepPerAddressCap(run: W1Run): Promise<void> {
  const w = await warmUp(run);
  const deadline = w.startedAt + UNLOCK_DEADLINE_MS;
  const [first5, last] = [w.household.slice(0, HOUSEHOLD - 1), w.household[HOUSEHOLD - 1]];
  if (!last) throw new Error("no household");
  const results = await run.ctx.step("the first five unlock", () =>
    Promise.all(first5.map((a) => sendUntilAccepted(run, a, deadline, "household"))),
  );
  // One more scoring pass after the others unlocked: the sixth must still be capped.
  await sleep(2 * SCORING_PASS_SECONDS * 1000, run.ctx.signal);
  const sixth = await attempt(last.chat, channelOf(run), last.user.username, `household last ${crypto.randomUUID()}`);
  const all = [...results, sixth];
  run.ctx.data("surge.household", all);
  const o = capOutcome(all, last.user.username);
  run.ctx.assert("six accounts behind one address: exactly one (the last) refused", o.ok, o.problems);
}

export async function stepRealViewersChat(run: W1Run): Promise<void> {
  const w = await warmUp(run);
  const deadline = w.startedAt + UNLOCK_DEADLINE_MS;
  const results = await run.ctx.step("each real viewer chats once unlocked", () =>
    Promise.all(
      w.viewers.map(async (a) => {
        const r = await sendUntilAccepted(run, a, deadline, "viewer");
        return { ...r, afterSeconds: Math.round((Date.now() - w.startedAt) / 1000) };
      }),
    ),
  );
  run.ctx.data("surge.viewers", results);
  run.ctx.assert(
    "every real viewer chats after 60 s + jitter + a scoring pass",
    results.every((r) => r.accepted),
    results,
  );
  run.ctx.check(
    "no viewer unlocked before the gate's 60 s",
    results.every((r) => r.afterSeconds >= GATE_SECONDS - JITTER_MAX_SECONDS),
    results,
  );
}

export async function stepAudioOnlyViewer(run: W1Run): Promise<void> {
  const { ctx } = run;
  await warmUp(run);
  // The kit forces the ladder so the `audio` rung exists (W1-player's `?rendition=audio`).
  await run.forceLadder();
  const user = await signUpActor(run, "w1sr");
  const observer = await chatter(run, await signUpActor(run, "w1so"));
  const session = await browserSession(run, "screen-reader", user);
  await withScreenshots(run, [session], async () => {
    const page = await session.goto(W1_ROUTES.channel(channelOf(run), { rendition: "audio" }));
    // Only the accessibility tree from here on, as a screen reader drives the page.
    const box = page.getByRole("textbox", { name: "Send a message" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await box.waitFor({ timeout: UI_TIMEOUT_MS });
    const started = Date.now();
    const body = `audio-only ${crypto.randomUUID().slice(0, 8)}`;
    const seen = await ctx.step("the audio-only viewer verifies and chats", () =>
      waitFor(
        "the audio-only viewer's message in the room",
        async () => {
          await box.fill(body);
          await send.click({ timeout: UI_TIMEOUT_MS });
          const got = await observer
            .waitFor("message", (f) => f.message.user.username === user.username && f.message.body === body, 5_000)
            .catch(() => null);
          return got ?? null;
        },
        { timeoutMs: UNLOCK_DEADLINE_MS + 60_000, intervalMs: RETRY_INTERVAL_MS, signal: ctx.signal },
      ),
    );
    ctx.metric("surge.audio.unlock", Date.now() - started, "ms");
    ctx.data("surge.audio", { messageId: seen.message.id, rendition: await renditionOf(page) });
  });
}

export async function stepSurgeTripsAndReverts(run: W1Run): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const channel = channelOf(run);
  const api = run.streamer.user.api.client;
  // The streamer's socket is only an observer of control frames here; it never chats.
  const modWatch = await ChatClient.connectWithApi(api, ctx.log);
  ctx.defer(() => modWatch.close());
  await modWatch.join(channel);
  const newcomer = { user: await signUpActor(run, "w1sn"), chat: null as ChatClient | null };
  newcomer.chat = await chatter(run, newcomer.user);
  const newcomerChat = newcomer.chat;

  await ctx.step("the surge guard on (cooldown 1 min); the channel's own gate 0", () =>
    api.chat.updateSettings({
      channel,
      minVerifiedWatchSeconds: 0,
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 1 },
    }),
  );
  const sql = new Bun.SQL(run.databaseUrl);
  try {
    const [t] = (await sql`
      select count(*)::int as n from playback_sessions
       where broadcast_id = (select live_broadcast_id from channels where id = ${run.streamer.channelId}::uuid)
         and started_at >= now() - interval '17 minutes' and started_at < now() - interval '2 minutes'`) as {
      n: number;
    }[];
    const size = surgeBurstSize(t?.n ?? 0);
    ctx.data("surge.burst", { trailing: t?.n ?? 0, sessions: size });
    const bots = Array.from(
      { length: size },
      (_, i) => new HeartbeatOnlyViewer({ id: `w1-surge-${i}`, api: p.api().client, channel, log: p.log }),
    );
    for (const b of bots) ctx.defer(() => b.stop());
    await ctx.step(`a burst of ${size} new unverified HTTP sessions`, () => Promise.all(bots.map((b) => b.start())));
    // Judged only once a minute old (verification takes about three beats).
    await sleep(65_000, ctx.signal);
    const on = await ctx.step("chat-surge-guard (ops tick) begins surge mode", () =>
      run.hooks.client.tickUntil(
        "chat-surge-guard",
        "surge mode on",
        async () => {
          const s = await api.chat.surge.state({ channel });
          return s.state === "on" ? s : null;
        },
        { timeoutMs: 60_000, intervalMs: 3_000 },
      ),
    );
    ctx.data("surge.on", on.value);
    await ctx.step("the surge frame reaches the room", () =>
      modWatch.waitFor("surge", (f) => f.channel === channel && f.state === "on", 10_000),
    );
    const begin = (await sql`
      select e.payload, (select count(*)::int from audit_log a
                          where a.channel_id = e.channel_id and a.action = 'chat.surge.begin') as audits
        from events e where e.channel_id = ${run.streamer.channelId}::uuid and e.type = 'chat.surge.begin'
       order by e.occurred_at desc limit 1`) as { payload: Record<string, unknown>; audits: number }[];
    ctx.data("surge.beginRow", begin[0] ?? null);
    ctx.assert("a chat.surge.begin outbox row and its audit row", (begin[0]?.audits ?? 0) >= 1, begin[0]);

    const refused = await attempt(newcomerChat, channel, newcomer.user.username, `newcomer ${crypto.randomUUID()}`);
    ctx.assert(
      "a newcomer is refused while surge mode is on",
      !refused.accepted && refused.code === "msg_verified_watch",
      refused,
    );

    const ended = await ctx.step("a moderator ends it (streamer, API)", () =>
      api.chat.surge.override({ channel, action: "end" }),
    );
    ctx.assert("ending writes suppressed", ended.state === "suppressed", ended);
    await modWatch.waitFor("surge", (f) => f.channel === channel && f.state === "suppressed", 10_000);
    const end = (await sql`
      select e.payload from events e
       where e.channel_id = ${run.streamer.channelId}::uuid and e.type = 'chat.surge.end'
       order by e.occurred_at desc limit 1`) as { payload: Record<string, unknown> }[];
    ctx.assert("a chat.surge.end outbox row with reason moderator", end[0]?.payload.reason === "moderator", end[0]);
    const after = await ctx.step("the gate is the channel's own again (0): the newcomer chats", () =>
      waitFor(
        "newcomer accepted",
        async () => {
          const r = await attempt(newcomerChat, channel, newcomer.user.username, `newcomer ${crypto.randomUUID()}`);
          return r.accepted ? r : null;
        },
        { timeoutMs: 15_000, intervalMs: 3_000, signal: ctx.signal },
      ),
    );
    ctx.data("surge.newcomerAfter", after);

    await Promise.all(bots.map((b) => b.stop()));
    // The suppression runs out after the cooldown; the burst is then outside the 2-minute window.
    const until = Date.parse(ended.until ?? "");
    await sleep(Math.max(0, until - Date.now()) + 20_000, ctx.signal);
    await ctx.step("after the cooldown the override is gone", () =>
      run.hooks.client.tickUntil(
        "chat-surge-guard",
        "surge state off",
        async () => ((await api.chat.surge.state({ channel })).state === "off" ? true : null),
        { timeoutMs: 60_000, intervalMs: 3_000 },
      ),
    );
  } finally {
    await sql.close();
    await setGate(run, GATE_SECONDS).catch(() => undefined);
  }
}

export async function stepStudioAndBanner(run: W1Run): Promise<void> {
  const { ctx } = run;
  const channel = channelOf(run);
  const api = run.streamer.user.api.client;
  const studio = await browserSession(run, "streamer", run.streamer.user);
  const viewer = await browserSession(run, "viewer", await signUpActor(run, "w1sv"));
  await withScreenshots(run, [studio, viewer], async () => {
    await ctx.step("/chat: save gate 120 s, the guard on, 50 %, 2 min", async () => {
      const page = await studio.goto(W1_ROUTES.chatSettings);
      await byW1Id(page, T.chatGateSettings).waitFor({ timeout: UI_TIMEOUT_MS });
      await byW1Id(page, T.chatGateSeconds).fill("120");
      const sw = byW1Id(page, T.surgeGuardEnabled);
      if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
      await byW1Id(page, T.surgeGuardRatio).fill("50");
      await byW1Id(page, T.surgeGuardCooldown).fill("2");
      await byW1Id(page, T.chatGateSave).click();
      await waitFor(
        "settings saved",
        async () => {
          const s = await api.chat.settings({ channel });
          return s.minVerifiedWatchSeconds === 120 && s.surgeGuard.enabled && s.surgeGuard.cooldownMinutes === 2
            ? s
            : null;
        },
        { timeoutMs: UI_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
      );
    });
    await ctx.step("surge on (API); the moderator's banner ends and starts it", async () => {
      await api.chat.surge.override({ channel, action: "start" });
      const page = await studio.goto(`/${channel}`);
      await byW1Id(page, T.surgeBanner, { state: "on" }).waitFor({ timeout: UI_TIMEOUT_MS });
      await byW1Id(page, T.surgeEnd).click();
      await byW1Id(page, T.surgeBanner, { state: "suppressed" }).waitFor({ timeout: UI_TIMEOUT_MS });
      await byW1Id(page, T.surgeStart).click();
      await byW1Id(page, T.surgeBanner, { state: "on" }).waitFor({ timeout: UI_TIMEOUT_MS });
    });
    await ctx.step("a viewer sees the chat-gate hint", async () => {
      const page = await viewer.goto(`/${channel}`);
      await byW1Id(page, T.chatGateHint).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  });
  await api.chat.surge.override({ channel, action: "end" }).catch(() => undefined);
  await api.chat
    .updateSettings({ channel, minVerifiedWatchSeconds: GATE_SECONDS, surgeGuard: { enabled: false } })
    .catch(() => undefined);
}

// ------------------------------------------------------------------ browser plumbing

async function browserSession(run: W1Run, label: string, user: SignedInUser): Promise<WebSession> {
  const { ctx } = run;
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const page = await session.goto(ROUTES.signin);
  await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  // Land on the signed-in shell before the next navigation.
  await byTestId(page, TEST_IDS.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  return session;
}

async function withScreenshots<R>(run: W1Run, sessions: readonly WebSession[], fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    const dir = join(run.ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${run.ctx.runId}-${run.ctx.name}`);
    const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir)))).flat();
    if (files.length > 0) run.ctx.data("surgeScreenshots", files);
    throw err;
  }
}

/** The player's reported rendition, for the report (W1-player's seam; null when it says nothing). */
async function renditionOf(page: Page): Promise<string | null> {
  return page
    .locator('[data-testid="player"]')
    .first()
    .getAttribute("data-rendition", { timeout: 2_000 })
    .catch(() => null);
}
