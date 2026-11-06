// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pages of a VOD's caption cues for the `/captions` editor (F36): a long VOD has thousands of
 * cues, so the editor shows one stretch of time at a time. Only rendering is paged; the editor
 * keeps every cue's draft text.
 */

/** Each page covers this much of the VOD. */
export const CUE_WINDOW_MS = 5 * 60_000;
/** A dense stretch is split so a page never renders more inputs than this. */
export const CUE_PAGE_MAX = 100;

export interface CuePage<T> {
  /** The first cue's start and the last cue's end, for the page's label. */
  startMs: number;
  endMs: number;
  cues: T[];
}

/**
 * Cues grouped into pages by their start time's window, in time order. Windows with no cue
 * (silence, or nothing matching a search) are left out, so Previous and Next never land on an
 * empty page.
 */
export function cuePages<T extends { startMs: number; endMs: number }>(
  cues: readonly T[],
  windowMs: number = CUE_WINDOW_MS,
  max: number = CUE_PAGE_MAX,
): CuePage<T>[] {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const pages: CuePage<T>[] = [];
  let window = Number.NaN;
  let current: T[] = [];
  const close = () => {
    const first = current[0];
    if (first === undefined) return;
    pages.push({ startMs: first.startMs, endMs: Math.max(...current.map((c) => c.endMs)), cues: current });
    current = [];
  };
  for (const cue of sorted) {
    const w = Math.floor(Math.max(0, cue.startMs) / windowMs);
    if (w !== window || current.length >= max) {
      close();
      window = w;
    }
    current.push(cue);
  }
  close();
  return pages;
}

/** A page index kept inside `0 … count - 1` (0 when there are no pages). */
export function clampPage(page: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(0, page), count - 1);
}
