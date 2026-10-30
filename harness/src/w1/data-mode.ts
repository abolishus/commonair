// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` extension `data-mode` (docs/testing/w1-selectors.md, "Scenarios"; ADR 0018
 * decision 8): a throttled Chromium viewer and a WebKit viewer open the scenario's channel, turn
 * data saver on and pick the Audio preset in the UI. Each must then play audio only (the origin's
 * filtered playlist has no video variant under the ~97 kbit/s ceiling), keep the meter within the
 * estimate + 20 %, stay on the origin, and end up verified and gate-eligible: data mode changes
 * the expected rates, never the evidence a session needs.
 *
 * Throttling. Chromium is shaped through CDP (`Network.emulateNetworkConditions`) once the Audio
 * preset is chosen, so the page itself loads at full speed. The brief asks for 64 kbit/s, but no
 * variant plays in real time through that: the scenario's test pattern sends 160 kbit/s AAC and,
 * below the transcode threshold, the floor is the source's own audio (the ladder's audio rung is
 * 96 kbit/s). A session that plays less than half of wall-clock time never verifies (the interim
 * check, services/api/src/playback/verify.ts), so the default is 256 kbit/s, which fits the audio
 * and its playlists; `--set dataModeKbps=64` runs the brief's figure and is expected to stall.
 * WebKit cannot be shaped through CDP and the harness proxy does not shape bandwidth, so the
 * WebKit viewer is unthrottled: for it only audio-only, the origin and verification are asserted
 * (and the meter when WebKit reports bytes; native HLS downloads out of the page's sight).
 *
 * Parameters: `--set dataModeKbps=256 --set dataModeWatchSeconds=60 --set dataModeVerifySeconds=240`.
 */
import { dataModeCeilingBps } from "@commonair/contracts/enums";
import type { Page, Request } from "playwright";
import { WEB_PLAYBACK_START_PATH, sessionIdFromRpcStart, type BrowserEngine } from "../browser-viewer.ts";
import { playerBundles } from "../player-server.ts";
import { sleep, waitFor } from "../wait.ts";
import { WebSession } from "../web/session.ts";
import type { IntegrityExtension } from "./kit.ts";
import { W1_ROUTES, W1_TEST_IDS as W, byW1Id } from "./selectors.ts";
import { extensionTitle } from "./steps.ts";

/** The Audio preset's budget (MB an hour) and the ceiling the player's token must carry. */
export const AUDIO_BUDGET_MB = 50;
export const AUDIO_CEILING_BPS = dataModeCeilingBps(AUDIO_BUDGET_MB);
/** How far the meter may run above the estimate (decision 1: the meter shows what is spent). */
export const METER_TOLERANCE = 0.2;
export const DEFAULT_THROTTLE_KBPS = 256;

const UI_TIMEOUT_MS = 30_000;
const PLAYING_TIMEOUT_MS = 90_000;
const APPLIED_TIMEOUT_MS = 60_000;

const title = (what: string) => extensionTitle("data-mode", what);

/** CDP `Network.emulateNetworkConditions` for a link of `kbps` kilobit/s each way. */
export function throttleConditions(kbps: number): {
  offline: false;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
} {
  const bytesPerSecond = Math.max(1, Math.round((kbps * 1000) / 8));
  return { offline: false, latency: 150, downloadThroughput: bytesPerSecond, uploadThroughput: bytesPerSecond };
}

/**
 * A request for video media: a video segment, part or init section (MediaMTX names them
 * `<id>_video<n>_…`), or anything under a video rendition directory. Playlists do not count.
 */
export function isVideoMediaUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (!/\.(mp4|m4s|ts)$/.test(path)) return false;
  return /_video\d*_/.test(path) || /\/(480p|720p|1080p)\//.test(path);
}

/** Whether the meter's rate is within the estimate plus the tolerance (both MB an hour). */
export function meterWithinEstimate(meter: number, estimate: number, tolerance = METER_TOLERANCE): boolean {
  return Number.isFinite(meter) && Number.isFinite(estimate) && estimate > 0 && meter <= estimate * (1 + tolerance);
}

/** What the page shows once the step has watched for a while. */
export interface DataModeReading {
  engine: BrowserEngine;
  sessionIds: string[];
  /** `data-data-mode` on the player. */
  ceiling: string | null;
  source: string | null;
  /** The video element's picture size (0 when audio only). */
  videoWidth: number;
  /** Seconds of media played while the step watched. */
  playedSeconds: number;
  /** Video media requests the page made after the ceiling applied (CDP-visible requests only). */
  videoRequests: string[];
  mediaRequests: number;
  meter: { bytes: number; mbPerHour: number } | null;
  estimateMbPerHour: number | null;
}

interface Watcher {
  engine: BrowserEngine;
  page: Page;
  sessionIds: string[];
  /** Media requests after the ceiling applied (null until then). */
  requests: string[] | null;
}

