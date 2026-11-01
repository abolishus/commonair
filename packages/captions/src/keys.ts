// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Valkey key shapes for live captions (ADR 0011). Media writes them; the origin reads them to serve
 * the subtitle playlist and segments. Every key carries a TTL that each write refreshes, so a media
 * host that crashes mid-broadcast leaves nothing behind for longer than `LIVE_TTL_SECONDS` after
 * its last write. Cue text is masked before it is written here; nothing unmasked is ever stored.
 */
import type { Cue } from "./cues.ts";
import type { LiveTrack } from "./vtt.ts";

/** How long live captions outlive their last write (a crashed host's cues expire after this). */
export const LIVE_TTL_SECONDS = 2 * 3600;

export const CAPTIONS_KEYS = {
  /** JSON `LiveTrack`: present exactly while a track is active (the origin advertises it). */
  live: (broadcastId: string) => `captions:live:${broadcastId}`,
  /** Sorted set of JSON `StoredCue`, scored by `startMs`. */
  cues: (broadcastId: string, language: string) => `captions:cues:${broadcastId}:${language}`,
} as const;

/** A cue as stored: `n` keeps members unique when two cues have the same timing and text. */
export interface StoredCue {
  n: number;
  s: number;
  e: number;
  t: string;
}

export const encodeCue = (n: number, c: Cue): string => JSON.stringify({ n, s: c.startMs, e: c.endMs, t: c.text });

export function decodeCue(raw: string): Cue | null {
  try {
    const v = JSON.parse(raw) as Partial<StoredCue>;
    if (typeof v.s !== "number" || typeof v.e !== "number" || typeof v.t !== "string") return null;
    return { startMs: v.s, endMs: v.e, text: v.t };
  } catch {
    return null;
  }
}

export function decodeLiveTrack(raw: string | null): LiveTrack | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<LiveTrack>;
    if (
      typeof v.language !== "string" ||
      typeof v.w0Ms !== "number" ||
      typeof v.anchorMs !== "number" ||
      typeof v.throughMs !== "number"
    )
      return null;
    return { language: v.language, w0Ms: v.w0Ms, anchorMs: v.anchorMs, throughMs: v.throughMs };
  } catch {
    return null;
  }
}
