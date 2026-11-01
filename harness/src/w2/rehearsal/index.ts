// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `rehearsal` steps 1–7 (docs/testing/w2-selectors.md, "Scenarios"; feature-wins §4.11; batch 6
 * decisions (f), (g)) and their run state. The scenario's own actors: a streamer, an invited
 * follower and a stranger. Step 1 arms (on `/rehearse` through the web UI, or the API with
 * `--set via=api`), invites the follower and publishes with the normal stream key; every later
 * step reads that rehearsal. Step 6 stops the encoder, so it runs after 2–5 when they are selected.
 *
 * Database reads need `DATABASE_URL` (Bun loads it from the repo `.env`); without it those checks
 * fail as a hard assertion, as in `trust-safety`.
 */
import type { RehearsalReport } from "@commonair/contracts/dto";
import { playerBundles } from "../../player-server.ts";
import type { Via } from "../../money.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { Streamer } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import { waitFor } from "../../wait.ts";
import { signInViaUi } from "../../web/flows.ts";
import { ROUTES } from "../../web/selectors.ts";
import { WebSession } from "../../web/session.ts";
import type { RehearsalStep } from "../steps.ts";
import { rehearsalTitle } from "../steps.ts";
import {
  REHEARSAL_ROUTE,
  REHEARSAL_TEST_IDS as R,
  heldWord,
  judgeChatReport,
  testIdSelector,
  vodExpiresInADay,
} from "./checks.ts";
import {
  broadcastEndedAt,
  countedFor,
  directInsertRefusals,
  downstreamOf,
  rehearsalAudit,
  storedChat,
  vodOf,
} from "./db.ts";

const UI_TIMEOUT_MS = 30_000;
/** Ingest, the gate and the driver's first report on a loaded CI runner. */
const START_TIMEOUT_MS = 60_000;
/** The burst starts 45 s in; the report lands within a few polls after it. */
const REPORT_TIMEOUT_MS = 150_000;
const PLAY_TIMEOUT_MS = 90_000;
const VOD_TIMEOUT_MS = 120_000;
const DEVICE_ID = "harness-rehearsal-device-0001";

export interface RehearsalRun {
  ctx: ScenarioContext;
  via: Via;
  startedAt: Date;
  streamer: SignedInUser;
  invitee: SignedInUser;
  stranger: SignedInUser;
  channel: string;
  channelId: string;
  databaseUrl: string | undefined;
  /** Set by step 1. */
  encoder: Streamer | null;
  armId: string | null;
  broadcastId: string | null;
  sessions: WebSession[];
}

/** Set up what the selected steps share: the actors, the follow and the channel's filters. */
export async function newRehearsalRun(ctx: ScenarioContext, opts: { via: Via }): Promise<RehearsalRun> {
  const p = ctx.platform;
  const [streamer, invitee, stranger] = await ctx.step(
    "rehearsal: sign up the streamer, a follower and a stranger",
    () =>
      Promise.all([
        p.signUp({ prefix: "rh_streamer" }),
        p.signUp({ prefix: "rh_fan" }),
        p.signUp({ prefix: "rh_other" }),
      ]),
  );
  const channel = streamer.me.channelSlug ?? streamer.username;
  const run: RehearsalRun = {
    ctx,
    via: opts.via,
    startedAt: new Date(),
    streamer,
    invitee,
    stranger,
    channel,
    channelId: (await streamer.api.client.channels.get({ channel })).id,
    databaseUrl: ctx.env.DATABASE_URL,
    encoder: null,
    armId: null,
    broadcastId: null,
    sessions: [],
  };
  ctx.defer(async () => {
    await Promise.allSettled(run.sessions.map((s) => s.close()));
    await run.encoder?.stop();
    // Never leave the channel armed: its next publish would be another rehearsal.
    await streamer.api.client.stream.rehearsal.disarm({ channel }).catch(() => undefined);
  });
  await ctx.step(
    "rehearsal: the follower follows; the channel records VODs, holds a word and blocks links",
    async () => {
      // Media records a rehearsal only on a channel with VODs on (read at session start, so before
      // step 1 publishes); new channels default to off, and step 6 checks the rehearsal's VOD.
      await streamer.api.client.channels.update({ channel, vodEnabled: true });
      await invitee.api.client.channels.follow({ channel, notify: true });
      await streamer.api.client.chat.filters.create({ channel, pattern: heldWord(ctx.runId), action: "hold" });
      await streamer.api.client.chat.updateSettings({ channel, linksAllowed: false });
    },
  );
  return run;
}

