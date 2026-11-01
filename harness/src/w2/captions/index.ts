// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `captions` steps 1–8 (docs/testing/w2-selectors.md, "Scenarios"; ADR 0011) and their run state.
 *
 * Steps 1–4 and 8 read one speaking stream (`speech()`, started once and shared): captions on,
 * VODs on, one mask word from the reference transcript. The follower polls its subtitle playlist
 * and records when each segment first appears; a Chromium viewer turns CC on in the web player.
 * Steps 5–7 each set up their own streamers. Every step creates its own users (named things get
 * their own actors). The stack runs with `CAPTIONS_MAX_STREAMS=1` (`harness/compose.w2-captions.yaml`).
 */
import { setTimeout as delay } from "node:timers/promises";
import {
  CAPTIONS_LATENCY_SECONDS,
  MASK_TOKEN,
  parseVtt,
  SEGMENT_MS,
  unescapeCueText,
  wordErrorRate,
} from "@commonair/captions";
import { createDb } from "@commonair/db";
import type { ProbeVideoStats } from "../../../player/probe.ts";
import { REFERENCE_PATH, generateSpeechFixture } from "./fixture.ts";
import { resolveUri } from "../../hls.ts";
import type { Via } from "../../money.ts";
import { playerBundles } from "../../player-server.ts";
import type { ScenarioContext } from "../../scenario.ts";
import { rtmpPublishUrl } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import { waitFor } from "../../wait.ts";
import { WebSession, waitForHydration } from "../../web/session.ts";
import type { CaptionsStep } from "../steps.ts";
import {
  lateSegments,
  listedSegments,
  misplacedCues,
  segmentCues,
  subtitleAdvert,
  timedSegments,
  transcriptOf,
  type PlacementSample,
  type SeenSegment,
  type SubtitleAdvert,
} from "./live.ts";
import { startSpeechStream, type SpeechStream } from "./publisher.ts";

/**
 * The WER the live pipeline must stay under on the fixture (ADR 0011, History 2026-11-01).
 *
 * Measured with the pinned whisper.cpp build and `ggml-base-q5_1` on this eSpeak NG fixture, cut
 * into 3 s chunks the way the worker cuts them (AAC round trip included): one pass scores 0.18 to
 * 0.40 depending on where the chunk edges fall against the words, three passes 0.30 to 0.33, and
 * the same audio sent whole 0.08. The gap is the model on synthetic speech with 3 s of context,
 * not the pipeline: the stored cues score the same as whisper's raw segments joined. The stream
 * speaks the fixture `SPEECH_LOOPS` times (34.3 s is not a multiple of 3, so each pass meets the
 * chunk grid at a different phase), which takes the luck of one phase out; 0.40 sits above that
 * spread and below a pipeline that loses or repeats chunks (one chunk in ten adds about 0.1).
 */
export const MAX_WER = 0.4;
/** Times the shared stream speaks the fixture (each pass at a different chunk phase). */
export const SPEECH_LOOPS = 3;
/** A segment must be listed before a captions-on player's playhead (held this far behind live) reaches it. */
export const CUE_DEADLINE_MS = CAPTIONS_LATENCY_SECONDS * 1000;
/** Segments with cues the follower must see listed after its first poll, for the timing gate to mean anything. */
export const MIN_TIMED_SEGMENTS = 3;
/** Browser samples with an active cue the placement check needs. */
export const MIN_PLACEMENT_SAMPLES = 3;
/**
 * Slack on cue placement: the strip is sampled once a second, and the frame's capture clock
 * (publisher) and the PDT (MediaMTX arrival) differ by the ingest path. A timeline offset bug is
 * whole seconds (10 s for MediaMTX's), well past this.
 */
export const PLACEMENT_TOLERANCE_MS = 2_500;
/** The word masked in the shared stream (it is in the reference transcript). */
export const MASK_WORD = "harbor";
const ACTIVE_TIMEOUT_MS = 90_000;
const VOD_READY_TIMEOUT_MS = 5 * 60_000;
const UI_TIMEOUT_MS = 30_000;

