// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media clock hook (ADR 0012 decision 4). ffmpeg stamps each recorder segment with this host's
 * wall clock (EXT-X-PROGRAM-DATE-TIME). Before a time leaves the recorder (the VOD playlist, the
 * live clip window, the recording start) it is shifted by the anchor's offset for that recorder
 * run, so every rendition and the VOD agree on one broadcast clock. W0-clock implements the
 * anchor; until then the identity anchor keeps today's behaviour.
 */
export interface ClockAnchor {
  /**
   * Milliseconds to add to a raw segment time of recorder run `runId` (the segment file prefix,
   * `ffmpeg/args.ts` `recorderArgs`) of broadcast `broadcastId`. May change between calls when a
   * run is re-anchored; callers re-stamp on every render.
   */
  offsetMs(broadcastId: string, runId: string): number;
}

/** No correction: raw host wall-clock times. */
export const IDENTITY_CLOCK: ClockAnchor = { offsetMs: () => 0 };
