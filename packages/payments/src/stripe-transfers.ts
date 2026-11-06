// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe Connect transfers (batch 8, M1-connect; ADR 0007 Amendment 1, decision (f)). The stripe
 * adapter's `transfer` calls this: one transfer per payout row, to the payee's Express account,
 * under the payout's own idempotency key, so every retry (and every redelivered job) gets Stripe's
 * first answer back instead of a second transfer.
 *
 * What goes to Stripe is ids, cents and the run's period start only: never a name, an email or a
 * free-text description (ADR 0004). Live keys never get this far: `stripeClient` refuses them
 * before it exists (`assertTestKey`).
 */
import type { TransferRequest, TransferResult, TransferStatus } from "./adapter.ts";
import { StripeOutcomeUnknown, StripeRequestError } from "./errors.ts";
import type { FormObject } from "./stripe-form.ts";
import type { StripeClient, StripeTransfer } from "./stripe-client.ts";

/**
 * The idempotency key of a payout's transfer: stable across retries, one per payout row. The ledger's
 * `payoutTransferKey` writes the row's key (payments does not depend on the ledger); both tests pin
 * the format `payout-transfer:<payoutId>`, and `transferParams` refuses any other.
 */
export const payoutTransferKey = (payoutId: string): string => `payout-transfer:${payoutId}`;

const ACCOUNT = /^acct_[A-Za-z0-9]{1,250}$/;
const CURRENCY = /^[a-z]{3}$/;

/** The `POST /v1/transfers` form for a request (exported for tests). Refuses what Stripe must never see. */
export function transferParams(r: TransferRequest): FormObject {
  // Zero is never transferred (a payout of 0 is below any minimum, and the table refuses it too).
  if (!Number.isSafeInteger(r.amountCents) || r.amountCents <= 0) throw new RangeError("amount must be positive cents");
  if (!CURRENCY.test(r.currency)) throw new RangeError("currency must be a lowercase ISO 4217 code");
  if (!ACCOUNT.test(r.destination)) throw new RangeError("the destination is not a Stripe connected account");
  if (!r.payoutId || !r.transferId || !r.group) throw new RangeError("a transfer names its payout, row and run");
  if (r.idempotencyKey !== payoutTransferKey(r.payoutId))
    throw new RangeError("a payout's transfer is sent under payout-transfer:<payoutId>");
  return {
    amount: r.amountCents,
    currency: r.currency,
    destination: r.destination,
    transfer_group: r.group,
    // Ids only: the webhook finds the row by them (`stripe-events.ts` METADATA_KEYS).
    metadata: { payout_id: r.payoutId, transfer_id: r.transferId },
  };
}

/**
 * Stripe's transfer as the adapter's result. An answer for another amount, currency or account
 * than asked is not ours to record: Stripe may still have moved money, so it is an unknown outcome
 * (the caller keeps the row pending for a person to look at), never a success.
 */
export function transferResultOf(r: TransferRequest, t: StripeTransfer): TransferResult {
  if (t.amount !== r.amountCents || t.currency !== r.currency || t.destination !== r.destination)
    throw new StripeOutcomeUnknown("Stripe answered with a transfer that does not match the request", 502, null, null);
  return { providerRef: t.id, amountCents: t.amount, currency: t.currency };
}

export async function stripeTransfer(client: StripeClient, request: TransferRequest): Promise<TransferResult> {
  const params = transferParams(request);
  return transferResultOf(request, await client.createTransfer(params, request.idempotencyKey));
}

/** Stripe's transfer as the adapter's `TransferStatus` (exported for tests). */
export const transferStatusOf = (t: StripeTransfer): TransferStatus => ({
  providerRef: t.id,
  amountCents: t.amount,
  currency: t.currency,
  destination: t.destination,
  reversedCents: t.amountReversed,
  metadata: t.metadata,
});

const TRANSFER_ID = /^tr_[A-Za-z0-9]{1,250}$/;

/** One transfer by id, or null when Stripe has none (a 404, or an id that is not a transfer's). */
export async function stripeTransferStatus(client: StripeClient, transferRef: string): Promise<TransferStatus | null> {
  if (!TRANSFER_ID.test(transferRef)) return null;
  try {
    return transferStatusOf(await client.retrieveTransfer(transferRef));
  } catch (err) {
    // A definite "no such transfer"; anything else is the caller's to retry.
    if (err instanceof StripeRequestError && err.status === 404) return null;
    throw err;
  }
}

/** Every transfer to an account in one payout run (`PaymentAdapter.listTransfers`). */
export async function stripeListTransfers(
  client: StripeClient,
  q: { destination: string; group: string },
): Promise<TransferStatus[]> {
  if (!ACCOUNT.test(q.destination)) throw new RangeError("the destination is not a Stripe connected account");
  return (await client.listTransfers({ destination: q.destination, transferGroup: q.group })).map(transferStatusOf);
}