export interface SpeechRun {
  channel: string;
  streamer: SignedInUser;
  advert: SubtitleAdvert;
  /** Segments seen, in order, with first-seen times and cues. */
  segments: SeenSegment[];
  /** What the Chromium viewer's `video.textTracks` showed with CC on. */
  browser: {
    showing: boolean;
    cues: number;
    activeSeen: boolean;
    state: string | null;
    /** Active cues against the capture time of the frame under the playhead, once a second. */
    placements: PlacementSample[];
  };
}

export interface CaptionsRun {
  ctx: ScenarioContext;
  via: Via;
  reference: string;
  audioPath: string;
  speech(): Promise<SpeechRun>;
}

const deviceId = () => `captions-${crypto.randomUUID()}`;

/** A streamer whose channel captions its streams. */
async function captionedChannel(
  ctx: ScenarioContext,
  prefix: string,
  opts: { vod: boolean; maskWords?: string[] },
): Promise<{ user: SignedInUser; channel: string }> {
  const user = await ctx.platform.signUp({ prefix });
  const channel = user.me.channelSlug ?? user.username;
  await user.api.client.channels.update({ channel, vodEnabled: opts.vod });
  await user.api.client.channels.updateMediaSettings({
    channel,
    captions: { enabled: true, maskWords: opts.maskWords ?? [] },
  });
  return { user, channel };
}

async function goLive(
  ctx: ScenarioContext,
  run: Pick<CaptionsRun, "audioPath">,
  user: SignedInUser,
  channel: string,
  opts: { loops?: number } = {},
): Promise<SpeechStream> {
  const { key } = await user.api.client.stream.rotateKey({ channel });
  const stream = startSpeechStream(
    { url: rtmpPublishUrl(ctx.env.HARNESS_RTMP_URL, key), audioPath: run.audioPath, loops: opts.loops },
    `captions-${channel}`,
  );
  ctx.defer(() => stream.stop());
  await ctx.platform.waitForLive(channel, true, 60_000);
  return stream;
}

/** A fresh playback session (anonymous): what a viewer would get now. */
async function playback(ctx: ScenarioContext, channel: string) {
  return ctx.platform.api().client.playback.start({ channel, deviceId: deviceId() });
}

async function waitForCaptionsState(
  ctx: ScenarioContext,
  channel: string,
  state: "active" | "queued" | "off",
  timeoutMs = ACTIVE_TIMEOUT_MS,
) {
  return waitFor(
    `${channel} captions ${state}`,
    async () => {
      const p = await playback(ctx, channel);
      return p.captionsState === state ? p : null;
    },
    { timeoutMs, intervalMs: 2_000, signal: ctx.signal },
  );
}

/** The multivariant playlist's SUBTITLES group, once the origin advertises it. */
async function waitForAdvert(ctx: ScenarioContext, playlistUrl: string): Promise<SubtitleAdvert> {
  return waitFor(
    "SUBTITLES in the multivariant playlist",
    async () => {
      const res = await fetch(playlistUrl);
      return res.ok ? subtitleAdvert(await res.text()) : null;
    },
    { timeoutMs: ACTIVE_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
  );
}

/** Polls the subtitle playlist every second until `until` resolves; records each segment once. */
async function followSubtitles(ctx: ScenarioContext, url: string, until: Promise<unknown>): Promise<SeenSegment[]> {
  const seen = new Map<number, SeenSegment>();
  let first = true;
  let done = false;
  void until.finally(() => (done = true));
  while (!done && !ctx.signal.aborted) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const now = Date.now();
        const baseline = first;
        first = false;
        for (const s of listedSegments(await res.text())) {
          if (seen.has(s.sequence) || s.pdtMs === null) continue;
          const vtt = await fetch(resolveUri(s.uri, url));
          seen.set(s.sequence, {
            sequence: s.sequence,
            pdtMs: s.pdtMs,
            firstSeenAt: now,
            baseline,
            cues: vtt.ok ? segmentCues(await vtt.text()) : [],
          });
        }
      }
    } catch (err) {
      ctx.log.warn("subtitle playlist poll failed", { error: (err as Error).message });
    }
    await delay(1_000, undefined, { signal: ctx.signal }).catch(() => undefined);
  }
  return [...seen.values()].sort((a, b) => a.sequence - b.sequence);
}

