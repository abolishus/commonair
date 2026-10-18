// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `heartbeat_inconsistent`: the heartbeat stream does not look like a person watching.
 * Sub-checks (each with a weight; combined as a noisy-OR):
 *
 *   played_exceeds_wall_clock  total playedSeconds > 1.5 × wall-clock time between beats (≥ 3 beats)
 *   never_visible_and_muted    every beat hidden and muted (≥ 3 beats)
 *   buffer_never_advances      bufferSeconds identical on every beat while "playing" (≥ 5 beats)
 *   periodic_timing            beat intervals with < 5 ms standard deviation (≥ 10 beats): real
 *                              browsers and networks jitter far more than that
 */
import type { HeartbeatSample, Signal } from "../types.ts";
import { noisyOr, round, stdev } from "./combine.ts";

export const HEARTBEAT_WEIGHTS = {
  played_exceeds_wall_clock: 0.5,
  never_visible_and_muted: 0.5,
  buffer_never_advances: 0.4,
  periodic_timing: 0.6,
} as const;
export type HeartbeatCheck = keyof typeof HEARTBEAT_WEIGHTS;

export const PLAYED_TO_WALL_MAX = 1.5;
export const PERIODIC_STDEV_MS = 5;
export const PERIODIC_MIN_BEATS = 10;
export const BUFFER_MIN_BEATS = 5;
export const ENGAGEMENT_MIN_BEATS = 3;

export function heartbeatChecks(beats: readonly HeartbeatSample[]): {
  checks: HeartbeatCheck[];
  measures: Record<string, number>;
} {
  const sorted = [...beats].sort((a, b) => a.at - b.at);
  const checks: HeartbeatCheck[] = [];
  const measures: Record<string, number> = { beats: sorted.length };
  if (sorted.length >= ENGAGEMENT_MIN_BEATS) {
    // The first beat's playedSeconds covers time before the window we can measure.
    const wallSeconds = (sorted.at(-1)!.at - sorted[0]!.at) / 1000;
    const played = sorted.slice(1).reduce((a, b) => a + b.playedSeconds, 0);
    if (wallSeconds > 0) {
      measures.playedToWall = round(played / wallSeconds);
      if (played > wallSeconds * PLAYED_TO_WALL_MAX) checks.push("played_exceeds_wall_clock");
    }
    if (sorted.every((b) => !b.visible && b.muted)) checks.push("never_visible_and_muted");
  }
  if (sorted.length >= BUFFER_MIN_BEATS) {
    const first = sorted[0]!.bufferSeconds;
    const playing = sorted.some((b) => b.playedSeconds > 0);
    if (playing && sorted.every((b) => b.bufferSeconds === first)) checks.push("buffer_never_advances");
  }
  if (sorted.length >= PERIODIC_MIN_BEATS) {
    const intervals = sorted.slice(1).map((b, i) => b.at - sorted[i]!.at);
    const sd = stdev(intervals);
    measures.intervalStdevMs = round(sd);
    if (sd < PERIODIC_STDEV_MS) checks.push("periodic_timing");
  }
  return { checks, measures };
}

export function heartbeatSignal(beats: readonly HeartbeatSample[]): Signal | null {
  const { checks, measures } = heartbeatChecks(beats);
  if (checks.length === 0) return null;
  return {
    code: "heartbeat_inconsistent",
    score: noisyOr(checks.map((c) => HEARTBEAT_WEIGHTS[c])),
    details: { checks, ...measures },
  };
}
