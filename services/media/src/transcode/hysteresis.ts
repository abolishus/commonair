// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When to run the transcode ladder. Passthrough is the default (it costs nothing); the ladder
 * starts once viewers stay above the threshold for `startAfterMs`, and stops only after they stay
 * below `stopFraction` of it for `stopAfterMs`, so a count hovering at the threshold does not
 * flap the ladder (each start costs viewers a rendition switch).
 */
export interface HysteresisConfig {
  threshold: number;
  startAfterMs: number;
  stopAfterMs: number;
  stopFraction: number;
}

export interface HysteresisState {
  active: boolean;
  /** When the current qualifying streak began (above threshold while inactive, below the stop level while active). */
  since: number | null;
}

export type HysteresisAction = "start" | "stop" | null;

export const initialHysteresis = (): HysteresisState => ({ active: false, since: null });

export function stepHysteresis(
  state: HysteresisState,
  viewers: number,
  now: number,
  cfg: HysteresisConfig,
): { state: HysteresisState; action: HysteresisAction } {
  if (!state.active) {
    if (viewers <= cfg.threshold) return { state: { active: false, since: null }, action: null };
    const since = state.since ?? now;
    if (now - since >= cfg.startAfterMs) return { state: { active: true, since: null }, action: "start" };
    return { state: { active: false, since }, action: null };
  }
  if (viewers >= cfg.threshold * cfg.stopFraction) return { state: { active: true, since: null }, action: null };
  const since = state.since ?? now;
  if (now - since >= cfg.stopAfterMs) return { state: { active: false, since: null }, action: "stop" };
  return { state: { active: true, since }, action: null };
}