const title = (n: RehearsalStep, what: string) => rehearsalTitle(n, what);

/** The oRPC error code a refused call rejected with, or `ok`. */
async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (err) {
    return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "error";
  }
}
const requirementOf = async (call: Promise<unknown>): Promise<string | null> => {
  try {
    await call;
    return null;
  } catch (err) {
    const data = (err as { data?: { requirement?: unknown } }).data;
    return typeof data?.requirement === "string" ? data.requirement : null;
  }
};

async function webSession(run: RehearsalRun, user: SignedInUser, label: string): Promise<WebSession> {
  const { ctx } = run;
  const s = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label,
    log: ctx.log,
  });
  run.sessions.push(s);
  const page = await s.goto(ROUTES.signin);
  await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  return s;
}

function needDb(run: RehearsalRun, n: RehearsalStep): string | null {
  run.ctx.assert(`${n}. DATABASE_URL is set (run from the repo root so Bun loads .env)`, run.databaseUrl !== undefined);
  return run.databaseUrl ?? null;
}

function needBroadcast(run: RehearsalRun, n: RehearsalStep): string {
  run.ctx.assert(`${n}. step 1 left a rehearsal broadcast`, run.broadcastId !== null);
  return run.broadcastId as string;
}

// ------------------------------------------------------------------ steps

async function armAndPublish(run: RehearsalRun): Promise<void> {
  const { ctx, streamer, channel } = run;
  const rehearsal = streamer.api.client.stream.rehearsal;
  if (run.via === "web") {
    const s = await webSession(run, streamer, "w2-rehearsal-streamer");
    const page = await s.goto(REHEARSAL_ROUTE);
    await ctx.step(title(1, "arm on /rehearse"), async () => {
      await page.locator(testIdSelector(R.keyReminder)).waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator(testIdSelector(R.arm)).click({ timeout: UI_TIMEOUT_MS });
      await page.locator(testIdSelector(R.status, { state: "armed" })).waitFor({ timeout: UI_TIMEOUT_MS });
    });
    await ctx.step(title(1, "invite the follower in the picker"), async () => {
      await page.locator(testIdSelector(R.inviteeInput)).fill(run.invitee.username, { timeout: UI_TIMEOUT_MS });
      await page.locator(testIdSelector(R.inviteeAdd)).click({ timeout: UI_TIMEOUT_MS });
      await page
        .locator(testIdSelector(R.invitee, { username: run.invitee.username }))
        .waitFor({ timeout: UI_TIMEOUT_MS });
    });
    const keyText = (await page.locator(testIdSelector(R.keyReminder)).textContent()) ?? "";
    ctx.check("1. the key reminder never shows a full key", !/live_[a-z0-9]{24,}/i.test(keyText));
  } else {
    await ctx.step(title(1, "arm through the API"), () => rehearsal.arm({ channel }));
    await ctx.step(title(1, "invite the follower"), () =>
      rehearsal.invite({ channel, username: run.invitee.username }),
    );
  }
  const armed = await rehearsal.status({ channel });
  ctx.assert("1. armed with a 10-minute arm", armed.state === "armed" && armed.armExpiresAt !== null, armed);
  ctx.assert(
    "1. the follower is the one invitee",
    armed.invitees.map((i) => i.username).join() === run.invitee.username,
    armed.invitees,
  );
  run.armId = armed.armId;
  ctx.check(
    "1. a stranger cannot be invited",
    (await requirementOf(rehearsal.invite({ channel, username: run.stranger.username }))) === "not_follower",
  );

  const encoder = await ctx.step(title(1, "publish with the normal stream key"), async () => {
    const e = await ctx.platform.streamerFor(streamer, { protocol: "rtmp" });
    run.encoder = e;
    await e.start();
    return e;
  });
  void encoder;
  const rehearsing = await ctx.step(title(1, "the publish starts a rehearsal"), () =>
    waitFor(
      "stream.rehearsal.status rehearsing",
      async () => {
        const s = await rehearsal.status({ channel });
        return s.state === "rehearsing" ? s : null;
      },
      { timeoutMs: START_TIMEOUT_MS, intervalMs: 1000, signal: ctx.signal },
    ),
  );
  run.broadcastId = rehearsing.broadcastId;
  ctx.assert("1. rehearsing under the same arm", rehearsing.armId === run.armId, rehearsing);
  if (run.via === "web") {
    const page = await run.sessions[0]!.page();
    await ctx.step(title(1, "the page says rehearsing"), () =>
      page.locator(testIdSelector(R.status, { state: "rehearsing" })).waitFor({ timeout: UI_TIMEOUT_MS }),
    );
  }
}