async function openViewer(ext: IntegrityExtension, engine: BrowserEngine, sessions: WebSession[]): Promise<Watcher> {
  const { ctx } = ext;
  const s = await WebSession.open({
    fleet: ext.platform.fleet,
    engine,
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label: `w1-data-mode-${engine}`,
    log: ctx.log,
  });
  sessions.push(s);
  const page = await s.page();
  const w: Watcher = { engine, page, sessionIds: [], requests: null };
  page.on("response", (res) => {
    if (!res.ok() || new URL(res.url()).pathname !== WEB_PLAYBACK_START_PATH) return;
    res
      .json()
      .then((body: unknown) => {
        const id = sessionIdFromRpcStart(body);
        if (id && !w.sessionIds.includes(id)) w.sessionIds.push(id);
      })
      .catch(() => undefined);
  });
  page.on("request", (req: Request) => {
    if (w.requests && /\.(mp4|m4s|ts)(\?|$)/.test(req.url())) w.requests.push(req.url());
  });
  await s.goto(W1_ROUTES.channel(ext.channel));
  return w;
}

/** Turn data saver on and pick the Audio preset through the UI; wait until the token carries it. */
async function chooseAudio(w: Watcher, ext: IntegrityExtension, throttleKbps: number | null): Promise<void> {
  const { page } = w;
  const toggle = byW1Id(page, W.dataModeToggle);
  await toggle.waitFor({ timeout: UI_TIMEOUT_MS });
  if ((await toggle.getAttribute("data-state")) !== "on") await toggle.click({ timeout: UI_TIMEOUT_MS });
  await byW1Id(page, W.dataModeToggle, { state: "on" }).waitFor({ timeout: UI_TIMEOUT_MS });
  await byW1Id(page, W.dataModeBudget50).click({ timeout: UI_TIMEOUT_MS });
  if (throttleKbps !== null) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", throttleConditions(throttleKbps));
  }
  // The next heartbeat carries the ceiling; the player reloads on the token that has it.
  await byW1Id(page, W.player, { "data-mode": String(AUDIO_CEILING_BPS) }).waitFor({
    timeout: APPLIED_TIMEOUT_MS,
  });
  await byW1Id(page, W.player, { state: "playing" }).waitFor({ timeout: PLAYING_TIMEOUT_MS });
  // Recorded from here: loads the reload cancelled can still finish just before it.
  w.requests = [];
  ext.ctx.log.info("data mode applied", { engine: w.engine, sessions: w.sessionIds });
}

async function read(w: Watcher, playedBefore: number): Promise<DataModeReading> {
  const { page } = w;
  const player = byW1Id(page, W.player);
  const video = await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="player-video"]');
    return { width: v?.videoWidth ?? 0, time: v?.currentTime ?? 0 };
  });
  const usage = byW1Id(page, W.dataUsage);
  const bytes = await usage.getAttribute("data-bytes").catch(() => null);
  const rate = await usage.getAttribute("data-mb-per-hour").catch(() => null);
  const estimate = await byW1Id(page, W.dataModeEstimate)
    .getAttribute("data-mb-per-hour", { timeout: 2_000 })
    .catch(() => null);
  const requests = w.requests ?? [];
  return {
    engine: w.engine,
    sessionIds: [...w.sessionIds],
    ceiling: await player.getAttribute("data-data-mode"),
    source: await player.getAttribute("data-source"),
    videoWidth: video.width,
    playedSeconds: Math.max(0, video.time - playedBefore),
    videoRequests: requests.filter(isVideoMediaUrl),
    mediaRequests: requests.length,
    meter: bytes !== null && rate !== null ? { bytes: Number(bytes), mbPerHour: Number(rate) } : null,
    estimateMbPerHour: estimate === null ? null : Number(estimate),
  };
}

interface VerdictRow {
  id: string;
  verdict: string;
  verdict_reasons: string[] | null;
  assigned_source: string;
  scored: boolean;
}

async function verdicts(url: string, ids: readonly string[]): Promise<VerdictRow[]> {
  if (ids.length === 0) return [];
  const sql = new Bun.SQL(url);
  try {
    return (await sql`
      select id, verdict::text as verdict, verdict_reasons, assigned_source::text as assigned_source,
             scored_at is not null as scored
        from playback_sessions where id = any(${sql.array([...ids], "uuid")})`) as VerdictRow[];
  } finally {
    await sql.close();
  }
}

