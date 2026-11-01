// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `fetch_pattern`: what the delivery path served this session does not match what it
 * claims to have watched. Heartbeats are the client's claim; the accounting is what the
 * server side saw:
 *
 *   origin / p2p  the origin's per-session counters (`stream:segments`): Valkey counters with
 *                 playlists, segments and LL-HLS parts (distinct objects when known), else the
 *                 database full-segment counter
 *   relay         the per-session entries of the relay's receipts verified with complete issuance
 *   cdn           nothing per session (CDN pulls are tokenless): not judged (known limitation)
 *
 * Checks (combined as a noisy-OR):
 *
 *   no_media_fetched            claims ≥ 10 segments' worth of playback, accounting shows no media at all
 *   playlists_without_segments  ≥ 10 playlist requests and no segment/part at all (playlist pollers)
 *   segments_without_playlists  ≥ 10 segments and zero playlist requests (direct segment scraping)
 *   too_few_segments            < 25 % of the media expected for the watch time (≥ 10 expected)
 *   too_many_segments           > 4 × the segments expected + 40 s of media (origin with known part
 *                               counts only; the allowance covers start-up and heartbeat lag)
 *
 * Independently of the score, a session whose media is not confirmed (`mediaUnconfirmed`)
 * never verifies: it stays pending with reason `media_unconfirmed`. That covers the database
 * counter alone showing far too few full segments, and relay sessions without receipt coverage.
 *
 * Only server-observed quantities are used. Client-reported bytes (HTTP or P2P), `p2pCapable` and
 * the assigned source never lower what is expected. Only a session with server-side P2P evidence
 * (`ScoringContext.p2p`, see `p2p.ts`: within the window the tracker saw it announce to its own
 * channel's swarm and complete a signalling exchange with a peer on another network, its network
 * has at most `maxSessionsPerNetwork` announcers on the channel, and so does a linked network) is
 * judged "too few" / "no media" against the reduced share `P2P_HTTP_SHARE`. "Too many" is always judged against share 1, so an honest lone peer that falls
 * back to HTTP never trips it. Legacy `p2p`-assigned rows are judged like origin sessions.
 *
 * **Playback modes** (ADR 0016 decision 6). A session's watch time splits into live seconds and
 * DVR seconds (`dvrSeconds`, from `playback_sessions.dvr_seconds`; absent = 0, all live), and the
 * origin's counters split the same way (`dvrFetches`, from `/dvr/` entries marked `mode: "dvr"`;
 * absent mode = live). Each part is judged against its own fetches: the live part as above with
 * the live seconds, the DVR part as an origin session (DVR is origin-only: no relay, no CDN, no
 * P2P share) on the recorder's full segments (`dvrSegmentDurationSeconds`, no parts). A client
 * that claims `live` while fetching only `/dvr/` shows no live media and fails `no_media_fetched`;
 * one that claims `dvr` without a DVR grant has no DVR fetches and fails the same way. Once either
 * mode has origin counters, the other mode's missing counters are zeros, not "no accounting".
 * DVR seconds that verify still count toward the verified-watch gate (the verdict is one).
 */
import type { PLAYBACK_MODES } from "@commonair/contracts/enums";
import {
  type FetchEvidence,
  type FetchSummary,
  type HeartbeatSample,
  isRelayFetch,
  type P2pEvidence,
  type ScoringContext,
  type SessionFacts,
  type Signal,
} from "../types.ts";
import { noisyOr, round } from "./combine.ts";

type PlaybackMode = (typeof PLAYBACK_MODES)[number];

export const FETCH_WEIGHTS = {
  no_media_fetched: 0.9,
  playlists_without_segments: 0.8,
  segments_without_playlists: 0.6,
  too_few_segments: 0.6,
  too_many_segments: 0.4,
} as const;
export type FetchCheck = keyof typeof FETCH_WEIGHTS;

