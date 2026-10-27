// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { meter } from "@commonair/observability";

/**
 * P2P diagnostics from heartbeats (ADR 0005 amendment 1, decision 6): informational only, nothing
 * that counts, pays or verifies reads them. No session, swarm, address or token in any label.
 * Instruments are no-ops until the OTLP SDK is registered by initTelemetry.
 */
const m = meter("commonair.api");

export const p2pMetrics = {
  bytes: m.createCounter("playback.p2p.bytes", {
    unit: "By",
    description: "Bytes players report exchanged with peers, by direction (down: received, up: sent)",
  }),
  peers: m.createHistogram("playback.p2p.peers", {
    description: "Open peer connections a player reports at each heartbeat",
    advice: { explicitBucketBoundaries: [0, 1, 2, 4, 8, 16, 32, 64] },
  }),
  rejected: m.createCounter("playback.p2p.rejected", {
    description: "Peer-delivered segments players report failed digest validation",
  }),
};

/** Record a committed heartbeat's P2P fields; absent fields record nothing. */
export function recordP2PHeartbeat(beat: {
  bytesP2p: number;
  bytesP2pUp?: number | undefined;
  p2pPeers?: number | undefined;
  p2pRejected?: number | undefined;
}): void {
  if (beat.bytesP2p > 0) p2pMetrics.bytes.add(beat.bytesP2p, { direction: "down" });
  if (beat.bytesP2pUp) p2pMetrics.bytes.add(beat.bytesP2pUp, { direction: "up" });
  if (beat.p2pPeers !== undefined) p2pMetrics.peers.record(beat.p2pPeers);
  if (beat.p2pRejected !== undefined) p2pMetrics.rejected.add(beat.p2pRejected);
}
