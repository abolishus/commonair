// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Heartbeat accounting for the playback contract (`playback.heartbeat`): the player keeps
 * cumulative counters; each heartbeat reports what happened since the last *acknowledged* one.
 * A failed heartbeat commits nothing, so its share rolls into the next report (played time
 * clamped to the contract's 120 s per heartbeat). Mirrors `PlaybackSession` in the harness.
 */

export const RENDITION_SOURCE = "source" as const;
export const MAX_PLAYED_PER_HEARTBEAT = 120;

export interface CumulativeStats {
  playedSeconds: number;
  bufferSeconds: number;
  stalls: number;
  bytesHttp: number;
  bytesP2p: number;
  latencySeconds: number | null;
  ttffMs: number | null;
  visible: boolean;
  muted: boolean;
}

export interface HeartbeatDelta {
  playedSeconds: number;
  bufferSeconds: number;
  stalls: number;
  bytesHttp: number;
  bytesP2p: number;
  latencySeconds: number | null;
  ttffMs: number | null;
  visible: boolean;
  muted: boolean;
}

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export class HeartbeatAccountant {
  private sent = { played: 0, stalls: 0, bytesHttp: 0, bytesP2p: 0 };

  /** The delta to send for these cumulative totals (does not commit). */
  delta(c: CumulativeStats): HeartbeatDelta {
    return {
      playedSeconds: Math.min(MAX_PLAYED_PER_HEARTBEAT, nonNeg(c.playedSeconds - this.sent.played)),
      bufferSeconds: nonNeg(c.bufferSeconds),
      stalls: Math.round(nonNeg(c.stalls - this.sent.stalls)),
      bytesHttp: Math.round(nonNeg(c.bytesHttp - this.sent.bytesHttp)),
      bytesP2p: Math.round(nonNeg(c.bytesP2p - this.sent.bytesP2p)),
      latencySeconds:
        c.latencySeconds === null || !Number.isFinite(c.latencySeconds) ? null : Math.max(0, c.latencySeconds),
      ttffMs: c.ttffMs === null || !Number.isFinite(c.ttffMs) ? null : Math.max(0, Math.round(c.ttffMs)),
      visible: c.visible,
      muted: c.muted,
    };
  }

  /** Record that the server accepted a heartbeat built from `c`. */
  commit(c: CumulativeStats): void {
    this.sent = { played: c.playedSeconds, stalls: c.stalls, bytesHttp: c.bytesHttp, bytesP2p: c.bytesP2p };
  }
}

/** Spread heartbeats a little so a page full of players does not tick in lockstep. */
export function nextHeartbeatDelay(intervalMs: number, jitter = 0.1, random: () => number = Math.random): number {
  return Math.max(1_000, Math.round(intervalMs * (1 + (random() * 2 - 1) * jitter)));
}

/** Replace the `t` (playback token) query parameter, if the URL carries one. */
export function withToken(url: string, token: string, param = "t"): string {
  const u = new URL(url);
  if (!u.searchParams.has(param)) return url;
  u.searchParams.set(param, token);
  return u.toString();
}
