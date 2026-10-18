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
 *   too_many_segments           > 4 × the segments expected (origin with known part counts only)
 *
 * Independently of the score, a session whose media is not confirmed (`mediaUnconfirmed`)
 * never verifies: it stays pending with reason `media_unconfirmed`. That covers the database
 * counter alone showing far too few full segments, and relay sessions without receipt coverage.
 *
 * Only server-observed quantities are used. Client-reported bytes (HTTP or P2P) never lower
 * what is expected; a `p2p`-assigned session is expected to fetch a fixed minimum share over
 * HTTP (`P2P_HTTP_SHARE`).
 */
import {
  type FetchEvidence,
  type HeartbeatSample,
  isRelayFetch,
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
 * Database counter only: full segments (parts are not counted there). A low-latency player
 * mixes full segments (start-up, catch-up, rendition switches) with parts, so the bar is
 * tolerant: at least this share of watched seconds / segment duration, and at least one.
 */
export const DB_ONLY_MIN_RATIO = 0.1;
/** HTTP share a `p2p`-assigned session must still fetch from the origin (the live edge). */
export const P2P_HTTP_SHARE = 0.1;

type FetchSession = Pick<SessionFacts, "assignedSource" | "watchSeconds">;
type FetchCtx = Pick<ScoringContext, "segmentDurationSeconds" | "partsPerSegment">;

export interface FetchFindings {
  checks: FetchCheck[];
  measures: Record<string, number>;
  /** True when the session must not verify on its delivery evidence. */
  mediaUnconfirmed: boolean;
  /** Why the session was not judged, when it was not. */
  skipped: "cdn" | "no_accounting" | null;
}

/** Share of media expected over HTTP from the origin; never derived from client-reported bytes. */
export function httpShare(session: Pick<SessionFacts, "assignedSource">): number {
  return session.assignedSource === "p2p" ? P2P_HTTP_SHARE : 1;
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

  if (session.assignedSource === "relay") {
    // A relay session verifies only on its relay's receipts; without coverage it stays pending.
    if (fetches === null || !isRelayFetch(fetches) || fetches.relayObjects === null) return none("no_accounting", true);
    // Relays count every media object (a part counts as one), so only "too few" is meaningful.
    const expected = Math.max(0, fetches.claimedSeconds) / segDur;
    measures.relayObjects = round(fetches.relayObjects);
    measures.claimedSeconds = round(fetches.claimedSeconds);
    measures.expectedSegments = round(expected);
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
  const expected = (Math.max(0, session.watchSeconds) / segDur) * httpShare(session);
  measures.expectedSegments = round(expected);
  let mediaUnconfirmed = checks.includes("playlists_without_segments");
  if (expected >= MIN_EXPECTED_SEGMENTS && !mediaUnconfirmed) {
    if (!partsKnown) {
      // Database counter only (full segments): cannot be told apart from a part-heavy
      // low-latency player well enough to score, so a shortfall only holds the session.
      const ratio = fetches.segments / expected;
      measures.segmentRatio = round(ratio);
      if (fetches.segments < Math.max(1, expected * DB_ONLY_MIN_RATIO)) mediaUnconfirmed = true;
    } else if (effectiveSegments === 0) {
      checks.push("no_media_fetched");
      mediaUnconfirmed = true;
    } else {
      const ratio = effectiveSegments / expected;
      measures.segmentRatio = round(ratio);
      if (ratio < TOO_FEW_RATIO) {
        checks.push("too_few_segments");
        mediaUnconfirmed = true;
      } else if (ratio > TOO_MANY_RATIO) checks.push("too_many_segments");
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
