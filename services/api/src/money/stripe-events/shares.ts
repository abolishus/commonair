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
 * - `charge.dispute.*` (`shareDisputeOpened`, `shareDisputeClosed`; follow-ups, unit money): a
 *   chargeback claws the share capital back when it opens and freezes the share; lost ends the
 *   share and its membership; won restores the money. Each with its audit row and event.
 *
 * Calls made (conservative; post-launch review): the clawback is booked when the dispute opens, as
 * for every other card payment; the membership is untouched until the dispute is decided; a
 * partial dispute claws back only its amount, and a lost one still ends the whole share (what is
 * left on the member share account is the treasurer's to settle with the member).
 *
 * The processor fee is posted with the purchase (`sharePurchase`'s fee leg, `feeFor`): a missing
 * balance transaction answers 500, and Stripe's retry finds it attached, as for every other charge.
 */
import { and, eq, inArray } from "drizzle-orm";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { post, shareChargeback, shareChargebackReversal } from "@commonair/ledger";
import type { StripeAction } from "@commonair/payments";
import { bookShareTx, membershipEvent, releaseShareTx, shareChargeRefunded, shareEvent } from "../../coop/shares.ts";
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

// ── Chargebacks (follow-ups, unit money) ────────────────────────────────────────────────────

type DisputeAction = Extract<StripeAction, { type: "dispute.created" | "dispute.closed" }>;
type ShareRow = typeof schema.membershipShares.$inferSelect;
type DisputeRow = typeof schema.disputes.$inferSelect;

export const SHARE_DISPUTED = "coop.share.dispute";
export const SHARE_DISPUTE_LOST = "coop.share.dispute_lost";
export const SHARE_DISPUTE_WON = "coop.share.dispute_won";
export const SHARE_DISPUTE_UNMATCHED = "coop.share.dispute_unmatched";
/** The share states a chargeback can claw back: the money was booked and not returned. */
const DISPUTABLE: readonly ShareRow["status"][] = ["held", "refund_pending"];

/** Whether a closed dispute's status is a win for the co-op (Stripe's `won`, or a closed inquiry). */
export const disputeWon = (status: string): boolean => status === "won" || status === "warning_closed";

async function shareOf(tx: Executor, paymentId: string): Promise<ShareRow | null> {
  const [share] = await tx
    .select()
    .from(schema.membershipShares)
    .where(eq(schema.membershipShares.paymentId, paymentId))
    .for("update");
  return share ?? null;
}

async function disputeOf(tx: Executor, paymentId: string, ref: string): Promise<DisputeRow | null> {
  const [d] = await tx
    .select()
    .from(schema.disputes)
    .where(
      and(
        eq(schema.disputes.paymentId, paymentId),
        eq(schema.disputes.kind, "chargeback"),
        eq(schema.disputes.providerRef, ref),
      ),
    )
    .for("update");
  return d ?? null;
}

/**
 * A dispute opened on a card share's payment (locked by the caller), or one that reached us closed
 * and lost first. Stripe withdraws the money when the dispute opens, so, as for every other card
 * payment (`clawBack` in `stripe-events.ts`), the ledger follows at once: the `shareChargeback`
 * posting (Dr the member share, Cr `cash:stripe`, the dispute fee as the co-op's expense), the
 * dispute row, and the payment `charged_back`. The share keeps its status but is frozen: the
 * database refuses to refund it while the chargeback stands (migration 0050), and the membership
 * is left as it is until the outcome is known. A share that was never booked or was already
 * refunded posts nothing: the dispute is recorded and audited for the treasurer.
 */
export async function shareDisputeOpened(
  tx: Executor,
  payment: PaymentRow,
  a: DisputeAction,
  now: Date,
  status: "open" | "lost" = "open",
): Promise<AppliedAction> {
  if (a.currency !== payment.currency) throw new StripeProcessingError("dispute currency differs from the payment");
  if (await disputeOf(tx, payment.id, a.disputeId)) return noop("already_processed");
  const share = await shareOf(tx, payment.id);
  const rest = payment.amountCents - payment.refundedCents;
  const amount = Math.min(a.amountCents, rest);
  const disputeId = uuidv7();
  await tx.insert(schema.disputes).values({
    id: disputeId,
    paymentId: payment.id,
    kind: "chargeback",
    status,
    amountCents: Math.max(amount, 0),
    providerRef: a.disputeId,
    reason: null,
    resolvedAt: status === "open" ? null : now,
  });
  if (!share || !DISPUTABLE.includes(share.status) || amount <= 0) {
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: SHARE_DISPUTE_UNMATCHED,
      subjectType: "payment",
      subjectId: payment.id,
      details: {
        paymentId: payment.id,
        shareId: share?.id ?? null,
        disputeId,
        amountCents: a.amountCents,
        shareStatus: share?.status ?? null,
      },
    });
    return noop("share_dispute_unmatched");
  }
  await post(
    tx,
    shareChargeback({
      disputeId,
      shareId: share.id,
      userId: share.userId,
      provider: payment.provider,
      settlement: "cash",
      amountCents: amount,
      disputeFeeCents: a.feeCents,
      currency: payment.currency,
      occurredAt: now,
    }),
  );
  await tx
    .update(schema.payments)
    .set({ status: "charged_back", refundedCents: payment.refundedCents + amount, updatedAt: now })
    .where(eq(schema.payments.id, payment.id));
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: SHARE_DISPUTED,
    subjectType: "membership_share",
    subjectId: share.id,
    details: { shareId: share.id, paymentId: payment.id, disputeId, amountCents: amount, shareStatus: share.status },
  });
  // The share's status is unchanged, but what it is worth is not: subscribers re-read it.
  await shareEvent(tx, share, now);
  if (status === "lost") await shareDisputeLostTx(tx, payment, share, disputeId, now);
  return noop(status === "lost" ? "share_charged_back_lost" : "share_charged_back");
}