export const FETCH_MIN_REQUESTS = 10;
export const MIN_EXPECTED_SEGMENTS = 10;
export const TOO_FEW_RATIO = 0.25;
export const TOO_MANY_RATIO = 4;
/**
 * Media (in seconds) a player may fetch beyond `TOO_MANY_RATIO` × its watch time before "too
 * many" fires. Two honest costs are front-loaded: on start a player fills the live playlist
 * window (MediaMTX keeps 7 segments, ~14 s with a 2 s GOP) for the video and the audio track, and
 * watch time is credited only per heartbeat (every ~10 s) while fetches are counted as they
 * happen, so at the first beats a session has fetched ~17 s of LL-HLS parts for both tracks
 * against ~10 s credited (measured on CI: 43–48 effective segments at 10 s watched, ratio 4.3–4.8,
 * honest headless Chromium). Constant, so a long session is still judged at the ratio.
 */
export const TOO_MANY_ALLOWANCE_SECONDS = 40;
/**
 * Database counter only: full segments (parts are not counted there). A low-latency player
 * mixes full segments (start-up, catch-up, rendition switches) with parts, so the bar is
 * tolerant: at least this share of watched seconds / segment duration, and at least one.
 */
export const DB_ONLY_MIN_RATIO = 0.1;
/** HTTP share a P2P-evidenced session must still fetch over HTTP (the live edge). */
export const P2P_HTTP_SHARE = 0.1;

/** The recorder's segment length (`services/media/src/settings.ts`): DVR serves those, never parts. */
export const DVR_SEGMENT_SECONDS = 4;
/**
 * Like `TOO_MANY_ALLOWANCE_SECONDS`, for DVR: each seek refills the player's forward buffer
 * (hls.js keeps ~30 s ahead), so an honest viewer who scrubs fetches more than they watch.
 */
export const DVR_TOO_MANY_ALLOWANCE_SECONDS = 120;

type FetchSession = Pick<SessionFacts, "assignedSource" | "watchSeconds"> & {
  /** Of `watchSeconds`, the seconds credited in `dvr` mode. Absent = 0. */
  dvrSeconds?: number;
};
type FetchCtx = Pick<ScoringContext, "segmentDurationSeconds" | "partsPerSegment" | "p2p"> & {
  /** Origin counters of the session's `/dvr/` fetches; absent or null = none recorded. */
  dvrFetches?: FetchSummary | null;
  /** Default `DVR_SEGMENT_SECONDS`. */
  dvrSegmentDurationSeconds?: number;
};

export interface FetchFindings {
  checks: FetchCheck[];
  measures: Record<string, number>;
  /** True when the session must not verify on its delivery evidence. */
  mediaUnconfirmed: boolean;
  /** Why the session was not judged, when it was not. */
  skipped: "cdn" | "no_accounting" | null;
}

/**
 * Share of media the "too few" bar expects over HTTP: reduced only for server-side P2P evidence,
 * never for client-reported bytes, `p2pCapable` or the assigned source.
 */
export function httpShare(p2p: P2pEvidence | null | undefined): number {
  return p2p?.evidenced ? P2P_HTTP_SHARE : 1;
}

/** Explanation fields for the P2P decision (only when evidence was looked up). */
function p2pMeasures(measures: Record<string, number>, p2p: P2pEvidence | null | undefined): void {
  if (!p2p) return;
  measures.p2pEvidenced = p2p.evidenced ? 1 : 0;
  measures.linkedNetworks = p2p.linkedNetworks;
  measures.linkedWithinCap = p2p.linkedWithinCap;
  measures.sameNetworkPeers = p2p.sameNetworkPeers;
  if (p2p.evidenced) measures.httpShare = P2P_HTTP_SHARE;
}

const ZERO: FetchSummary = { playlists: 0, segments: 0, parts: 0 };
const hasCounts = (f: FetchSummary | null | undefined): f is FetchSummary =>
  f !== null && f !== undefined && (f.playlists ?? 0) + f.segments + (f.parts ?? 0) > 0;

/**
 * The fetch checks for a session, each playback mode judged against its own fetches (see the
 * module comment). Without DVR seconds or DVR fetches this is exactly the single-mode judgement.
 */