/** A Chromium viewer on the channel page turns CC on and reads `video.textTracks`. */
async function browserViewer(ctx: ScenarioContext, channel: string): Promise<SpeechRun["browser"]> {
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label: "captions-viewer",
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const page = await session.goto(`/${channel}`);
  await waitForHydration(page);
  const toggle = page.locator('[data-testid="player-captions-toggle"]');
  await toggle.waitFor({ timeout: ACTIVE_TIMEOUT_MS });
  await toggle.click({ timeout: UI_TIMEOUT_MS });
  const state = await toggle.getAttribute("data-state");
  const read = () =>
    page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="player-video"]');
      const tracks = v ? [...v.textTracks].filter((t) => t.mode === "showing") : [];
      const activeTexts: string[] = [];
      for (const t of tracks) for (const c of t.activeCues ?? []) if (c instanceof VTTCue) activeTexts.push(c.text);
      // The probe's newest glass-to-glass sample for this video: now minus it is the capture
      // time of the frame on screen (both read on the page clock, the strip on the publisher's).
      const stats = (window.__harnessProbe?.snapshot() ?? []).filter((s: ProbeVideoStats) => s.latencyMs.length > 0);
      const mine = v ? (stats.find((s) => Math.abs(s.currentTime - v.currentTime) < 1.5) ?? stats[0]) : undefined;
      const latency = mine?.latencyMs.at(-1);
      return {
        showing: tracks.length > 0,
        cues: tracks.reduce((n, t) => n + (t.cues?.length ?? 0), 0),
        activeTexts,
        playheadWallMs: latency === undefined ? null : Date.now() - latency,
      };
    });
  let activeSeen = false;
  const placements: PlacementSample[] = [];
  const sample = async () => {
    const r = await read();
    activeSeen ||= r.activeTexts.length > 0;
    if (r.activeTexts.length > 0 && r.playheadWallMs !== null)
      placements.push({ playheadWallMs: r.playheadWallMs, activeTexts: r.activeTexts.map(unescapeCueText) });
    return r;
  };
  // Keep sampling until enough placements are in (or the time runs out), so one lucky cue does not decide it.
  const last = await waitFor(
    "cues in the player's text track, placed against the video",
    async () => {
      const r = await sample();
      return r.cues > 0 && placements.length >= MIN_PLACEMENT_SAMPLES ? r : null;
    },
    { timeoutMs: ACTIVE_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
  ).catch(async () => read());
  return { showing: last.showing, cues: last.cues, activeSeen, state, placements };
}

export async function newCaptionsRun(ctx: ScenarioContext, opts: { via: Via }): Promise<CaptionsRun> {
  const audioPath = await ctx.step("captions fixture: speech over a test pattern", () => generateSpeechFixture());
  const reference = (await Bun.file(REFERENCE_PATH).text()).trim();
  let speech: Promise<SpeechRun> | null = null;
  const run: CaptionsRun = {
    ctx,
    via: opts.via,
    reference,
    audioPath,
    speech: () => (speech ??= sharedSpeech(run)),
  };
  return run;
}

