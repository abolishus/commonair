// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` W3 extension `giveaway` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0039): with
 * `GIVEAWAYS_ENABLED=true` (harness/compose.w3.yaml) the streamer opens a keyword giveaway,
 * verified viewers enter by keyword and by button, a viewbot is refused, close and draw, the
 * harness re-runs the draw from `verify` and matches the winners, and the flag-off instance
 * refuses `open`. Stub: W3-giveaways fills it.
 */
import type { InteractW3Extension } from "./kit.ts";

export async function stepGiveaway(_run: InteractW3Extension): Promise<void> {
  throw new Error("W3-giveaways not merged");
}
