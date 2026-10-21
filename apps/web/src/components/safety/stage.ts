// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `/$channel` puts where the player goes. A T1-restricted stream always shows the
 * `stream-restricted` interstitial, and the player (which asks `playback.start` for a token) is
 * mounted under the blur only for a confirmed adult: the API refuses everyone else with
 * `mature_gate`, and the blur alone must never be what stands between a viewer and the stream.
 */
export type PlayerStage = "mature-gate" | "restricted-locked" | "restricted-player" | "player";

export function playerStage(s: {
  live: boolean;
  mature: boolean;
  restricted: boolean;
  /** Signed in and 18+ confirmed. */
  confirmed: boolean;
  /** `playback.start` answered `mature_gate` (e.g. a mature category the page did not know about). */
  gateHit: boolean;
}): PlayerStage {
  if (!s.live) return "player";
  if (s.restricted) return s.confirmed ? "restricted-player" : "restricted-locked";
  return s.gateHit || (s.mature && !s.confirmed) ? "mature-gate" : "player";
}
