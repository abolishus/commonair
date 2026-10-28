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
 */
import {
  type FetchEvidence,
  type HeartbeatSample,
  isRelayFetch,
  type P2pEvidence,
  type ScoringContext,
  type SessionFacts,
  type Signal,
} from "../types.ts";
import { noisyOr, round } from "./combine.ts";

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

type FetchSession = Pick<SessionFacts, "assignedSource" | "watchSeconds">;
type FetchCtx = Pick<ScoringContext, "segmentDurationSeconds" | "partsPerSegment" | "p2p">;

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

export function fetchChecks(session: FetchSession, fetches: FetchEvidence, ctx: FetchCtx): FetchFindings {
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
        const ceiling = full * TOO_MANY_RATIO + TOO_MANY_ALLOWANCE_SECONDS / segDur;
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
  beats: readonly HeartbeatSample[],
  untilMs: number,
  session: Pick<SessionFacts, "watchSeconds" | "startedAt" | "lastHeartbeatAt">,
): number {
  if (beats.length > 0) return round(beats.filter((b) => b.at <= untilMs).reduce((a, b) => a + b.playedSeconds, 0));
  const start = session.startedAt.getTime();
  const end = (session.lastHeartbeatAt ?? session.startedAt).getTime();
  if (end <= start) return 0;
  const covered = Math.min(1, Math.max(0, (untilMs - start) / (end - start)));
  return round(session.watchSeconds * covered);
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
