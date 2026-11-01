// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e2e-relay` W3 extensions (docs/testing/b7-selectors.md, "Scenarios"; ADR 0016 amendment 1):
 * `dvr-relay` (a relay-assigned viewer rewinds and the segments come from the relay), `dvr-purge`
 * (a removal mid-stream: the relay answers 404 for a cached DVR segment within 5 s and its purge
 * `seq` advanced) and `relay-vtt` (SUBTITLES through the relay, `.vtt` at `max-age=30`, not in
 * the receipt's segment count). Stub: W3-dvr-relay fills it (and may split it into more modules
 * in this directory).
 */
import type { RelayW3Extension } from "../kit.ts";

const notMerged = (): never => {
  throw new Error("W3-dvr-relay not merged");
};

export async function stepDvrRelay(_ext: RelayW3Extension): Promise<void> {
  notMerged();
}

export async function stepDvrPurge(_ext: RelayW3Extension): Promise<void> {
  notMerged();
}

export async function stepRelayVtt(_ext: RelayW3Extension): Promise<void> {
  notMerged();
}
