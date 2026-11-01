// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `timeline-sync` W2 extension `replay-panel` (docs/testing/w2-selectors.md, "Scenarios"): the
 * VOD and clip watch pages' replay panel, after steps 1 and 3 leave a VOD with marker messages.
 * Stub: W2-vod-watch fills it.
 */
import type { W1Run } from "./kit.ts";

export async function stepReplayPanel(_run: W1Run): Promise<void> {
  throw new Error("W2-vod-watch not merged");
}