/**
 * A lost dispute ends the share (the chargeback already took the money): the share becomes
 * `cancelled`, which frees the member's one open share, and a viewer membership that rests on it
 * exits, with their audit rows and events. The database allows that cancel only while the
 * chargeback stands (0050).
 */
async function shareDisputeLostTx(
  tx: Executor,
  payment: PaymentRow,
  share: ShareRow,
  disputeId: string,
  now: Date,
): Promise<void> {
  const [ended] = await tx
    .update(schema.membershipShares)
    .set({ status: "cancelled" })
    .where(and(eq(schema.membershipShares.id, share.id), inArray(schema.membershipShares.status, [...DISPUTABLE])))
    .returning();
  if (!ended) throw new StripeProcessingError("the share changed while its dispute closed");
  const exited = await tx
    .update(schema.memberships)
    .set({ status: "exited", exitedAt: now })
    .where(
      and(
        eq(schema.memberships.userId, share.userId),
        eq(schema.memberships.class, "viewer"),
        eq(schema.memberships.basis, "share"),
        eq(schema.memberships.status, "active"),
      ),
    )
    .returning();
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: SHARE_DISPUTE_LOST,
    subjectType: "membership_share",
    subjectId: share.id,
    details: {
      shareId: share.id,
      paymentId: payment.id,
      disputeId,
      membershipIds: exited.map((m) => m.id),
    },
  });
  await shareEvent(tx, ended, now);
  for (const m of exited) {
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: "membership.exit",
      subjectType: "membership",
      subjectId: m.id,
      reason: "share charged back",
      details: { class: m.class, basis: m.basis, shareId: share.id },
    });
    await membershipEvent(tx, m, now);
  }
}

/**
 * A dispute on a card share's payment closed (payment locked by the caller). Lost: the share ends
 * (`shareDisputeLostTx`). Won: `shareChargebackReversal` returns the money and the member's share
 * capital, and the payment is restored; the share and membership never changed, so nothing else
 * moves. A dispute we never saw open is booked and ended at once when lost, and recorded (so a late
 * `created` claws nothing back) when won. A redelivery changes nothing.
 */
export async function shareDisputeClosed(
  tx: Executor,
  payment: PaymentRow,
  a: DisputeAction,
  now: Date,
): Promise<AppliedAction> {
  const won = disputeWon(a.status);
  const d = await disputeOf(tx, payment.id, a.disputeId);
  if (!d) {
    if (!won) return shareDisputeOpened(tx, payment, a, now, "lost");
    await tx.insert(schema.disputes).values({
      paymentId: payment.id,
      kind: "chargeback",
      status: "won",
      amountCents: a.amountCents,
      providerRef: a.disputeId,
      resolvedAt: now,
    });
    return noop("won_without_clawback");
  }
  if (d.status !== "open") return noop("already_processed");
  await tx
    .update(schema.disputes)
    .set({ status: won ? "won" : "lost", resolvedAt: now })
    .where(eq(schema.disputes.id, d.id));
  const [booked] = await tx
    .select({ id: schema.ledgerTransactions.id })
    .from(schema.ledgerTransactions)
    .where(eq(schema.ledgerTransactions.idempotencyKey, `share-chargeback:${d.id}`));
  // An unmatched dispute (nothing was clawed back) only records its outcome.
  if (!booked) return noop(won ? "share_dispute_won_unmatched" : "share_dispute_lost_unmatched");
  const share = await shareOf(tx, payment.id);
  if (!share) throw new StripeProcessingError("the disputed share vanished");
  if (!won) {
    await shareDisputeLostTx(tx, payment, share, d.id, now);
    return noop("share_dispute_lost");
  }
  await post(
    tx,
    shareChargebackReversal({
      disputeId: d.id,
      shareId: share.id,
      userId: share.userId,
      provider: payment.provider,
      settlement: "cash",
      amountCents: d.amountCents,
      feeRefundCents: a.feeRefundCents,
      currency: payment.currency,
      occurredAt: now,
      chargebackTransactionId: booked.id,
    }),
  );
  const refundedCents = Math.max(0, payment.refundedCents - d.amountCents);
  await tx
    .update(schema.payments)
    .set({ status: refundedCents === 0 ? "succeeded" : "partially_refunded", refundedCents, updatedAt: now })
    .where(eq(schema.payments.id, payment.id));
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: SHARE_DISPUTE_WON,
    subjectType: "membership_share",
    subjectId: share.id,
    details: { shareId: share.id, paymentId: payment.id, disputeId: d.id, amountCents: d.amountCents },
  });
  await shareEvent(tx, share, now);
  return noop("share_dispute_won");
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
