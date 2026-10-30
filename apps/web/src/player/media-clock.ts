// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-channel media-clock registry the player writes and the chat panel reads (ADR 0012
 * amendment 1). Stub: W1-player fills it.
 */

/** The wall-clock time (PDT) under the playhead of this channel's player, or null when unknown. */
export function playheadWallclock(_channel: string): Date | null {
  return null;
}

/** Whether this channel's player is at the live edge or behind it (DVR). */
export function playbackMode(_channel: string): "live" | "dvr" {
  return "live";
}