async function invisibleDownstream(run: RehearsalRun): Promise<void> {
  const { ctx, channel } = run;
  const anon = ctx.platform.api().client;
  const c = await ctx.step(title(2, "channels.get"), () => anon.channels.get({ channel }));
  ctx.assert("2. the channel is not live", c.live === null, { live: c.live });
  const live = await ctx.step(title(2, "directory"), () => anon.directory.live({}));
  ctx.assert("2. no directory entry", !JSON.stringify(live).includes(`"${channel}"`));
  const home = await anon.directory.home({});
  ctx.check("2. not in the front page either", !JSON.stringify(home).includes(`"slug":"${channel}"`));
  const db = needDb(run, 2);
  if (!db) return;
  const d = await ctx.step(title(2, "outbox, EventSub, go-live inbox"), () =>
    downstreamOf(db, run.channelId, run.invitee.id, run.startedAt),
  );
  ctx.assert(
    "2. no stream.online or stream.offline outbox row (go-live, EventSub, webhooks, Discord)",
    d.streamEvents === 0,
    d,
  );
  ctx.assert("2. no EventSub or webhook delivery", d.deliveries === 0, d);
  ctx.assert("2. the following invitee got no go-live notification", d.goLiveNotifications === 0, d);
}

async function nothingCounts(run: RehearsalRun): Promise<void> {
  const { ctx } = run;
  const b = needBroadcast(run, 3);
  const db = needDb(run, 3);
  if (!db) return;
  // Let the media sampler run a few times (it would add streaming hours for a live broadcast).
  await ctx.step(title(3, "a few health samples"), () =>
    waitFor(
      "a checklist with ingest samples",
      async () => {
        const r = await run.streamer.api.client.stream.rehearsal.report({ channel: run.channel });
        return r.ingest.length > 0 ? r : null;
      },
      { timeoutMs: START_TIMEOUT_MS, intervalMs: 2000, signal: ctx.signal },
    ),
  );
  const counted = await ctx.step(title(3, "rows that count"), () => countedFor(db, b));
  ctx.assert(
    "3. no stream_hours, ledger, attestation or rollup row",
    Object.values(counted).every((n) => n === 0),
    counted,
  );
  const refusals = await ctx.step(title(3, "direct inserts"), () =>
    directInsertRefusals(db, { broadcastId: b, channelId: run.channelId }),
  );
  ctx.assert("3. stream_hours refuses the rehearsal", /rehearsal/.test(refusals.streamHours ?? ""), refusals);
  ctx.assert("3. the ledger refuses the rehearsal", /rehearsal/.test(refusals.ledger ?? ""), refusals);
  ctx.assert("3. attestations refuse the rehearsal", /rehearsal/.test(refusals.attestation ?? ""), refusals);
  ctx.assert("3. never the channel's live broadcast", /rehearsal/.test(refusals.liveBroadcast ?? ""), refusals);
  // Goals and raids (E8) read `stream.online`, which step 2 showed never exists; alert checks stay
  // deferred (decision (j)), so no goal code path is exercised.
}

