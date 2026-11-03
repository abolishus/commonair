// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` B8 extensions of M1-connect (docs/testing/b8-selectors.md, "Scenarios"; ADR 0007
 * Amendment 1): `connect-transfer` (a payout run pays the seeded Express creator, and the transfer
 * exists on stripe-mock) and `transfer-reversed` (a signed `transfer.reversed` returns the amount
 * to the payable). The ledger balances after each. Stub entry points from the batch 8 contract
 * step: M1-connect fills them.
 */
import type { MoneyB8Extension } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("M1-connect not merged");
};

export async function stepConnectTransfer(_ext: MoneyB8Extension): Promise<void> {
  notMerged();
}

export async function stepTransferReversed(_ext: MoneyB8Extension): Promise<void> {
  notMerged();
}
