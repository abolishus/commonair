// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-player's extensions (docs/testing/b8-selectors.md, "Scenarios"): `watch-room` `edge-sync`
 * (two members on different sources sync within today's targets: Chromium under 500 ms, WebKit
 * under 1 s) and `relay-dvr` `relay-dvr-switch` (the relay stops mid-DVR session and the player
 * keeps DVR from the origin with no 403). `relay-dvr` is B8-harness's wave 2 scenario; the
 * orchestrator wires `stepRelayDvrSwitch` into it at that merge. Stub entry points from the batch 8
 * contract step: B8-player fills them.
 */
import type { RelayDvrB8Extension, WatchRoomB8Extension } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("B8-player not merged");
};

export async function stepEdgeSync(_run: WatchRoomB8Extension): Promise<void> {
  notMerged();
}

export async function stepRelayDvrSwitch(_ext: RelayDvrB8Extension): Promise<void> {
  notMerged();
}