export function fetchChecks(session: FetchSession, fetches: FetchEvidence, ctx: FetchCtx): FetchFindings {
  const total = Math.max(0, session.watchSeconds);
  const dvrSeconds = Math.min(total, Math.max(0, session.dvrSeconds ?? 0));
  const dvrFetches = ctx.dvrFetches ?? null;
  if (dvrSeconds === 0 && !hasCounts(dvrFetches)) return modeChecks(session, fetches, ctx);

  // Origin counters exist for one mode: the other mode's absence is a zero, not a gap.
  const origin = session.assignedSource !== "relay" && session.assignedSource !== "cdn";
  const liveFetches = fetches === null && origin && hasCounts(dvrFetches) ? ZERO : fetches;
  const live = modeChecks({ ...session, watchSeconds: total - dvrSeconds }, liveFetches, ctx);
  const dvrDur = ctx.dvrSegmentDurationSeconds ?? DVR_SEGMENT_SECONDS;
  const dvr = modeChecks(
    { assignedSource: "origin", watchSeconds: dvrSeconds },
    // Full segments only, so parts are known to be zero; no counters at all is no DVR media.
    { playlists: dvrFetches?.playlists ?? 0, segments: dvrFetches?.segments ?? 0, parts: 0 },
    { segmentDurationSeconds: dvrDur, partsPerSegment: 1, p2p: null },
    DVR_TOO_MANY_ALLOWANCE_SECONDS,
  );
  const measures: Record<string, number> = { ...live.measures, liveSeconds: round(total - dvrSeconds) };
  for (const [k, v] of Object.entries(dvr.measures)) measures[`dvr${k[0]?.toUpperCase() ?? ""}${k.slice(1)}`] = v;
  measures.dvrSeconds = round(dvrSeconds);
  return {
    checks: [...new Set([...live.checks, ...dvr.checks])],
    measures,
    // No live seconds and no live accounting (an all-DVR relay session has no receipts): there
    // is no live media to confirm, so only the DVR part can leave it unconfirmed.
    mediaUnconfirmed:
      (live.mediaUnconfirmed && !(total - dvrSeconds === 0 && live.skipped !== null)) || dvr.mediaUnconfirmed,
    // Unjudged only when the live part was and there is no DVR part to judge instead.
    skipped: dvrSeconds > 0 ? null : live.skipped,
  };
}

