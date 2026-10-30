// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Heartbeat accounting for the playback contract (`playback.heartbeat`): the player keeps
 * cumulative counters; each heartbeat reports what happened since the last *acknowledged* one.
 * A failed or throttled heartbeat commits nothing, so its share rolls into the next report. Played time is
 * capped at the contract's 120 s per heartbeat; the excess is carried, never dropped.
 */

export const RENDITION_SOURCE = "source" as const;
export const MAX_PLAYED_PER_HEARTBEAT = 120;

export interface CumulativeStats {
  playedSeconds: number;
  bufferSeconds: number;
  stalls: number;
  /** HTTP bytes only: playlists, segments over HTTP, digest requests. Never a peer's bytes. */
  bytesHttp: number;
  /** Segment bytes received from peers. */
  bytesP2p: number;
  /**
   * P2P diagnostics (informational, ADR 0005 amendment 1 decision 6), only for sessions that ran
   * the P2P loader: bytes sent to peers and rejected segments are cumulative, `p2pPeers` is a gauge.
   */
  bytesP2pUp?: number;
  p2pPeers?: number;
  p2pRejected?: number;
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
  bytesP2pUp?: number;
  p2pPeers?: number;
  p2pRejected?: number;
  latencySeconds: number | null;
  ttffMs: number | null;
  visible: boolean;
  muted: boolean;
}

/** Heartbeat `p2pPeers` maximum (the contract's). */
export const MAX_P2P_PEERS = 64;

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export class HeartbeatAccountant {
  private sent = { played: 0, stalls: 0, bytesHttp: 0, bytesP2p: 0, bytesP2pUp: 0, p2pRejected: 0 };

  /** The delta to send for these cumulative totals (does not commit). */
  delta(c: CumulativeStats): HeartbeatDelta {
    const d: HeartbeatDelta = {
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
    if (c.bytesP2pUp !== undefined) d.bytesP2pUp = Math.round(nonNeg(c.bytesP2pUp - this.sent.bytesP2pUp));
    if (c.p2pRejected !== undefined) d.p2pRejected = Math.round(nonNeg(c.p2pRejected - this.sent.p2pRejected));
    if (c.p2pPeers !== undefined) d.p2pPeers = Math.min(MAX_P2P_PEERS, Math.round(nonNeg(c.p2pPeers)));
    return d;
  }

  /**
   * Record that the server accepted a heartbeat built from `c`. Only the played time actually
   * reported counts as sent: anything above the per-heartbeat cap carries over to the next one.
   */
  commit(c: CumulativeStats): void {
    this.sent = {
      played: this.sent.played + this.delta(c).playedSeconds,
      stalls: c.stalls,
      bytesHttp: c.bytesHttp,
      bytesP2p: c.bytesP2p,
      bytesP2pUp: c.bytesP2pUp ?? this.sent.bytesP2pUp,
      p2pRejected: c.p2pRejected ?? this.sent.p2pRejected,
    };
  }

  /**
   * Apply the server's answer to a heartbeat built from `c`. A `throttled` beat came in under the
   * server's floor and recorded nothing, so its deltas stay uncommitted and go out with the next
   * beat. Returns whether the beat was committed.
   */
  settle(c: CumulativeStats, res: { throttled?: boolean | undefined }): boolean {
    if (res.throttled) return false;
    this.commit(c);
    return true;
  }
}

/** Spread heartbeats a little so a page full of players does not tick in lockstep. */
export function nextHeartbeatDelay(intervalMs: number, jitter = 0.1, random: () => number = Math.random): number {
  return Math.max(1_000, Math.round(intervalMs * (1 + (random() * 2 - 1) * jitter)));
}

/** Where the playhead is on every beat (ADR 0016 decision 6; the contract's `Heartbeat`). */
export interface PlaybackFields {
  playbackMode: "live" | "dvr";
  /** Seconds behind the live edge in DVR mode; null at the edge and always in W1 (W2-dvr fills it). */
  behindLiveSeconds: number | null;
}

/**
 * The playback-mode fields every heartbeat carries. Sent even when `live` (the contract's
 * default) so a missing field always means an older client.
 */
export function playbackFields(mode: "live" | "dvr", behindLiveSeconds: number | null = null): PlaybackFields {
  const behind =
    mode === "dvr" && behindLiveSeconds !== null && Number.isFinite(behindLiveSeconds)
      ? Math.min(86_400, Math.max(0, behindLiveSeconds))
      : null;
  return { playbackMode: mode, behindLiveSeconds: behind };
}

/** Replace the `t` (playback token) query parameter, if the URL carries one. */
export function withToken(url: string, token: string, param = "t"): string {
  const u = new URL(url);
  if (!u.searchParams.has(param)) return url;
  u.searchParams.set(param, token);
  return u.toString();
}
