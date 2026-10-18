// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * LL-HLS blocking-reload limits (RFC 8216bis §6.2.5.2). A blocking request names a
 * future media sequence number (and part); the origin refuses requests that cannot
 * be satisfied soon with 400 instead of letting them hold an upstream socket, and
 * bounds the wait for the ones it forwards.
 */
import { attr, parseAttributes, unquote } from "./playlist.ts";

export interface PlaylistState {
  /** Media sequence number of the newest segment, counting one still being built from parts. */
  lastMsn: number;
  /** Media sequence number of the newest complete segment. */
  lastFullMsn: number;
  /** Index of the newest part of `lastMsn`, or -1 when it has none. */
  lastPart: number;
  /** EXT-X-TARGETDURATION, seconds. */
  targetDuration: number;
  /** EXT-X-PART-INF PART-TARGET, seconds; undefined when the playlist has no parts. */
  partTarget?: number;
}

/** Where a media playlist currently ends. Null for multivariant or unparseable playlists. */
export function playlistState(text: string): PlaylistState | null {
  let seq = 0;
  let td: number | undefined;
  let pt: number | undefined;
  let full = 0;
  let partsSinceSegment = 0;
  let partsOfLastSegment = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = Number(line.slice(22));
    else if (line.startsWith("#EXT-X-TARGETDURATION:")) td = Number(line.slice(22));
    else if (line.startsWith("#EXT-X-PART-INF:"))
      pt = Number(unquote(attr(parseAttributes(line.slice(16)), "PART-TARGET")));
    else if (line.startsWith("#EXT-X-SKIP:"))
      full += Number(attr(parseAttributes(line.slice(12)), "SKIPPED-SEGMENTS")) || 0;
    else if (line.startsWith("#EXT-X-PART:")) partsSinceSegment++;
    else if (line.startsWith("#EXTINF:")) {
      full++;
      partsOfLastSegment = partsSinceSegment;
      partsSinceSegment = 0;
    }
  }
  if (td === undefined || !Number.isFinite(td) || !Number.isFinite(seq)) return null;
  const lastFull = seq + full - 1;
  const partTarget = pt !== undefined && Number.isFinite(pt) && pt > 0 ? pt : undefined;
  if (partsSinceSegment > 0)
    return {
      lastMsn: lastFull + 1,
      lastFullMsn: lastFull,
      lastPart: partsSinceSegment - 1,
      targetDuration: td,
      partTarget,
    };
  return { lastMsn: lastFull, lastFullMsn: lastFull, lastPart: partsOfLastSegment - 1, targetDuration: td, partTarget };
}

/**
 * Upper bound on parts per segment. EXTINF rounded to the nearest integer must not exceed
 * TARGETDURATION, so a segment lasts less than TARGETDURATION + 0.5 s.
 */
export const maxPartsPerSegment = (s: PlaylistState) =>
  s.partTarget ? Math.ceil((s.targetDuration + 0.5) / s.partTarget - 1e-9) : 0;

/** RFC 8216bis Advance Part Limit, in parts: 3 / PART-TARGET when PART-TARGET < 1 s, otherwise 3. */
export const advancePartLimit = (s: PlaylistState) =>
  s.partTarget && s.partTarget < 1 ? Math.ceil(3 / s.partTarget - 1e-9) : 3;

export type DirectiveVerdict = "ok" | "msn_too_far" | "part_unsupported" | "part_out_of_range" | "beyond_advance_limit";

/** Requests for the past answer immediately and are fine; requests too far ahead are refused. */
export function checkDirectives(d: { msn?: number; part?: number }, s: PlaylistState): DirectiveVerdict {
  if (d.msn === undefined) return "ok";
  // RFC 8216bis: more than two past the last complete segment (i.e. beyond the segment after the one being built).
  if (d.msn > s.lastFullMsn + 2) return "msn_too_far";
  if (d.part === undefined) return "ok";
  if (!s.partTarget) return "part_unsupported";
  if (d.part >= maxPartsPerSegment(s)) return "part_out_of_range";
  const perSegment = Math.max(1, Math.round(s.targetDuration / s.partTarget));
  const ahead = (d.msn - s.lastMsn) * perSegment + d.part - s.lastPart;
  return ahead > advancePartLimit(s) ? "beyond_advance_limit" : "ok";
}

/** Longest blocking reload the origin waits for (and the most an idle connection must survive). */
export const MAX_BLOCKING_MS = 15_000;

/** RFC 8216bis: a server that cannot answer a blocking reload within 3 × target duration should 503. */
export const blockingTimeoutMs = (s: PlaylistState | undefined) =>
  Math.min(MAX_BLOCKING_MS, Math.max(1_500, Math.round(3 * (s?.targetDuration ?? 2) * 1000)));
