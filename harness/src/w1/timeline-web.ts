// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `timeline-sync` step 2 (docs/testing/w1-selectors.md, "Scenarios"): browser viewers at forced
 * latencies send markers that replay in media-time order. Stub: W1-player fills it.
 */
import type { W1Run } from "./kit.ts";

export async function stepForcedLatencies(_run: W1Run): Promise<void> {
  throw new Error("W1-player not merged");
}
