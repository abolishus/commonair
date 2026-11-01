// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` W3 extension `fair-prediction` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0039):
 * two viewers at different latencies, a prediction locked in media time, the far viewer's late
 * bet accepted, the near viewer's refused, a moderator's refused, and the resolve's payouts sum to
 * the pool with an audit row. Stub: W3-fair-predictions fills it.
 */
import type { InteractW3Extension } from "./kit.ts";

export async function stepFairPrediction(_run: InteractW3Extension): Promise<void> {
  throw new Error("W3-fair-predictions not merged");
}
