// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` W2 extensions `split-release`, `split-clawback`, `split-won-chargeback` and
 * `split-new-payee` (docs/testing/w2-selectors.md, "Scenarios"; ADR 0013). Stub: W2-splits fills it.
 */
import type { MoneyExtension } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("W2-splits not merged");
};

/** A 2-way split proposed and accepted; a tip releases holds to both recipients. */
export async function stepSplitRelease(_ext: MoneyExtension): Promise<void> {
  notMerged();
}

/** A chargeback claws back per the policy (own lot first, owner absorbs, suspense); transparency lines. */
export async function stepSplitClawback(_ext: MoneyExtension): Promise<void> {
  notMerged();
}

/** A won chargeback restores each slice and cancels suspense first. */
export async function stepSplitWonChargeback(_ext: MoneyExtension): Promise<void> {
  notMerged();
}

/** A fresh recipient's extra hold, and their first payout held by the `new_payee` four-eyes check. */
export async function stepSplitNewPayee(_ext: MoneyExtension): Promise<void> {
  notMerged();
}
