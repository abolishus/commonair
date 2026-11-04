// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe events for a co-op share paid by card (batch 8, M1-coop-money; ADR 0020), each in the
 * webhook's transaction with the payment row locked:
 *
 * - `checkout.completed` (`shareCheckoutCompleted`): the payment `succeeded` with its
 *   PaymentIntent, the `share_purchase` posting, the share `held` and the viewer membership
 *   activated, with their audit rows and outbox events, in this one transaction
 *   (`coop/shares.ts` `bookShareTx`). A member who left while the checkout was open is booked and
 *   set `refund_pending` instead. A redelivery finds the payment no longer pending.
 * - `checkout.failed` (`shareCheckoutFailed`): the pending share is cancelled with the payment.
 * - `charge.refunded` (`shareChargeRefundedAction`): the `shareRefund` posting (`coop/shares.ts`).
 *
 * The processor fee is posted with the purchase (`sharePurchase`'s fee leg, `feeFor`): a missing
 * balance transaction answers 500, and Stripe's retry finds it attached, as for every other charge.
 */
import { and, eq } from "drizzle-orm";
import { type Executor, schema } from "@commonair/db";
import type { StripeAction } from "@commonair/payments";
import { bookShareTx, releaseShareTx, shareChargeRefunded } from "../../coop/shares.ts";
import { audit } from "../../events/audit.ts";
import { type AppliedAction, type PreparedAction, StripeProcessingError, feeFor } from "../stripe-events.ts";

type PaymentRow = typeof schema.payments.$inferSelect;
type CheckoutCompleted = Extract<StripeAction, { type: "checkout.completed" }>;

/** created_at is Postgres' clock, the event time Stripe's; allow them to disagree a little. */
const CLOCK_SKEW_MS = 60_000;

const noop = (outcome: string): AppliedAction => ({ outcome, invalidate: [], cancelProviderSubscriptions: [] });

/** When the money arrived: Stripe's time, never before the checkout started nor in the future. */
export function shareArrival(at: Date, createdAt: Date, now: Date): Date {
  const earliest = createdAt.getTime() - CLOCK_SKEW_MS;
  return new Date(Math.min(Math.max(at.getTime(), earliest, createdAt.getTime()), now.getTime()));
}

export async function shareCheckoutCompleted(
  tx: Executor,
  payment: PaymentRow,
  a: CheckoutCompleted,
  prepared: PreparedAction,
  now: Date,
  _generic: () => Promise<AppliedAction>,
): Promise<AppliedAction> {
  // A share is one payment, never a subscription.
  if (a.mode !== "payment") return noop("ignored");
  if (!a.paid) return noop("awaiting_payment");
  if (payment.status !== "pending") {
    // Stripe took money for a share we already gave up on (expired): someone must refund it there.
    if (payment.status === "failed")
      throw new StripeProcessingError("Stripe reports a failed share payment as paid; refund it in Stripe");
    return noop("already_processed");
  }
  if (!a.paymentIntent) throw new StripeProcessingError("a paid checkout session has no PaymentIntent");
  if (a.currency !== null && a.currency !== payment.currency)
    throw new StripeProcessingError(`Stripe charged ${a.currency}, the share is in ${payment.currency}`);
  if (a.amountTotal !== null && a.amountTotal !== payment.amountCents)
    throw new StripeProcessingError(`Stripe charged ${a.amountTotal} cents, the share is ${payment.amountCents}`);
  const feeCents = feeFor(prepared, payment.currency);
  const outcome = await bookShareTx(tx, payment, {
    feeCents,
    receivedAt: shareArrival(a.at, payment.createdAt, now),
    now,
    actor: { type: "system", id: null },
    providerRef: a.paymentIntent,
    refundIfLeft: true,
  });
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: "payment.confirm",
    subjectType: "payment",
    subjectId: payment.id,
    details: { paymentId: payment.id, kind: payment.kind, provider: payment.provider, outcome },
  });
  return {
    outcome: outcome === "refund_pending" ? "share_refund_pending" : "share_confirmed",
    invalidate: [],
    cancelProviderSubscriptions: [],
    receipts: [payment.id],
  };
}

/** `checkout.failed` for a share payment (locked by the caller): payment failed, share cancelled. */
export async function shareCheckoutFailed(tx: Executor, payment: PaymentRow, now: Date): Promise<AppliedAction> {
  if (payment.status !== "pending") return noop("not_pending");
  await tx
    .update(schema.payments)
    .set({ status: "failed", updatedAt: now })
    .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, "pending")));
  await releaseShareTx(tx, payment.id, now, "share checkout failed");
  return noop("checkout_failed");
}

/** `charge.refunded` for a share payment (locked by the caller). */
export async function shareChargeRefundedAction(
  tx: Executor,
  payment: PaymentRow,
  a: Extract<StripeAction, { type: "charge.refunded" }>,
  now: Date,
): Promise<AppliedAction> {
  if (a.currency !== payment.currency) throw new StripeProcessingError("refund currency differs from the payment");
  return noop(await shareChargeRefunded(tx, payment, a, now));
}