async function simulatedChat(run: RehearsalRun): Promise<void> {
  const { ctx, channel } = run;
  const b = needBroadcast(run, 4);
  // The invitee sits in the channel's public chat through the burst: nothing simulated may arrive.
  const listener = await ctx.step(title(4, "the invitee joins the public chat"), async () => {
    const c = await ctx.platform.chat(run.invitee);
    ctx.defer(() => c.close());
    await c.join(channel);
    return c;
  });
  const report = await ctx.step(title(4, "the burst lands in the report"), () =>
    waitFor(
      "a report with the burst filtered",
      async () => {
        const r = await run.streamer.api.client.stream.rehearsal.report({ channel });
        return judgeChatReport(r.chat).ok ? r : null;
      },
      { timeoutMs: REPORT_TIMEOUT_MS, intervalMs: 5000, signal: ctx.signal },
    ).catch(async () => run.streamer.api.client.stream.rehearsal.report({ channel })),
  );
  const v = judgeChatReport(report.chat);
  ctx.data("rehearsal.chat", report.chat);
  ctx.assert("4. simulated chat filtered or held, burst included", v.ok, v);
  const delivered = listener.messages(channel);
  ctx.assert("4. no simulated message reached public chat", delivered.length === 0, {
    delivered: delivered.length,
    first: delivered[0]?.message.user.username,
  });
  listener.close();
  const db = needDb(run, 4);
  if (db) {
    const stored = await ctx.step(title(4, "stored chat"), () => storedChat(db, run.channelId, b, run.startedAt));
    ctx.assert(
      "4. no simulated message stored (public chat or replay)",
      stored.channel === 0 && stored.broadcast === 0,
      stored,
    );
  }
  ctx.check(
    "4. bitrate and video checks reported",
    report.ingest.some((c) => c.check === "bitrate"),
    report.ingest,
  );
  if (run.via === "web") {
    const page = await run.sessions[0]!.page();
    await ctx.step(title(4, "the report on /rehearse"), async () => {
      const chat = page.locator(testIdSelector(R.reportChat));
      await waitFor(
        "rehearsal-report-chat with rejections",
        async () => Number((await chat.getAttribute("data-rejected", { timeout: UI_TIMEOUT_MS })) ?? 0) > 0,
        { timeoutMs: UI_TIMEOUT_MS, intervalMs: 1000, signal: ctx.signal },
      );
      await page.locator(testIdSelector(R.checklist)).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  }
}

async function inviteePlayback(run: RehearsalRun): Promise<void> {
  const { ctx, channel } = run;
  needBroadcast(run, 5);
  const watch = await ctx.step(title(5, "the invitee gets an origin token"), () =>
    run.invitee.api.client.stream.rehearsal.watch({ channel, deviceId: DEVICE_ID }),
  );
  const playlist = await ctx.step(title(5, "the invitee's playlist plays"), () =>
    waitFor(
      "the rehearsal playlist",
      async () => {
        const res = await fetch(watch.playlistUrl, { signal: ctx.signal });
        const body = await res.text();
        return res.ok && body.startsWith("#EXTM3U") ? body : null;
      },
      { timeoutMs: START_TIMEOUT_MS, intervalMs: 2000, signal: ctx.signal },
    ),
  );
  ctx.check("5. a media playlist or master", playlist.includes("#EXT"));
  const rehearsal = (u: { api: SignedInUser["api"] }) => u.api.client.stream.rehearsal;
  ctx.assert(
    "5. a non-invitee is refused",
    (await outcome(rehearsal(run.stranger).watch({ channel, deviceId: DEVICE_ID }))) === "NOT_FOUND",
  );
  const anon = ctx.platform.api().client;
  ctx.assert(
    "5. a signed-out viewer is refused",
    (await outcome(anon.stream.rehearsal.watch({ channel, deviceId: DEVICE_ID }))) === "UNAUTHORIZED",
  );
  ctx.assert(
    "5. playback.start sees the channel offline",
    (await outcome(anon.playback.start({ channel, deviceId: DEVICE_ID }))) === "PRECONDITION_FAILED",
  );
  ctx.assert(
    "5. the embed is refused",
    (await outcome(anon.playback.start({ channel, deviceId: DEVICE_ID, embed: true }))) === "PRECONDITION_FAILED",
  );
  // A token for the live path without the rehearsal claim gets nothing from the origin.
  const bare = watch.playlistUrl.replace(/\?t=[^&]+/, "");
  ctx.check("5. the playlist without a token is refused", !(await fetch(bare, { signal: ctx.signal })).ok);

  if (run.via === "web") {
    const s = await webSession(run, run.invitee, "w2-rehearsal-invitee");
    const page = await s.goto(`${REHEARSAL_ROUTE}?channel=${encodeURIComponent(channel)}`);
    await ctx.step(title(5, "the invitee watches in the browser"), () =>
      page.locator(testIdSelector(R.watch, { state: "playing" })).waitFor({ timeout: PLAY_TIMEOUT_MS }),
    );
    const other = await webSession(run, run.stranger, "w2-rehearsal-stranger");
    const otherPage = await other.goto(`${REHEARSAL_ROUTE}?channel=${encodeURIComponent(channel)}`);
    await ctx.step(title(5, "a stranger sees nothing to watch"), () =>
      otherPage.locator(testIdSelector(R.watch, { state: "unavailable" })).waitFor({ timeout: UI_TIMEOUT_MS }),
    );
  }
}

async function rehearsalVod(run: RehearsalRun): Promise<void> {
  const { ctx, channel } = run;
  const b = needBroadcast(run, 6);
  const db = needDb(run, 6);
  await ctx.step(title(6, "stop the encoder"), () => run.encoder?.stop());
  const report: RehearsalReport = await ctx.step(title(6, "the rehearsal ends as the publisher's end"), () =>
    waitFor(
      "a final report",
      async () => {
        const r = await run.streamer.api.client.stream.rehearsal.report({ channel, broadcastId: b });
        return r.endReason ? r : null;
      },
      { timeoutMs: START_TIMEOUT_MS, intervalMs: 2000, signal: ctx.signal },
    ),
  );
  ctx.check("6. ended by the publisher", report.endReason === "publisher_ended", { endReason: report.endReason });
  if (!db) return;
  const vod = await ctx.step(title(6, "the rehearsal VOD"), () =>
    waitFor("the rehearsal's VOD row", () => vodOf(db, b), {
      timeoutMs: VOD_TIMEOUT_MS,
      intervalMs: 2000,
      signal: ctx.signal,
    }),
  );
  const endedAt = await broadcastEndedAt(db, b);
  ctx.assert("6. the VOD is private", vod.visibility === "private", vod);
  ctx.assert("6. it expires 24 h after the rehearsal", vodExpiresInADay(vod.expiresAt, [endedAt, vod.createdAt]), {
    expiresAt: vod.expiresAt,
    endedAt,
    createdAt: vod.createdAt,
  });
  ctx.assert(
    "6. it cannot be made public",
    (await requirementOf(run.streamer.api.client.vods.update({ id: vod.id, visibility: "public" }))) === "rehearsal",
  );
  const listed = await ctx.platform.api().client.vods.list({ channel });
  ctx.assert("6. it is not in the public VOD list", !JSON.stringify(listed).includes(vod.id));
  const stored = await storedChat(db, run.channelId, b, run.startedAt);
  ctx.assert("6. the rehearsal's chat replay has nothing to show", stored.broadcast === 0, stored);
  // The owner may read replay of their private VOD once it is playable; still processing is fine.
  const replay = await run.streamer.api.client.vods.chat({ id: vod.id }).catch(() => null);
  if (replay)
    ctx.assert("6. chat replay of the rehearsal VOD is empty", replay.items.length === 0, replay.items.length);
}

async function auditRows(run: RehearsalRun): Promise<void> {
  const { ctx } = run;
  const db = needDb(run, 7);
  if (!db) return;
  const rows = await ctx.step(title(7, "audit rows"), () => rehearsalAudit(db, run.channelId, run.startedAt));
  ctx.assert(
    "7. the arm is audited, by arm id",
    rows.some((r) => r.action === "rehearsal.arm" && r.subjectId === run.channelId && r.armId === run.armId),
    rows,
  );
  ctx.assert(
    "7. the invitee is audited, by user id",
    rows.some(
      (r) => r.action === "rehearsal.invitee.add" && r.subjectType === "user" && r.subjectId === run.invitee.id,
    ),
    rows,
  );
  ctx.check("7. no usernames in audit rows", !JSON.stringify(rows).includes(run.invitee.username));
}

export const REHEARSAL_STEP_RUNNERS: Readonly<Record<RehearsalStep, (run: RehearsalRun) => Promise<void>>> = {
  1: armAndPublish,
  2: invisibleDownstream,
  3: nothingCounts,
  4: simulatedChat,
  5: inviteePlayback,
  6: rehearsalVod,
  7: auditRows,
};

/**
 * `rehearsal` W3 extension `moderation-samples` (batch 7; `src/w3/steps.ts`): the rehearsal
 * report's moderation sample count is above zero. Runs after the scenario's steps, with step 1.
 * Stub entry point from the batch 7 contract step: B7-followups fills it.
 */
export async function stepModerationSamples(_run: RehearsalRun): Promise<void> {
  throw new Error("B7-followups not merged");
}