/** One speaking stream, VODs on, `MASK_WORD` masked; followed live and by a browser viewer. */
async function sharedSpeech(run: CaptionsRun): Promise<SpeechRun> {
  const { ctx } = run;
  const { user, channel } = await ctx.step("captions: streamer S with captions and VODs on, a mask word", () =>
    captionedChannel(ctx, "w2cap_s", { vod: true, maskWords: [MASK_WORD] }),
  );
  ctx.data("speechChannel", channel);
  const stream = await ctx.step("captions: S streams the speech fixture", () =>
    goLive(ctx, run, user, channel, { loops: SPEECH_LOOPS }),
  );
  const start = await ctx.step("captions: the track is active", () => waitForCaptionsState(ctx, channel, "active"));
  const advert = await ctx.step("captions: the multivariant playlist advertises it", () =>
    waitForAdvert(ctx, start.playlistUrl),
  );
  const subtitles = resolveUri(advert.uri, start.playlistUrl);
  const [segments, browser] = await ctx.step("captions: follow the subtitle playlist and a Chromium viewer", () =>
    Promise.all([
      followSubtitles(
        ctx,
        subtitles,
        stream.exited.then(() => delay(8_000)),
      ),
      browserViewer(ctx, channel),
    ]),
  );
  await ctx.step("captions: S's stream ends", async () => {
    await stream.stop();
    await ctx.platform.waitForLive(channel, false, 60_000);
  });
  ctx.data("speechSegments", segments.length);
  return { channel, streamer: user, advert, segments, browser };
}

async function trackRow(ctx: ScenarioContext, channel: string) {
  const url = ctx.env.DATABASE_URL;
  if (!url) return undefined;
  const handle = createDb({ url, max: 1, applicationName: "commonair-harness" });
  try {
    const rows = await handle.sql<{ status: string; cue_count: number; storage_key: string | null }[]>`
      select t.status::text as status, t.cue_count, t.storage_key
        from broadcast_caption_tracks t
        join broadcasts b on b.id = t.broadcast_id
        join channels c on c.id = b.channel_id
       where c.slug = ${channel}
       order by t.created_at desc
       limit 1`;
    return rows[0] ?? null;
  } finally {
    await handle.close();
  }
}

// ------------------------------------------------------------------ steps

async function subtitlesAdvertised(run: CaptionsRun): Promise<void> {
  const { advert } = await run.speech();
  run.ctx.data("advert", advert);
  run.ctx.assert("a SUBTITLES group with a URI", advert.uri.length > 0, advert);
  run.ctx.assert(
    "not default and not autoselected (captions are the viewer's choice)",
    !advert.isDefault && !advert.autoselect,
  );
  run.ctx.assert("every variant names the group", advert.onEveryVariant, { variants: advert.variants });
}

/** What the shared stream says: the reference once per loop. */
export const spokenReference = (reference: string, loops: number): string =>
  Array.from({ length: Math.max(1, loops) }, () => reference.trim()).join(" ");

async function werBelowThreshold(run: CaptionsRun): Promise<void> {
  const { segments } = await run.speech();
  // The mask token stands for one word that was said; compare it as the masked word.
  const hypothesis = transcriptOf(segments).replaceAll(MASK_TOKEN, MASK_WORD);
  const wer = wordErrorRate(spokenReference(run.reference, SPEECH_LOOPS), hypothesis);
  run.ctx.metric("captions_wer", wer);
  run.ctx.data("transcript", hypothesis);
  run.ctx.assert(`WER ${wer.toFixed(3)} < ${MAX_WER}`, wer < MAX_WER, { wer });
}

