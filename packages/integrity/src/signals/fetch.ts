// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `fetch_pattern`: what the origin served this session does not match what it claims
 * to have watched. Only origin- and CDN-assigned sessions are checked: relay viewers
 * fetch from the relay (covered by receipt cross-checks), and bytes received over P2P
 * reduce the HTTP segments we expect.
 *
 *   playlists_without_segments  ≥ 10 playlist requests and no segment/part at all (playlist pollers)
 *   segments_without_playlists  ≥ 10 segments and zero playlist requests (direct segment scraping)
 *   too_few_segments            < 25 % of the HTTP segments expected for the watch time (≥ 10 expected)
 *   too_many_segments           > 4 × the segments expected for the watch time (≥ 10 expected)
 */
import type { FetchSummary, ScoringContext, SessionFacts, Signal } from "../types.ts";
import { noisyOr, round } from "./combine.ts";

export const FETCH_WEIGHTS = {
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

export function fetchChecks(
  session: Pick<SessionFacts, "assignedSource" | "watchSeconds" | "bytesHttp" | "bytesP2p">,
  fetches: FetchSummary,
  ctx: Pick<ScoringContext, "segmentDurationSeconds" | "partsPerSegment">,
): { checks: FetchCheck[]; measures: Record<string, number> } {
  const checks: FetchCheck[] = [];
  const measures: Record<string, number> = {};
  if (session.assignedSource === "relay") return { checks, measures };
  const parts = fetches.parts ?? 0;
  const effectiveSegments = fetches.segments + parts / Math.max(1, ctx.partsPerSegment);
  measures.segments = round(effectiveSegments);
  if (fetches.playlists !== null) {
    measures.playlists = fetches.playlists;
    if (fetches.playlists >= FETCH_MIN_REQUESTS && fetches.segments + parts === 0)
      checks.push("playlists_without_segments");
    if (fetches.playlists === 0 && fetches.segments >= FETCH_MIN_REQUESTS) checks.push("segments_without_playlists");
  }
  const totalBytes = session.bytesHttp + session.bytesP2p;
  const httpShare = totalBytes > 0 ? session.bytesHttp / totalBytes : 1;
  const expected = (session.watchSeconds / Math.max(0.1, ctx.segmentDurationSeconds)) * httpShare;
  measures.expectedSegments = round(expected);
  if (expected >= MIN_EXPECTED_SEGMENTS && !checks.includes("playlists_without_segments")) {
    const ratio = effectiveSegments / expected;
    measures.segmentRatio = round(ratio);
    if (ratio < TOO_FEW_RATIO) checks.push("too_few_segments");
    else if (ratio > TOO_MANY_RATIO) checks.push("too_many_segments");
  }
  return { checks, measures };
}

export function fetchSignal(
  session: Pick<SessionFacts, "assignedSource" | "watchSeconds" | "bytesHttp" | "bytesP2p">,
  fetches: FetchSummary,
  ctx: Pick<ScoringContext, "segmentDurationSeconds" | "partsPerSegment">,
): Signal | null {
  const { checks, measures } = fetchChecks(session, fetches, ctx);
  if (checks.length === 0) return null;
  return {
    code: "fetch_pattern",
    score: noisyOr(checks.map((c) => FETCH_WEIGHTS[c])),
    details: { checks, ...measures },
  };
}
