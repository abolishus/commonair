// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Interim session verification, replaced wholesale by the integrity unit.
 * A session becomes `verified` after 3 consistent heartbeats (media played ≈ wall
 * clock between heartbeats, ±50%) provided the player was visible or unmuted at
 * least once. `excluded` is terminal here: only the integrity system lifts it.
 */
import type { SESSION_VERDICTS } from "@commonair/contracts/enums";

export type Verdict = (typeof SESSION_VERDICTS)[number];

export const REQUIRED_CONSISTENT_HEARTBEATS = 3;
export const CONSISTENCY_TOLERANCE = 0.5;

export interface VerifyState {
  consistent: number;
  engaged: boolean;
}

export interface HeartbeatFacts {
  playedSeconds: number;
  /** Wall-clock seconds since the previous heartbeat (or session start). */
  wallSeconds: number;
  visible: boolean;
  muted: boolean;
}

export function isConsistent(h: Pick<HeartbeatFacts, "playedSeconds" | "wallSeconds">): boolean {
  if (!(h.wallSeconds > 0)) return false;
  return Math.abs(h.playedSeconds - h.wallSeconds) <= CONSISTENCY_TOLERANCE * h.wallSeconds;
}

export function nextVerdict(
  current: Verdict,
  state: VerifyState,
  h: HeartbeatFacts,
): { verdict: Verdict; state: VerifyState } {
  const next: VerifyState = {
    consistent: state.consistent + (isConsistent(h) ? 1 : 0),
    engaged: state.engaged || h.visible || !h.muted,
  };
  if (current !== "pending") return { verdict: current, state: next };
  const verified = next.consistent >= REQUIRED_CONSISTENT_HEARTBEATS && next.engaged;
  return { verdict: verified ? "verified" : "pending", state: next };
}
