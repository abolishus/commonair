// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` extensions `breakdown` and `reconciliation` (docs/testing/w1-selectors.md,
 * "Scenarios"). Stub: W1-breakdown fills it.
 */
import type { MoneyExtension } from "./kit.ts";

export async function stepBreakdown(_ext: MoneyExtension): Promise<void> {
  throw new Error("W1-breakdown not merged");
}

export async function stepReconciliation(_ext: MoneyExtension): Promise<void> {
  throw new Error("W1-breakdown not merged");
}
