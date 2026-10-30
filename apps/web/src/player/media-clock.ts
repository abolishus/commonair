// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-channel media-clock registry the player writes and the chat panel reads (ADR 0012
 * amendment 1). Chat and player are siblings on `/$channel` and share no React state, so the
 * player registers its controller here by channel and chat asks at send or present time.
 *
 * Several players of one channel can be mounted for a moment (a route transition, a remount): the
 * latest registration wins, and unregistering it restores the one before.
 */

export type PlaybackMode = "live" | "dvr";

export interface MediaClockSource {
  /** PDT under the playhead, null before the first frame or without PDT. */
  playheadWallclock(): Date | null;
  playbackMode(): PlaybackMode;
}

const registry = new Map<string, MediaClockSource[]>();

/** Register `source` as `channel`'s media clock; the returned function unregisters it (idempotent). */
export function registerMediaClock(channel: string, source: MediaClockSource): () => void {
  // A wrapper per registration, so registering one source twice unregisters exactly one entry.
  const entry: MediaClockSource = {
    playheadWallclock: () => source.playheadWallclock(),
    playbackMode: () => source.playbackMode(),
  };
  const stack = registry.get(channel) ?? [];
  stack.push(entry);
  registry.set(channel, stack);
  return () => {
    const current = registry.get(channel);
    if (!current) return;
    const i = current.indexOf(entry);
    if (i === -1) return;
    current.splice(i, 1);
    if (current.length === 0) registry.delete(channel);
  };
}

function current(channel: string): MediaClockSource | undefined {
  const stack = registry.get(channel);
  return stack?.[stack.length - 1];
}

/** The wall-clock time (PDT) under the playhead of this channel's player, or null when unknown. */
export function playheadWallclock(channel: string): Date | null {
  try {
    const at = current(channel)?.playheadWallclock() ?? null;
    return at && Number.isFinite(at.getTime()) ? at : null;
  } catch {
    return null;
  }
}

/** Whether this channel's player is at the live edge or behind it (DVR); `live` without a player. */
export function playbackMode(channel: string): PlaybackMode {
  try {
    return current(channel)?.playbackMode() ?? "live";
  } catch {
    return "live";
  }
}