async function cueTiming(run: CaptionsRun): Promise<void> {
  const { segments, browser } = await run.speech();
  const withCues = segments.filter((s) => s.cues.length > 0);
  run.ctx.assert("the follower saw segments with cues", withCues.length > 0, { segments: segments.length });
  // Segments already listed when the follower started measure the harness's start-up, not the pipeline.
  const timed = timedSegments(segments);
  run.ctx.assert(
    `at least ${MIN_TIMED_SEGMENTS} segments with cues listed while the follower watched`,
    timed.length >= MIN_TIMED_SEGMENTS,
    { timed: timed.length, baseline: segments.filter((s) => s.baseline).length },
  );
  const late = lateSegments(segments, CUE_DEADLINE_MS);
  const margins = timed.map((s) => s.pdtMs + CUE_DEADLINE_MS - s.firstSeenAt);
  if (margins.length > 0) run.ctx.metric("captions_cue_margin_min_ms", Math.min(...margins), "ms");
  run.ctx.assert(
    `every cue listed before the playhead reaches it at ${CUE_DEADLINE_MS / 1000} s latency`,
    late.length === 0,
    { late: late.map((s) => ({ sequence: s.sequence, lateByMs: s.firstSeenAt - s.pdtMs - CUE_DEADLINE_MS })) },
  );
  run.ctx.data("browser", browser);
  run.ctx.assert("the CC toggle turned on (player-captions-toggle data-state=on)", browser.state === "on");
  run.ctx.assert("the Chromium viewer's video.textTracks shows cues", browser.showing && browser.cues > 0, browser);
  run.ctx.assert("a cue was active under the playhead (with the frame's capture time)", browser.placements.length > 0, {
    activeSeen: browser.activeSeen,
  });
  const misplaced = misplacedCues(browser.placements, segments, SEGMENT_MS, PLACEMENT_TOLERANCE_MS);
  run.ctx.metric("captions_placement_samples", browser.placements.length);
  run.ctx.assert("every active cue sits on the video where its segment's PDT says", misplaced.length === 0, {
    misplaced: misplaced.slice(0, 5),
  });
}

async function vodCaptions(run: CaptionsRun): Promise<void> {
  const { ctx } = run;
  const { channel, streamer } = await run.speech();
  const vod = await waitFor(
    "the VOD ready with captions",
    async () => {
      const page = await streamer.api.client.vods.list({ channel, limit: 5 });
      const v = page.items[0];
      return v?.status === "ready" && v.captions.length > 0 ? v : null;
    },
    { timeoutMs: VOD_READY_TIMEOUT_MS, intervalMs: 3_000, signal: ctx.signal },
  );
  const track = vod.captions[0];
  ctx.assert("one ready caption track on the VOD", vod.captions.length === 1 && track !== undefined, vod.captions);
  if (!track) return;
  const res = await fetch(track.url);
  const parsed = res.ok ? parseVtt(await res.text()) : null;
  ctx.assert("its WebVTT is served and has cues", (parsed?.cues.length ?? 0) > 0, { status: res.status });
  const cues = await streamer.api.client.vods.captions.get({ id: vod.id, language: track.language });
  ctx.assert("vods.captions.get returns the cues", cues.status === "ready" && cues.cues.length > 0);
  ctx.assert(
    "the VOD track keeps the mask",
    cues.cues.every((c) => !c.text.toLowerCase().includes(MASK_WORD)),
  );
}

async function queuedAtCap(run: CaptionsRun): Promise<void> {
  const { ctx } = run;
  const a = await captionedChannel(ctx, "w2cap_qa", { vod: false });
  const b = await captionedChannel(ctx, "w2cap_qb", { vod: false });
  const streamA = await goLive(ctx, run, a.user, a.channel, { loops: 4 });
  await waitForCaptionsState(ctx, a.channel, "active");
  const streamB = await goLive(ctx, run, b.user, b.channel, { loops: 4 });
  // CAPTIONS_MAX_STREAMS=1: B waits for A's slot.
  await waitForCaptionsState(ctx, b.channel, "queued", 30_000);
  if (run.via === "web") {
    const session = await WebSession.open({
      fleet: ctx.platform.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: (await playerBundles()).probe,
      label: "captions-queued-viewer",
      log: ctx.log,
    });
    ctx.defer(() => session.close());
    const page = await session.goto(`/${b.channel}`);
    await page.locator('[data-testid="player-captions-queued"]').waitFor({ timeout: UI_TIMEOUT_MS });
  }
  await streamA.stop();
  await ctx.platform.waitForLive(a.channel, false, 60_000);
  await waitForCaptionsState(ctx, b.channel, "active", 60_000);
  await streamB.stop();
}