/** One playback mode's checks: its claimed seconds (`watchSeconds`) against its fetches. */
function modeChecks(
  session: FetchSession,
  fetches: FetchEvidence,
  ctx: FetchCtx,
  tooManyAllowanceSeconds = TOO_MANY_ALLOWANCE_SECONDS,
): FetchFindings {
  const checks: FetchCheck[] = [];
  const measures: Record<string, number> = {};
  const none = (skipped: FetchFindings["skipped"], mediaUnconfirmed = false): FetchFindings => ({
    checks,
    measures,
    mediaUnconfirmed,
    skipped,
  });
  if (session.assignedSource === "cdn") return none("cdn");
  const segDur = Math.max(0.1, ctx.segmentDurationSeconds);
  const share = httpShare(ctx.p2p);

  if (session.assignedSource === "relay") {
    // A relay session verifies only on its relay's receipts; without coverage it stays pending.
    if (fetches === null || !isRelayFetch(fetches) || fetches.relayObjects === null) return none("no_accounting", true);
    // Relays count every media object (a part counts as one), so only "too few" is meaningful.
    const expected = (Math.max(0, fetches.claimedSeconds) / segDur) * share;
    measures.relayObjects = round(fetches.relayObjects);
    measures.claimedSeconds = round(fetches.claimedSeconds);
    measures.expectedSegments = round(expected);
    p2pMeasures(measures, ctx.p2p);
    if (expected >= MIN_EXPECTED_SEGMENTS) {
      const ratio = fetches.relayObjects / expected;
      measures.segmentRatio = round(ratio);
      if (fetches.relayObjects === 0) checks.push("no_media_fetched");
      else if (ratio < TOO_FEW_RATIO) checks.push("too_few_segments");
    }
    return { checks, measures, mediaUnconfirmed: checks.length > 0, skipped: null };
  }
  if (fetches === null || isRelayFetch(fetches)) return none("no_accounting");

  const partsKnown = fetches.parts !== null;
  const parts = fetches.parts ?? 0;
  const effectiveSegments = fetches.segments + parts / Math.max(1, ctx.partsPerSegment);
  measures.segments = round(effectiveSegments);
  if (fetches.playlists !== null) {
    measures.playlists = fetches.playlists;
    if (fetches.playlists >= FETCH_MIN_REQUESTS && fetches.segments + parts === 0)
      checks.push("playlists_without_segments");
    if (fetches.playlists === 0 && fetches.segments >= FETCH_MIN_REQUESTS) checks.push("segments_without_playlists");
  }
  // "Too few" uses the (possibly reduced) HTTP share; "too many" always the full expectation.
  const full = Math.max(0, session.watchSeconds) / segDur;
  const expected = full * share;
  measures.expectedSegments = round(expected);
  p2pMeasures(measures, ctx.p2p);
  let mediaUnconfirmed = checks.includes("playlists_without_segments");
  if (!mediaUnconfirmed) {
    if (!partsKnown) {
      // Database counter only (full segments): cannot be told apart from a part-heavy
      // low-latency player well enough to score, so a shortfall only holds the session.
      if (expected >= MIN_EXPECTED_SEGMENTS) {
        measures.segmentRatio = round(fetches.segments / expected);
        if (fetches.segments < Math.max(1, expected * DB_ONLY_MIN_RATIO)) mediaUnconfirmed = true;
      }
    } else if (effectiveSegments === 0) {
      if (expected >= MIN_EXPECTED_SEGMENTS) {
        checks.push("no_media_fetched");
        mediaUnconfirmed = true;
      }
    } else {
      if (expected >= MIN_EXPECTED_SEGMENTS) {
        const ratio = effectiveSegments / expected;
        measures.segmentRatio = round(ratio);
        if (ratio < TOO_FEW_RATIO) {
          checks.push("too_few_segments");
          mediaUnconfirmed = true;
        }
      }
      if (!mediaUnconfirmed && full >= MIN_EXPECTED_SEGMENTS) {
        const ceiling = full * TOO_MANY_RATIO + tooManyAllowanceSeconds / segDur;
        measures.tooManyCeiling = round(ceiling);
        if (effectiveSegments > ceiling) checks.push("too_many_segments");
      }
    }
  }
  return { checks, measures, mediaUnconfirmed, skipped: null };
}

/**
 * Playback a session claimed up to `untilMs` (the end of the window its relay's verified
 * receipts cover). From the heartbeat history when there is one (each beat reports the
 * seconds played since the previous one); otherwise the database watch time spread evenly
 * over the session's life.
 */
export function claimedSecondsUntil(
  beats: readonly (HeartbeatSample & { mode?: PlaybackMode })[],
  untilMs: number,
  session: Pick<SessionFacts, "watchSeconds" | "startedAt" | "lastHeartbeatAt"> & { dvrSeconds?: number },
  opts: { mode?: PlaybackMode } = {},
): number {
  // With a mode, only that mode's playback counts (a beat without one is live); relay receipts
  // cover live fetches only, so a relay session's DVR seconds are judged on the origin's counters.
  const counted = opts.mode === undefined ? beats : beats.filter((b) => (b.mode ?? "live") === opts.mode);
  if (beats.length > 0) return round(counted.filter((b) => b.at <= untilMs).reduce((a, b) => a + b.playedSeconds, 0));
  const start = session.startedAt.getTime();
  const end = (session.lastHeartbeatAt ?? session.startedAt).getTime();
  if (end <= start) return 0;
  const covered = Math.min(1, Math.max(0, (untilMs - start) / (end - start)));
  const dvr = Math.min(session.watchSeconds, Math.max(0, session.dvrSeconds ?? 0));
  const seconds =
    opts.mode === undefined ? session.watchSeconds : opts.mode === "dvr" ? dvr : session.watchSeconds - dvr;
  return round(seconds * covered);
}

export function fetchSignal(session: FetchSession, fetches: FetchEvidence, ctx: FetchCtx): Signal | null {
  const { checks, measures } = fetchChecks(session, fetches, ctx);
  if (checks.length === 0) return null;
  return {
    code: "fetch_pattern",
    score: noisyOr(checks.map((c) => FETCH_WEIGHTS[c])),
    details: { checks, ...measures },
  };
}
