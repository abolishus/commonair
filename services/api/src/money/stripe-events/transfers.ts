// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Connect transfer webhooks (batch 8, M1-connect; ADR 0007 Amendment 1, decision (f)), in the
 * webhook's transaction. `transfer.reversed` and `transfer.updated` carry Stripe's cumulative
 * `amount_reversed`; the increase over our `reversed_cents` posts `payoutTransferReversed` (the
 * payee's payable gets it back, so a later run pays it), raises `reversed_cents`, and writes the
 * `money.payout_transfer.reversed` event and a system audit row. A redelivery finds nothing new.
 *
 * The transfer is found by Stripe's id, or by our row id in its metadata: an event may arrive
 * before the worker recorded `created`. Then the event settles it first (Stripe has the transfer),
 * under the same row locks as the worker. A transfer that is not ours (a patronage payout, another
 * platform's) is `ignored`; one that does not match its row is `transfer_mismatch`. A transfer on a
 * row we failed (its payout was cancelled back to the payable, so the payee may be paid twice) posts
 * nothing but writes a `payout_transfer.orphaned` system audit row for the treasurer to reconcile
 * (`transfer_orphaned`).
 */
import type { Executor } from "@commonair/db";
import {
  PAYOUT_TRANSFER_CODES,
  PayoutStateError,
  findPayoutTransfer,
  markPayoutTransferUnsettled,
  recordOrphanedPayoutTransfer,
  recordPayoutTransferCreated,
  recordPayoutTransferReversal,
} from "@commonair/ledger";
import type { StripeAction } from "@commonair/payments";
import { patronageTransferEvent } from "../../coop/patronage-payouts.ts";
import { type AppliedAction, StripeProcessingError } from "../stripe-events.ts";

type TransferAction = Extract<StripeAction, { type: "transfer.reversed" | "transfer.updated" }>;

const noop = (outcome: string): AppliedAction => ({ outcome, invalidate: [], cancelProviderSubscriptions: [] });

/** Whether the event's transfer is the row's: the same id (once known), amount, currency and account. */
export function matchesTransfer(
  row: { payoutId: string; providerRef: string | null; amountCents: number; currency: string; destinationRef: string },
  a: Pick<TransferAction, "transferRef" | "payoutId" | "amountCents" | "currency" | "destination">,
): boolean {
  if (row.providerRef !== null && row.providerRef !== a.transferRef) return false;
  if (a.payoutId !== null && a.payoutId !== row.payoutId) return false;
  if (a.destination !== null && a.destination !== row.destinationRef) return false;
  return row.amountCents === a.amountCents && row.currency === a.currency;
}

async function applyTransfer(tx: Executor, a: TransferAction, now: Date): Promise<AppliedAction> {
  const row = await findPayoutTransfer(tx, { providerRef: a.transferRef, transferId: a.transferId });
  // Not a creator payout: a co-op patronage payout sent through Connect (M1-coop-money), or nothing.
  if (!row) return (await patronageTransferEvent(tx, a, now)) ?? noop("ignored");
  if (!matchesTransfer(row, a)) return noop("transfer_mismatch");
  if (row.status === "failed") {
    await recordOrphanedPayoutTransfer(tx, { transferId: row.id, providerRef: a.transferRef, at: now });
    return noop("transfer_orphaned");
  }
  let current = row;
  let settled = false;
  if (row.status === "pending") {
    try {
      const r = await recordPayoutTransferCreated(tx, { transferId: row.id, providerRef: a.transferRef, at: now });
      current = r.transfer;
      settled = r.created;
    } catch (err) {
      if (!(err instanceof PayoutStateError)) throw err;
      // The payout left `scheduled` (a fraud hold): keep Stripe's id; never cancelled from here on.
      // A reversal cannot be booked against an unrecorded transfer: answer 500 so Stripe redelivers.
      if (a.amountReversed > 0)
        throw new StripeProcessingError("the transfer is not recorded as created yet; retry later");
      await markPayoutTransferUnsettled(tx, {
        transferId: row.id,
        code: PAYOUT_TRANSFER_CODES.sentUnrecorded,
        providerRef: a.transferRef,
        at: now,
      });
      return noop("transfer_pending");
    }
  }
  if (a.amountReversed > current.reversedCents) {
    const r = await recordPayoutTransferReversal(tx, {
      transferId: row.id,
      reversedTotalCents: a.amountReversed,
      at: now,
    });
    if (r.postedCents > 0) return noop("transfer_reversed");
  }
  return noop(settled ? "transfer_created" : "duplicate");
}

export async function transferReversed(tx: Executor, a: TransferAction, now: Date): Promise<AppliedAction> {
  return applyTransfer(tx, a, now);
}

export async function transferUpdated(tx: Executor, a: TransferAction, now: Date): Promise<AppliedAction> {
  return applyTransfer(tx, a, now);
}
