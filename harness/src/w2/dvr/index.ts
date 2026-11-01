// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `live-dvr` steps 1–7 (docs/testing/w2-selectors.md, "Scenarios"; ADR 0016) and their run state.
 *
 * Steps 1, 2, 4, 5 and 6 share one live channel with VODs on (started on first use, so any step
 * runs alone); step 3 removes its recording and step 7 has VODs off, so each has its own channel.
 * Every step signs up its own actors. Database reads use `DATABASE_URL` (the stack's owner
 * connection, as the operator CLI does); the subscription in step 5 is a row written the same way
 * (the step is about the DVR gate, not checkout). No token or object key is logged.
 *
 * Parameters: `--set dvrWatchSeconds=120 --set dvrVerifySeconds=300 --set dvrBehindSeconds=60`.
 */
import { createDb, uuidv7 } from "@commonair/db";
import { mediaPath } from "@commonair/contracts/internal";
import { dataModeCeilingBps } from "@commonair/contracts/enums";
import { dvrTokenPath } from "@commonair/contracts/storage";
import { signPlaybackToken, importSigningKey } from "@commonair/tokens";
import type { ApiClient } from "../../api/client.ts";
import { newDeviceId } from "../../fingerprint.ts";
import type { Via } from "../../money.ts";
import { playerBundles } from "../../player-server.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { Streamer } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import type { Viewer } from "../../viewer.ts";
import { waitFor } from "../../wait.ts";
import { WebSession } from "../../web/session.ts";
import { dvrTitle, type DvrStep } from "../steps.ts";
import { DvrHttpViewer, nextSegmentName } from "./viewer.ts";

/** The origin's 5 s per-instance state cache, plus slack for a loaded CI runner. */
export const DVR_CLOSE_WITHIN_MS = 5_000;
export const DVR_CLOSE_SLACK_MS = 3_000;
const LIVE_TIMEOUT_MS = 60_000;
const RECORDING_TIMEOUT_MS = 90_000;
const UI_TIMEOUT_MS = 30_000;
/** Enough recording for a rewind past the live edge (the DVR playlist ends ~8 s behind live). */
const MIN_DVR_SEGMENTS = 6;

export interface DvrChannel {
  user: SignedInUser;
  channel: string;
  channelId: string;
  vodId: string | null;
  encoder: Streamer;
}

export interface DvrRun {
  ctx: ScenarioContext;
  via: Via;
  databaseUrl: string | undefined;
  /** `HARNESS_ORIGIN_URL` without a trailing slash. */
  origin: string;
  /** The shared live channel with VODs on (steps 1, 2, 4, 5, 6). */
  shared(): Promise<DvrChannel>;
  /** A new live channel for one step. */
  newChannel(prefix: string, opts: { vods: boolean }): Promise<DvrChannel>;
  /** A fresh anonymous API client (own address). */
  anon(): ApiClient;
}

/** Set up what the selected steps share. */
export async function newDvrRun(ctx: ScenarioContext, opts: { via: Via }): Promise<DvrRun> {
  let shared: Promise<DvrChannel> | null = null;
  const run: DvrRun = {
    ctx,
    via: opts.via,
    databaseUrl: ctx.env.DATABASE_URL,
    origin: ctx.env.HARNESS_ORIGIN_URL.replace(/\/+$/, ""),
    shared: () => (shared ??= liveChannel(run, "dvr_s", { vods: true })),
    newChannel: (prefix, o) => liveChannel(run, prefix, o),
    anon: () => ctx.platform.api().client,
  };
  return run;
}

