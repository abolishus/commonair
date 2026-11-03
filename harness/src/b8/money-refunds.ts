// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` B8 extensions of M1-gifts-refunds (docs/testing/b8-selectors.md, "Scenarios"; ADR
 * 0007 Amendment 1): `gift-window` (a second unpaid gift inside the window is refused),
 * `auto-refund` (a signed `invoice.paid` for an ended subscription requests a refund, and
 * `charge.refunded` posts it), `refund-unknown` (an injected adapter timeout shows "unknown" to the
 * treasurer until a signed `charge.refunded` reconciles it) and `receipt-email` (the receipt lands
 * in Mailpit with its breakdown lines). The ledger balances after each. Stub entry points from the
 * batch 8 contract step: M1-gifts-refunds fills them.
 */
import type { MoneyB8Extension } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("M1-gifts-refunds not merged");
};

export async function stepGiftWindow(_ext: MoneyB8Extension): Promise<void> {
  notMerged();
}

export async function stepAutoRefund(_ext: MoneyB8Extension): Promise<void> {
  notMerged();
}

export async function stepRefundUnknown(_ext: MoneyB8Extension): Promise<void> {
  notMerged();
}

export async function stepReceiptEmail(_ext: MoneyB8Extension): Promise<void> {
  notMerged();
}
