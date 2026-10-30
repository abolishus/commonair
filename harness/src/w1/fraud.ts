// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` extension `fraud-hold` (docs/testing/w1-selectors.md, "Scenarios"; ADR 0036).
 * Stub: W1-fraud-floor fills it.
 */
import type { MoneyExtension } from "./kit.ts";

export async function stepFraudHold(_ext: MoneyExtension): Promise<void> {
  throw new Error("W1-fraud-floor not merged");
}