async function noTranscriptWithoutVods(run: CaptionsRun): Promise<void> {
  const { ctx } = run;
  const { user, channel } = await captionedChannel(ctx, "w2cap_nv", { vod: false });
  const stream = await goLive(ctx, run, user, channel);
  await waitForCaptionsState(ctx, channel, "active");
  await stream.exited;
  await ctx.platform.waitForLive(channel, false, 60_000);
  const row = await waitFor(
    "the track ended",
    async () => {
      const r = await trackRow(ctx, channel);
      return r === undefined || (r && r.status !== "active")
        ? (r ?? { status: "unknown", cue_count: 0, storage_key: null })
        : null;
    },
    { timeoutMs: 60_000, intervalMs: 2_000, signal: ctx.signal },
  );
  ctx.check("DATABASE_URL is set (track row check)", ctx.env.DATABASE_URL !== undefined);
  if (ctx.env.DATABASE_URL)
    ctx.assert(
      "the transcript was dropped (status deleted, no object)",
      row.status === "deleted" && row.storage_key === null,
      row,
    );
  const vods = await user.api.client.vods.list({ channel, limit: 5 });
  ctx.assert(
    "no VOD, so no VOD captions",
    vods.items.every((v) => v.captions.length === 0),
  );
}

async function noTrackForRehearsal(run: CaptionsRun): Promise<void> {
  const { ctx } = run;
  const { user, channel } = await captionedChannel(ctx, "w2cap_rh", { vod: false });
  await user.api.client.stream.rehearsal.arm({ channel });
  const stream = await (async () => {
    const { key } = await user.api.client.stream.rotateKey({ channel });
    const s = startSpeechStream(
      { url: rtmpPublishUrl(ctx.env.HARNESS_RTMP_URL, key), audioPath: run.audioPath },
      `captions-rehearsal-${channel}`,
    );
    ctx.defer(() => s.stop());
    return s;
  })();
  const status = await waitFor(
    "the rehearsal is live",
    async () => {
      const s = await user.api.client.stream.rehearsal.status({ channel });
      return s.state === "rehearsing" && s.broadcastId ? s : null;
    },
    { timeoutMs: 60_000, intervalMs: 2_000, signal: ctx.signal },
  );
  ctx.data("rehearsalBroadcastId", status.broadcastId);
  // Long enough for a captions worker to have started, had it been eligible.
  await delay(15_000, undefined, { signal: ctx.signal });
  if (ctx.env.DATABASE_URL) ctx.assert("no caption track for the rehearsal", (await trackRow(ctx, channel)) === null);
  await stream.stop();
}

async function maskWords(run: CaptionsRun): Promise<void> {
  const { segments } = await run.speech();
  const texts = segments.flatMap((s) => s.cues.map((c) => c.text));
  run.ctx.assert(
    `"${MASK_WORD}" never appears in a cue`,
    texts.every((t) => !t.toLowerCase().includes(MASK_WORD)),
  );
  run.ctx.assert(
    `it shows as ${MASK_TOKEN}`,
    texts.some((t) => t.includes(MASK_TOKEN)),
    { cues: texts.length },
  );
}

export const CAPTIONS_STEP_RUNNERS: Readonly<Record<CaptionsStep, (run: CaptionsRun) => Promise<void>>> = {
  1: subtitlesAdvertised,
  2: werBelowThreshold,
  3: cueTiming,
  4: vodCaptions,
  5: queuedAtCap,
  6: noTranscriptWithoutVods,
  7: noTrackForRehearsal,
  8: maskWords,
};