async function liveChannel(run: DvrRun, prefix: string, opts: { vods: boolean }): Promise<DvrChannel> {
  const { ctx } = run;
  const user = await ctx.platform.signUp({ prefix });
  const channel = user.me.channelSlug ?? user.username;
  if (opts.vods) await user.api.client.channels.update({ channel, vodEnabled: true });
  const c = await user.api.client.channels.get({ channel });
  const encoder = await ctx.platform.streamerFor(user, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
  ctx.defer(() => encoder.stop());
  await encoder.start();
  await ctx.platform.waitForLive(channel, true, LIVE_TIMEOUT_MS);
  const vodId = opts.vods
    ? await waitFor(
        `${channel}: a recording VOD`,
        async () =>
          (await user.api.client.vods.list({ channel, limit: 5 })).items.find((v) => v.status === "recording")?.id ??
          null,
        { timeoutMs: RECORDING_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
      )
    : null;
  return { user, channel, channelId: c.id, vodId, encoder };
}

/** Start a session and end it again: what `playback.start` grants this client now. */
async function grantOf(api: ApiClient, channel: string, extra: { dataMode?: number } = {}) {
  const s = await api.playback.start({
    channel,
    deviceId: newDeviceId(),
    nativeHls: false,
    p2pCapable: false,
    embed: false,
    ...extra,
  });
  await api.playback.end({ sessionId: s.sessionId, token: s.token }).catch(() => undefined);
  return s;
}

/** A DVR playlist URL with at least `MIN_DVR_SEGMENTS` uploaded segments (the recording warms up). */
async function warmDvrUrl(run: DvrRun, ch: DvrChannel): Promise<{ url: string; text: string }> {
  return waitFor(
    `${ch.channel}: the DVR playlist lists ${MIN_DVR_SEGMENTS} segments`,
    async () => {
      const s = await grantOf(run.anon(), ch.channel);
      if (!s.dvrPlaylistUrl) return null;
      const res = await fetch(s.dvrPlaylistUrl, { signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      return res.ok && uris(text).length >= MIN_DVR_SEGMENTS ? { url: s.dvrPlaylistUrl, text } : null;
    },
    { timeoutMs: RECORDING_TIMEOUT_MS, intervalMs: 3_000, signal: run.ctx.signal },
  );
}

const uris = (playlist: string) => playlist.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));

const statusOf = async (url: string, init: RequestInit = {}): Promise<number> => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel();
  return res.status;
};

/** `/dvr/<vodId>/<file>` on the origin, for the vod of a DVR playlist URL, with token `t`. */
const dvrFileUrl = (playlistUrl: string, file: string, token?: string) => {
  const u = new URL(file, playlistUrl);
  u.search = "";
  u.searchParams.set("t", token ?? new URL(playlistUrl).searchParams.get("t") ?? "");
  return u.toString();
};

async function withDb<T>(run: DvrRun, fn: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T>): Promise<T> {
  if (!run.databaseUrl) throw new Error("DATABASE_URL is not set");
  const handle = createDb({ url: run.databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

// ------------------------------------------------------------ 1. dvr viewers verify, not live

async function step1(run: DvrRun): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(1, w);
  ctx.assert(t("DATABASE_URL is set (session verdicts)"), run.databaseUrl !== undefined);
  const watchSeconds = ctx.intParam("dvrWatchSeconds", 120);
  const verifySeconds = ctx.intParam("dvrVerifySeconds", 300);
  const behindSeconds = ctx.intParam("dvrBehindSeconds", 60);
  const ch = await ctx.step(t("a live channel with VODs on, recording"), () => run.shared());
  await ctx.step(t("the DVR window has segments"), () => warmDvrUrl(run, ch));
  // Let the recording grow past the rewind distance.
  await ctx.step(t(`the recording passes ${behindSeconds + 20} s`), async () => {
    await waitFor(
      "a long enough recording",
      async () => {
        const s = await grantOf(run.anon(), ch.channel);
        if (!s.dvrPlaylistUrl) return null;
        const text = await (await fetch(s.dvrPlaylistUrl, { signal: AbortSignal.timeout(10_000) })).text();
        return uris(text).length * 4 >= behindSeconds + 20 || null;
      },
      { timeoutMs: (behindSeconds + 120) * 1000, intervalMs: 5_000, signal: ctx.signal },
    );
  });

  const live: Viewer[] = await ctx.step(t("one live viewer"), () => ctx.platform.openViewers(ch.channel, { http: 1 }));
  ctx.defer(() => Promise.allSettled(live.map((v) => v.stop())));
  const dvr = new DvrHttpViewer({ api: run.anon(), channel: ch.channel, behindSeconds, log: ctx.log });
  ctx.defer(() => dvr.stop());
  const started = await ctx.step(t(`a DVR viewer rewinds ${behindSeconds} s`), () => dvr.start());
  ctx.assert(t("the session has a DVR window"), started.dvrWindowSeconds > 0, {
    dvrWindowSeconds: started.dvrWindowSeconds,
  });
  ctx.assert(t("the DVR playlist is on the origin"), started.dvrPlaylistUrl?.startsWith(`${run.origin}/dvr/`) === true);

  if (run.via === "web") await browserScrub(run, ch);

  await ctx.step(t(`the DVR viewer watches ${watchSeconds} s`), () => Bun.sleep(watchSeconds * 1000));
  const sid = dvr.sessionId ?? "";
  const row = await ctx.step(t("the DVR session verifies (scored)"), () =>
    waitFor(
      "the DVR session verified by the scorer",
      () =>
        withDb(run, async (sql) => {
          const [r] = await sql<{ verdict: string; mode: string; dvr: number; scored: boolean }[]>`
            select verdict, playback_mode as mode, dvr_seconds as dvr, scored_at is not null as scored
              from playback_sessions where id = ${sid}`;
          return r && r.verdict === "verified" && r.scored ? r : null;
        }),
      { timeoutMs: verifySeconds * 1000, intervalMs: 5_000, signal: ctx.signal },
    ),
  );
  ctx.check(t("the session is recorded in dvr mode with DVR seconds"), row.mode === "dvr" && row.dvr > 0, row);
  const report = { ...dvr.report, errors: dvr.report.errors.slice(0, 5) };
  ctx.data("dvrViewer", report);
  ctx.check(t("the DVR token was refreshed by heartbeats"), report.dvrTokenRefreshes > 0, report);
  const counts = await ctx.step(t("the public count shows it catching up, not watching live"), () =>
    waitFor(
      "catchingUpCount ≥ 1",
      async () => {
        const c = await run.anon().channels.get({ channel: ch.channel });
        return c.live && (c.live.catchingUpCount ?? 0) >= 1 ? c.live : null;
      },
      { timeoutMs: 60_000, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  const liveVerified = await withDb(run, async (sql) => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from playback_sessions
       where channel_id = ${ch.channelId} and ended_at is null and verdict = 'verified' and playback_mode = 'live'`;
    return r?.n ?? 0;
  });
  ctx.check(t("the live viewer count leaves the DVR session out"), counts.viewerCount <= liveVerified, {
    viewerCount: counts.viewerCount,
    catchingUpCount: counts.catchingUpCount,
    liveVerified,
  });
  await dvr.stop();
}

/** A Chromium viewer rewinds with the scrubber and comes back with "back to live". */
async function browserScrub(run: DvrRun, ch: DvrChannel): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(1, w);
  const s = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label: "w2-dvr",
    log: ctx.log,
  });
  ctx.defer(() => s.close());
  const page = await s.goto(`/${ch.channel}`);
  const player = page.locator('[data-testid="player"]');
  await ctx.step(t("web: the player plays with a DVR window"), async () => {
    await page.locator('[data-testid="player"][data-state="playing"]').waitFor({ timeout: UI_TIMEOUT_MS * 3 });
    const window = Number(await player.getAttribute("data-dvr-window"));
    ctx.assert(t("web: data-dvr-window > 0"), window > 0, { window });
  });
  await ctx.step(t("web: the scrubber goes back a minute (Page Down)"), async () => {
    await player.hover();
    const thumb = page.locator('[data-testid="player-dvr-scrubber"] input[type="range"]');
    await thumb.focus({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press("PageDown");
    await page.locator('[data-testid="player"][data-playback-mode="dvr"]').waitFor({ timeout: UI_TIMEOUT_MS });
    const behind = Number(await page.locator('[data-testid="player-dvr-behind"]').getAttribute("data-seconds"));
    ctx.check(t("web: the readout shows the distance behind live"), behind > 12, { behind });
    ctx.check(
      t("web: the source-quality note shows"),
      (await page.locator('[data-testid="player-dvr-source-note"]').count()) === 1,
    );
  });
  await ctx.step(t("web: back to live"), async () => {
    await player.hover();
    await page.locator('[data-testid="player-dvr-live"]').click({ timeout: UI_TIMEOUT_MS });
    await page.locator('[data-testid="player"][data-playback-mode="live"]').waitFor({ timeout: UI_TIMEOUT_MS });
  });
  await s.close();
}

// ------------------------------------------------------------ 2. in-progress segment refused

async function step2(run: DvrRun): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(2, w);
  const ch = await ctx.step(t("a live channel with VODs on, recording"), () => run.shared());
  const { url, text } = await ctx.step(t("the DVR window has segments"), () => warmDvrUrl(run, ch));
  const newest = uris(text).at(-1) ?? "";
  const listed = await statusOf(new URL(newest, url).toString());
  ctx.assert(t("the newest listed segment plays through /dvr/"), listed === 200 || listed === 206, { listed });
  const next = nextSegmentName(newest);
  ctx.assert(t("the recorder's next segment name is known"), next !== null);
  if (!next || !ch.vodId) return;
  const media = (prefix: string) => `${run.origin}/media/${prefix}/${ch.vodId}/${next}`;
  const results = {
    dvr: await statusOf(dvrFileUrl(url, next)),
    mediaVods: await statusOf(media("vods")),
    mediaRecordings: await statusOf(media("recordings")),
  };
  ctx.assert(
    t("the segment being recorded is 404 through /dvr/ and /media"),
    results.dvr === 404 && results.mediaVods === 404 && results.mediaRecordings === 404,
    results,
  );
  const listedViaMedia = await statusOf(`${run.origin}/media/recordings/${ch.vodId}/${newest.split("?")[0]}`);
  ctx.assert(t("a listed recording segment is 404 through /media too"), listedViaMedia === 404, { listedViaMedia });
}

// ------------------------------------------------------------ 3. removal closes the window

async function step3(run: DvrRun): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(3, w);
  const ch = await ctx.step(t("a live channel with VODs on, recording"), () =>
    run.newChannel("dvr_rm", { vods: true }),
  );
  const { url, text } = await ctx.step(t("the DVR window has segments"), () => warmDvrUrl(run, ch));
  const segment = new URL(uris(text).at(-1) ?? "", url).toString();
  ctx.assert(t("before: the playlist plays"), (await statusOf(url)) === 200);
  if (!ch.vodId) return;
  const vodId = ch.vodId;
  await ctx.step(t("the streamer removes the recording"), () => ch.user.api.client.vods.remove({ id: vodId }));
  const removed = Date.now();
  const elapsed = await ctx.step(t(`/dvr/ answers 404 within ${DVR_CLOSE_WITHIN_MS / 1000} s`), async () => {
    await waitFor(
      "/dvr/ 404 after removal",
      async () => (await statusOf(url)) === 404 && (await statusOf(segment)) === 404,
      { timeoutMs: DVR_CLOSE_WITHIN_MS + DVR_CLOSE_SLACK_MS * 2, intervalMs: 250, signal: ctx.signal },
    );
    return Date.now() - removed;
  });
  ctx.metric("dvrRemovalClosedMs", elapsed, "ms");
  ctx.check(t("closed within the cache TTL (with CI slack)"), elapsed <= DVR_CLOSE_WITHIN_MS + DVR_CLOSE_SLACK_MS, {
    elapsed,
  });
  const after = await grantOf(run.anon(), ch.channel);
  ctx.check(t("a new session gets no DVR for the removed recording"), after.dvrWindowSeconds === 0, {
    dvrWindowSeconds: after.dvrWindowSeconds,
  });
}

// ------------------------------------------------------------ 4. relays refuse dvr

async function step4(run: DvrRun): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(4, w);
  const ch = await ctx.step(t("a live channel with VODs on, recording"), () => run.shared());
  const { url } = await ctx.step(t("the DVR window has segments"), () => warmDvrUrl(run, ch));
  const dvrToken = new URL(url).searchParams.get("t") ?? "";
  const path = new URL(url).pathname;
  // DVR is origin-only (decision 5): the relay and CDN pull routes have no DVR grammar, and a DVR
  // token's path (`dvr/<vodId>`) is outside every relay binding (`live/<slug>`).
  const results = {
    relayPull: await statusOf(`${run.origin}/relay-pull${path}`),
    cdnPull: await statusOf(`${run.origin}/cdn${path}`),
    dvrTokenOnLive: await statusOf(
      `${run.origin}/hls/${mediaPath(ch.channel)}/index.m3u8?t=${encodeURIComponent(dvrToken)}`,
    ),
  };
  ctx.assert(
    t("the origin's relay and CDN pull routes refuse a DVR path; a DVR token opens no live path"),
    [results.relayPull, results.cdnPull].every((s) => s === 401 || s === 403 || s === 404) &&
      (results.dvrTokenOnLive === 401 || results.dvrTokenOnLive === 403),
    results,
  );
  // With the signing key (repo .env), a relay-sourced token for the DVR path is refused too.
  const key = process.env.PLAYBACK_SIGNING_KEY;
  if (!key || !ch.vodId) {
    ctx.skipStep(t("a relay token for dvr/<vodId> is refused"), "PLAYBACK_SIGNING_KEY is not set");
    return;
  }
  const signing = await importSigningKey(key);
  const now = Math.floor(Date.now() / 1000);
  const relayToken = await signPlaybackToken(signing, {
    v: 1,
    sid: uuidv7(),
    cid: ch.channelId,
    path: dvrTokenPath(ch.vodId),
    src: "relay",
    rid: uuidv7(),
    iat: now,
    exp: now + 120,
  });
  const relay = await statusOf(dvrFileUrl(url, "index.m3u8", relayToken));
  ctx.assert(t("a relay token for dvr/<vodId> is refused by /dvr/"), relay === 401, { relay });
}

// ------------------------------------------------------------ 5. subscribers vod refuses a stranger

async function subscribe(run: DvrRun, subscriberId: string, channelId: string): Promise<void> {
  await withDb(
    run,
    (sql) => sql`
      insert into subscriptions (id, subscriber_id, channel_id, tier, status, provider, price_cents, currency,
                                 current_period_end)
      values (${uuidv7()}, ${subscriberId}, ${channelId}, 1, 'active', 'manual', 500, 'usd',
              now() + interval '30 days')`,
  );
}

async function step5(run: DvrRun): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(5, w);
  ctx.assert(t("DATABASE_URL is set (the subscription row)"), run.databaseUrl !== undefined);
  const ch = await ctx.step(t("a live channel with VODs on, recording"), () =>
    run.newChannel("dvr_sub", { vods: true }),
  );
  const [stranger, sub] = await Promise.all([
    ctx.platform.signUp({ prefix: "dvr_n" }),
    ctx.platform.signUp({ prefix: "dvr_u" }),
  ]);
  await ctx.step(t("U subscribes (subscription row)"), () => subscribe(run, sub.me.id, ch.channelId));
  const vodId = ch.vodId ?? "";
  await ctx.step(t("the streamer makes the recording subscribers-only"), () =>
    ch.user.api.client.vods.update({ id: vodId, visibility: "subscribers" }),
  );
  const grants = {
    signedOut: (await grantOf(run.anon(), ch.channel)).dvrWindowSeconds,
    stranger: (await grantOf(stranger.api.client, ch.channel)).dvrWindowSeconds,
    subscriber: (await grantOf(sub.api.client, ch.channel)).dvrWindowSeconds,
    owner: (await grantOf(ch.user.api.client, ch.channel)).dvrWindowSeconds,
  };
  ctx.assert(
    t("no DVR for a stranger or a signed-out viewer"),
    grants.stranger === 0 && grants.signedOut === 0,
    grants,
  );
  ctx.assert(t("DVR for the subscriber and the owner"), grants.subscriber > 0 && grants.owner > 0, grants);
}

// ------------------------------------------------------------ 6. data-mode token refused

async function step6(run: DvrRun): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(6, w);
  const ch = await ctx.step(t("a live channel with VODs on, recording"), () => run.shared());
  const { url } = await ctx.step(t("the DVR window has segments"), () => warmDvrUrl(run, ch));
  const api = run.anon();
  const s = await api.playback.start({
    channel: ch.channel,
    deviceId: newDeviceId(),
    nativeHls: false,
    p2pCapable: false,
    embed: false,
    dataMode: dataModeCeilingBps(800),
  });
  ctx.defer(() => api.playback.end({ sessionId: s.sessionId, token: s.token }).catch(() => undefined));
  ctx.assert(t("a data-mode session gets no DVR"), s.dvrWindowSeconds === 0 && s.dvrPlaylistUrl === null, {
    dvrWindowSeconds: s.dvrWindowSeconds,
  });
  ctx.assert(t("the session's token carries dm"), s.dataMode !== null);
  const refused = await statusOf(dvrFileUrl(url, "index.m3u8", s.token));
  ctx.assert(t("its dm token is refused by /dvr/"), refused === 401, { refused });
}

// ------------------------------------------------------------ 7. vods off means no dvr

async function step7(run: DvrRun): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => dvrTitle(7, w);
  const ch = await ctx.step(t("a live channel with VODs off"), () => run.newChannel("dvr_novod", { vods: false }));
  const s = await grantOf(run.anon(), ch.channel);
  ctx.assert(
    t("dvrWindowSeconds is 0 and there is no DVR playlist"),
    s.dvrWindowSeconds === 0 && s.dvrPlaylistUrl === null,
    {
      dvrWindowSeconds: s.dvrWindowSeconds,
    },
  );
  if (run.via !== "web") return;
  await ctx.step(t("web: the player shows no DVR controls"), async () => {
    const web = await WebSession.open({
      fleet: ctx.platform.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: (await playerBundles()).probe,
      label: "w2-dvr-novod",
      log: ctx.log,
    });
    ctx.defer(() => web.close());
    const page = await web.goto(`/${ch.channel}`);
    await page.locator('[data-testid="player"][data-state="playing"]').waitFor({ timeout: UI_TIMEOUT_MS * 3 });
    const window = await page.locator('[data-testid="player"]').getAttribute("data-dvr-window");
    ctx.assert(t('web: data-dvr-window="0"'), window === "0", { window });
    ctx.assert(t("web: no scrubber"), (await page.locator('[data-testid="player-dvr-scrubber"]').count()) === 0);
    await web.close();
  });
}

export const DVR_STEP_RUNNERS: Readonly<Record<DvrStep, (run: DvrRun) => Promise<void>>> = {
  1: step1,
  2: step2,
  3: step3,
  4: step4,
  5: step5,
  6: step6,
  7: step7,
};
