// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P2P counters for one session, fed by the loader's events. All of it is informational (ADR 0005
 * amendment 1, decision 6). Peers are counted, never named: no peer id leaves this object.
 */

/** `data-p2p` on the player: no P2P, P2P running without a peer, at least one peer connected. */
export type P2PState = "off" | "on" | "sharing";

/** Heartbeat `p2pPeers` is capped by the contract. */
export const MAX_REPORTED_PEERS = 64;

export class P2PStats {
  /** Segment bytes the loader fetched over HTTP itself (prefetch and fallback). */
  httpSegmentBytes = 0;
  /** Bytes of digest requests (HTTP). */
  digestBytes = 0;
  /** Bytes of segments peers delivered that passed validation. */
  p2pBytes = 0;
  /** Bytes sent to peers. */
  uploadedBytes = 0;
  /** Peer-delivered segments that failed digest validation. */
  rejected = 0;
  private peers = new Map<string, number>();

  /** `onPeerConnect`: one connection per (peer, stream swarm). */
  peerConnected(key: string): void {
    this.peers.set(key, (this.peers.get(key) ?? 0) + 1);
  }

  /** `onPeerClose`. */
  peerClosed(key: string): void {
    const n = this.peers.get(key) ?? 0;
    if (n <= 1) this.peers.delete(key);
    else this.peers.set(key, n - 1);
  }

  /** The loader dropped every peer (P2P turned off, engine destroyed). */
  clearPeers(): void {
    this.peers.clear();
  }

  /** Open peer connections now. */
  get peerCount(): number {
    let n = 0;
    for (const c of this.peers.values()) n += c;
    return n;
  }

  /** HTTP bytes this session's loader added on top of hls.js's own requests. */
  get httpBytes(): number {
    return this.httpSegmentBytes + this.digestBytes;
  }
}

/** The player's `data-p2p` for an engine that is running (or not). */
export function p2pState(running: boolean, peers: number): P2PState {
  if (!running) return "off";
  return peers > 0 ? "sharing" : "on";
}
