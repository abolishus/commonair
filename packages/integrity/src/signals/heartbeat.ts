// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `heartbeat_inconsistent`: the heartbeat stream does not look like a person watching.
 * Sub-checks (each with a weight; combined as a noisy-OR):
 *
 *   played_exceeds_wall_clock  total playedSeconds > 1.5 × wall-clock time between beats (≥ 3 beats)
 *   never_visible_and_muted    every beat hidden and muted (≥ 3 beats). A background tab is not
 *                              a bot, so this is only weak corroboration (0.25): with any other
 *                              single weak signal it stays at or below the exclusion score
 *   buffer_never_advances      bufferSeconds identical on every beat while "playing" (≥ 5 beats)
 *   periodic_timing            intervals between consecutive *visible* beats with < 2 ms standard
 *                              deviation (≥ 10 visible intervals). Hidden tabs are skipped
 *                              because browsers clamp and align their timers (whole-second
 *                              alignment, intensive throttling), which makes honest beats regular
 */
import type { HeartbeatSample, Signal } from "../types.ts";
import { noisyOr, round, stdev } from "./combine.ts";

export const HEARTBEAT_WEIGHTS = {
  played_exceeds_wall_clock: 0.5,
  never_visible_and_muted: 0.25,
  buffer_never_advances: 0.4,
  periodic_timing: 0.6,
} as const;
export type HeartbeatCheck = keyof typeof HEARTBEAT_WEIGHTS;

export const PLAYED_TO_WALL_MAX = 1.5;
export const PERIODIC_STDEV_MS = 2;
/** Visible intervals needed before timing is judged. */
export const PERIODIC_MIN_INTERVALS = 10;
export const BUFFER_MIN_BEATS = 5;
export const ENGAGEMENT_MIN_BEATS = 3;

/** Intervals between consecutive beats that were both visible (timer clamping does not apply). */
export function visibleIntervals(sorted: readonly HeartbeatSample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.visible && cur.visible) out.push(cur.at - prev.at);
  }
  return out;
}

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
  const intervals = visibleIntervals(sorted);
  if (intervals.length >= PERIODIC_MIN_INTERVALS) {
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