export async function stepThrottledViewer(ext: IntegrityExtension): Promise<void> {
  const { ctx } = ext;
  const kbps = ctx.intParam("dataModeKbps", DEFAULT_THROTTLE_KBPS);
  const watchMs = ctx.intParam("dataModeWatchSeconds", 60) * 1000;
  const verifyMs = ctx.intParam("dataModeVerifySeconds", 240) * 1000;
  ctx.data("dataMode.throttleKbps", kbps);

  const sessions: WebSession[] = [];
  ctx.defer(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
  });
  const watchers = await ctx.step(title("open a Chromium and a WebKit viewer on the channel page"), () =>
    Promise.all([openViewer(ext, "chromium", sessions), openViewer(ext, "webkit", sessions)]),
  );
  await ctx.step(title(`choose the Audio preset in the UI (Chromium throttled to ${kbps} kbit/s)`), () =>
    Promise.all(watchers.map((w) => chooseAudio(w, ext, w.engine === "chromium" ? kbps : null))),
  );
  const before = await Promise.all(
    watchers.map((w) =>
      w.page.evaluate(() => document.querySelector<HTMLVideoElement>('[data-testid="player-video"]')?.currentTime ?? 0),
    ),
  );
  await ctx.step(title(`watch for ${watchMs / 1000} s`), () => sleep(watchMs, ctx.signal));
  const readings = await ctx.step(title("read the players"), () =>
    Promise.all(watchers.map((w, i) => read(w, before[i] ?? 0))),
  );
  ctx.data("dataMode.readings", readings);

  for (const r of readings) {
    const label = r.engine;
    ctx.assert(title(`${label}: the token carries the Audio ceiling`), r.ceiling === String(AUDIO_CEILING_BPS), r);
    ctx.assert(title(`${label}: the session is on the origin`), r.source === "origin", r);
    const evidence = {
      videoWidth: r.videoWidth,
      videoRequests: r.videoRequests.slice(0, 5),
      mediaRequests: r.mediaRequests,
    };
    ctx.assert(title(`${label}: plays audio only (no picture)`), r.videoWidth === 0, evidence);
    // "No video media requested" only proves something when the page saw media requests at all:
    // native HLS (AVFoundation) may fetch outside what Playwright observes, so WebKit can see none.
    if (r.mediaRequests > 0) {
      ctx.assert(title(`${label}: no video media requested`), r.videoRequests.length === 0, evidence);
    } else if (label === "chromium") {
      ctx.assert(title("chromium: media requests are observed"), false, evidence);
    } else {
      ctx.skipStep(title(`${label}: no video media requested`), "the browser's native HLS fetches are not observable");
    }
    ctx.check(title(`${label}: playback moved while watched`), r.playedSeconds > watchMs / 1000 / 2, r);
    if (r.meter === null || r.estimateMbPerHour === null) {
      if (label === "chromium") ctx.assert(title("chromium: the meter and the estimate are shown"), false, r);
      else ctx.skipStep(title(`${label}: meter within the estimate`), "the browser does not report native HLS bytes");
      continue;
    }
    ctx.metric(`data_mode.${label}.meter`, r.meter.mbPerHour, "MB/h");
    ctx.metric(`data_mode.${label}.estimate`, r.estimateMbPerHour, "MB/h");
    ctx.assert(title(`${label}: the meter moves`), r.meter.bytes > 0 && r.meter.mbPerHour > 0, r.meter);
    ctx.assert(
      title(`${label}: the meter stays within the estimate + ${METER_TOLERANCE * 100} %`),
      meterWithinEstimate(r.meter.mbPerHour, r.estimateMbPerHour),
      { meter: r.meter, estimate: r.estimateMbPerHour },
    );
  }

  const url = ext.databaseUrl;
  if (!url) {
    ctx.skipStep(title("sessions verified and gate-eligible"), "DATABASE_URL is not set for the harness");
    return;
  }
  // The last session of each viewer is the one playing (a retry after an error starts another).
  const ids = readings.map((r) => r.sessionIds.at(-1)).filter((id): id is string => id !== undefined);
  ctx.assert(title("both viewers' sessions were seen"), ids.length === watchers.length, { ids });
  const rows = await ctx.step(title("both sessions scored verified"), () =>
    waitFor(
      "data-mode sessions verified and scored",
      async () => {
        const r = await verdicts(url, ids);
        return r.length === ids.length && r.every((row) => row.verdict === "verified" && row.scored) ? r : null;
      },
      { timeoutMs: verifyMs, intervalMs: 5_000, signal: ctx.signal },
    ).catch(async (err: unknown) => {
      ctx.data("dataMode.verdicts", await verdicts(url, ids).catch(() => []));
      throw err;
    }),
  );
  ctx.data("dataMode.verdicts", rows);
  for (const row of rows) {
    const engine = readings.find((r) => r.sessionIds.includes(row.id))?.engine ?? row.id;
    ctx.assert(title(`${engine}: recorded as an origin session`), row.assigned_source === "origin", row);
    ctx.assert(
      title(`${engine}: gate-eligible (fetch-judged, not fetch_unjudged)`),
      !(row.verdict_reasons ?? []).includes("fetch_unjudged"),
      row,
    );
  }
}
