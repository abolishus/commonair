// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media clock hook (ADR 0012 decision 4). ffmpeg stamps each recorder segment with this host's
 * wall clock (EXT-X-PROGRAM-DATE-TIME). Before a time leaves the recorder (the VOD playlist, the
 * live clip window, the recording start) it is shifted by the anchor's offset for that recorder
 * run, so every rendition and the VOD agree on one broadcast clock. W0-clock implements the
 * anchor (`MediaClock` below, `media-clock.ts`); the identity anchor keeps raw times for tests
 * that do not care about the clock.
 */
import type { ClockMetrics } from "./metrics.ts";

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

/** Who asked for W0 (a metric attribute). */
export type W0Consumer = "ladder" | "aac" | "recorder";

/**
 * The live media clock (ADR 0012, variant A2): W0 for every ffmpeg start, and the recorder run
 * offsets the anchor serves. `clock/media-clock.ts` implements it.
 */
export interface MediaClock extends ClockAnchor {
  /**
   * W0 (epoch ms) of a source path, fetched fresh from MediaMTX's LL-HLS: the wall clock of PTS 0
   * on the timeline a `-copyts` SRT reader started now will see. Throws when it cannot be read.
   */
  w0(broadcastId: string, path: string, consumer: W0Consumer): Promise<number>;
  /** Set a recorder run's offset (served by `offsetMs`), or clear it with null. */
  setRunOffset(broadcastId: string, runId: string, offsetMs: number | null): void;
  /** Forget a broadcast's W0 history and run offsets (its local recordings are gone). */
  forget(broadcastId: string): void;
  /** Recovery: a crashed run's offset from its sidecar in `dir`, null when it has none. */
  sidecarOffsetMs(dir: string, runId: string): Promise<number | null>;
  readonly metrics: ClockMetrics;
}
