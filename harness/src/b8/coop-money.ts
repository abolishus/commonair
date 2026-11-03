// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e5-coop` B8 extensions of M1-coop-money (docs/testing/b8-selectors.md, "Scenarios"):
 * `share-stripe` (the step turns `shares.cardPayments` on, then a share is bought by card on
 * stripe-mock and membership is activated) and `patronage-payout` (an approved period is paid out
 * manually for one member and through Connect for the seeded Express member). The ledger balances
 * after each. Stub entry points from the batch 8 contract step: M1-coop-money fills them.
 */
import type { CoopB8Extension } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("M1-coop-money not merged");
};

export async function stepShareStripe(_ext: CoopB8Extension): Promise<void> {
  notMerged();
}

export async function stepPatronagePayout(_ext: CoopB8Extension): Promise<void> {
  notMerged();
}
