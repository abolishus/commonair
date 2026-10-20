// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe events applied to payments, subscriptions, tips, disputes and payout accounts, with the
 * same postings, events and state transitions as the manual adapter (docs/testing/e4b-selectors.md,
 * README.md "Stripe"). Each action runs in the webhook's transaction; anything that needs the
 * network (the processor fee) is fetched first by `prepareStripeAction`, and provider calls that
 * must follow a commit (ending a Stripe subscription after a chargeback) are returned to the caller.
 *
 * How a Stripe object finds its payment: checkout sessions and first invoices carry our payment id
 * in metadata; once paid, a payment's `provider_ref` is the PaymentIntent id (or the invoice id
 * when an invoice was paid without one), which charges, refunds and disputes name.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  PAYOUT_ACCOUNT_NOT_READY,
  loadMoneySettings,
  lockPayoutBatch,
  paymentSucceeded,
  post,
  postChargebackReversal,
} from "@commonair/ledger";
import type { PaymentAdapter, StripeAction } from "@commonair/payments";
import { audit } from "../events/audit.ts";
import { addOneMonthUtc } from "./checkout-rules.ts";
import { endSubscriptions } from "./checkout-shared.ts";
import { confirmPaymentTx, reversePaymentTx } from "./checkout-treasurer.ts";

const { payments, subscriptions, tips, channels, disputes, payoutAccounts, payouts } = schema;
type PaymentRow = typeof payments.$inferSelect;
type DisputeAction = Extract<StripeAction, { chargeId: string | null; status: string }>;

export class StripeProcessingError extends Error {
  override name = "StripeProcessingError";
}

/** The Stripe-side facts fetched before the transaction opens. */
export interface PreparedAction {
  fee: { feeCents: number; currency: string } | null;
}

export interface AppliedAction {
  /** What happened, for the log (enums only). */
  outcome: string;
  /** Channel and subscribers whose chat badges must be refreshed after commit. */
  invalidate: { channelId: string; userIds: string[] }[];
  /** Stripe subscriptions to end after commit (our side already ended them). */
  cancelProviderSubscriptions: string[];
}

/** created_at is Postgres' clock, the event time Stripe's; allow them to disagree a little. */
const CLOCK_SKEW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noop = (outcome: string): AppliedAction => ({ outcome, invalidate: [], cancelProviderSubscriptions: [] });

/** The PaymentIntent whose fee a confirming action needs, if any. */
export function feeLookupRef(a: StripeAction): string | null {
  if (a.type === "checkout.completed" && a.mode === "payment" && a.paid) return a.paymentIntent;
  if (a.type === "invoice.paid" && a.amountPaid > 0) return a.paymentIntent;
  return null;
}

export async function prepareStripeAction(adapter: PaymentAdapter, a: StripeAction): Promise<PreparedAction> {
  const ref = feeLookupRef(a);
  if (!ref || !adapter.paymentFee) return { fee: null };
  return { fee: await adapter.paymentFee(ref) };
}

function feeFor(prepared: PreparedAction, currency: string): number {
  if (!prepared.fee) return 0;
  // The ledger posts in the payment's currency; a settlement in another currency cannot be booked.
  if (prepared.fee.currency !== currency)
    throw new StripeProcessingError(
      `the processor fee is in ${prepared.fee.currency}, the payment in ${currency}; settle Stripe in the instance currency`,
    );
  return prepared.fee.feeCents;
}

/** When the money arrived: Stripe's time, never before checkout (the hold) nor in the future. */
function arrival(at: Date, p: PaymentRow, now: Date): Date {
  const earliest = p.createdAt.getTime() - CLOCK_SKEW_MS;
  const t = Math.min(Math.max(at.getTime(), earliest, p.createdAt.getTime()), now.getTime());
  return new Date(t);
}

async function lockPaymentById(tx: Executor, id: string | null): Promise<PaymentRow | null> {
  if (!id || !UUID.test(id)) return null;
  const [p] = await tx.select().from(payments).where(eq(payments.id, id)).for("update");
  return p ?? null;
}

async function lockPaymentByRef(tx: Executor, ref: string | null): Promise<PaymentRow | null> {
  if (!ref) return null;
  const [p] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.provider, "stripe"), eq(payments.providerRef, ref)))
    .for("update");
  return p ?? null;
}

async function relock(tx: Executor, id: string): Promise<PaymentRow> {
  const [p] = await tx.select().from(payments).where(eq(payments.id, id)).for("update");
  if (!p) throw new StripeProcessingError("payment vanished");
  return p;
}

const paidSubscriptions = (p: PaymentRow) =>
  p.subscriptionId ? eq(subscriptions.id, p.subscriptionId) : eq(subscriptions.giftPaymentId, p.id);

/** Stripe subscription ids of a payment's subscriptions, to end at Stripe after a clawback. */
async function providerSubscriptionsOf(tx: Executor, p: PaymentRow): Promise<string[]> {
  const rows = await tx
    .select({ ref: subscriptions.providerRef })
    .from(subscriptions)
    .where(and(paidSubscriptions(p), eq(subscriptions.provider, "stripe")));
  return rows.flatMap((r) => (r.ref ? [r.ref] : []));
}

function checkAmount(p: PaymentRow, amount: number | null, currency: string | null) {
  if (currency !== null && currency !== p.currency)
    throw new StripeProcessingError(`Stripe charged ${currency}, the payment is in ${p.currency}`);
  if (amount !== null && amount !== p.amountCents)
    throw new StripeProcessingError(`Stripe charged ${amount} cents, the payment is for ${p.amountCents}`);
}

async function linkSubscription(tx: Executor, p: PaymentRow, stripeSubscription: string | null, now: Date) {
  if (!stripeSubscription || !p.subscriptionId) return;
  await tx
    .update(subscriptions)
    .set({ providerRef: stripeSubscription, updatedAt: now })
    .where(
      and(
        eq(subscriptions.id, p.subscriptionId),
        eq(subscriptions.provider, "stripe"),
        sql`${subscriptions.providerRef} is null`,
      ),
    );
}

async function confirmPending(
  tx: Executor,
  p: PaymentRow,
  o: {
    at: Date;
    now: Date;
    feeCents: number;
    taxCents: number;
    providerRef: string;
    periodEnd?: Date | null;
  },
): Promise<AppliedAction> {
  if (o.taxCents < 0 || o.taxCents > p.amountCents) throw new StripeProcessingError("tax out of range");
  const r = await confirmPaymentTx(tx, p, {
    receivedAt: arrival(o.at, p, o.now),
    now: o.now,
    feeCents: o.feeCents,
    taxCents: o.taxCents,
    providerRef: o.providerRef,
    periodEnd: o.periodEnd ?? null,
  });
  return {
    outcome: "confirmed",
    invalidate: [{ channelId: r.channelId, userIds: r.subscribers }],
    cancelProviderSubscriptions: [],
  };
}

function refuseFinished(p: PaymentRow): AppliedAction {
  // Stripe took money for a payment we already gave up on (expired): someone must refund it.
  if (p.status === "failed")
    throw new StripeProcessingError("Stripe reports a failed payment as paid; refund it in Stripe");
  return noop("already_processed");
}

// ------------------------------------------------------------------------------- handlers

async function checkoutCompleted(
  tx: Executor,
  a: Extract<StripeAction, { type: "checkout.completed" }>,
  prepared: PreparedAction,
  now: Date,
): Promise<AppliedAction> {
  const p = await lockPaymentById(tx, a.paymentId);
  if (!p || p.provider !== "stripe") return noop("unknown_payment");
  if (a.mode === "subscription") {
    // The first invoice (`invoice.paid`) carries the PaymentIntent, amount and period: it confirms.
    await linkSubscription(tx, p, a.subscription, now);
    return noop("subscription_linked");
  }
  if (!a.paid) return noop("awaiting_payment");
  if (p.status !== "pending") return refuseFinished(p);
  if (!a.paymentIntent) throw new StripeProcessingError("a paid checkout session has no PaymentIntent");
  checkAmount(p, a.amountTotal, a.currency);
  return confirmPending(tx, p, {
    at: a.at,
    now,
    feeCents: feeFor(prepared, p.currency),
    taxCents: a.taxCents,
    providerRef: a.paymentIntent,
  });
}

async function checkoutFailed(tx: Executor, paymentId: string, now: Date): Promise<AppliedAction> {
  const p = await lockPaymentById(tx, paymentId);
  if (!p || p.provider !== "stripe" || p.status !== "pending") return noop("not_pending");
  await tx
    .update(payments)
    .set({ status: "failed", updatedAt: now })
    .where(and(eq(payments.id, p.id), eq(payments.status, "pending")));
  // Never announced, so nothing to end publicly: the slot is just released.
  await tx
    .update(subscriptions)
    .set({ status: "expired", updatedAt: now })
    .where(and(paidSubscriptions(p), eq(subscriptions.status, "incomplete")));
  if (p.tipId)
    await tx
      .update(tips)
      .set({ status: "failed" })
      .where(and(eq(tips.id, p.tipId), eq(tips.status, "pending")));
  return noop("checkout_failed");
}

async function invoicePaid(
  tx: Executor,
  a: Extract<StripeAction, { type: "invoice.paid" }>,
  prepared: PreparedAction,
  now: Date,
): Promise<AppliedAction> {
  const moneyRef = a.paymentIntent ?? a.invoiceId;
  // A redelivered or second event for this invoice: the payment already carries its ref.
  const known = await lockPaymentByRef(tx, moneyRef);
  if (known) return noop("already_processed");

  // The first invoice of a checkout: its payment is ours already, waiting.
  const first = await lockPaymentById(tx, a.paymentId);
  if (first && first.provider === "stripe" && first.subscriptionId) {
    await linkSubscription(tx, first, a.subscription, now);
    if (first.status !== "pending") return refuseFinished(first);
    checkAmount(first, a.amountPaid, a.currency);
    return confirmPending(tx, first, {
      at: a.paidAt,
      now,
      feeCents: feeFor(prepared, first.currency),
      taxCents: a.taxCents,
      providerRef: moneyRef,
      periodEnd: a.periodEnd,
    });
  }

  // A renewal: find the subscription by Stripe's id.
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.provider, "stripe"), eq(subscriptions.providerRef, a.subscription)));
  if (!sub) {
    if (a.billingReason === "subscription_create")
      throw new StripeProcessingError("the first invoice names no payment of ours yet");
    throw new StripeProcessingError("no subscription of ours has this Stripe subscription id");
  }
  if (sub.status !== "active" && sub.status !== "past_due")
    throw new StripeProcessingError(`Stripe renewed a ${sub.status} subscription; cancel or refund it in Stripe`);
  const [c] = await tx.select().from(channels).where(eq(channels.id, sub.channelId));
  if (!c) throw new StripeProcessingError("the subscription's channel is gone");
  if (a.currency !== sub.currency)
    throw new StripeProcessingError(`Stripe charged ${a.currency}, the subscription is in ${sub.currency}`);
  const start = sub.currentPeriodEnd ?? a.paidAt;
  const end = a.periodEnd && a.periodEnd > start ? a.periodEnd : addOneMonthUtc(start);

  // Lock order: payment row before subscription rows. The new payment is ours alone until commit.
  if (a.amountPaid > 0) {
    if (a.taxCents < 0 || a.taxCents > a.amountPaid) throw new StripeProcessingError("tax out of range");
    const feeCents = feeFor(prepared, a.currency);
    const paymentId = uuidv7();
    const receivedAt = new Date(Math.min(a.paidAt.getTime(), now.getTime()));
    await tx.insert(payments).values({
      id: paymentId,
      provider: "stripe",
      providerRef: moneyRef,
      kind: "subscription",
      status: "succeeded",
      userId: sub.subscriberId,
      channelId: c.id,
      subscriptionId: sub.id,
      amountCents: a.amountPaid,
      taxCents: a.taxCents,
      feeCents,
      currency: a.currency,
      tier: sub.tier,
      quantity: 1,
      succeededAt: receivedAt,
    });
    const { cut } = await loadMoneySettings(tx);
    await post(
      tx,
      paymentSucceeded({
        paymentId,
        paymentKind: "subscription",
        provider: "stripe",
        settlement: "cash",
        creatorUserId: c.ownerId,
        grossCents: a.amountPaid,
        taxCents: a.taxCents,
        feeCents,
        currency: a.currency,
        cut,
        occurredAt: receivedAt,
      }),
    );
  }
  // Renewals emit no channel.subscribe (as the manual adapter).
  const [renewed] = await tx
    .update(subscriptions)
    .set({
      status: "active",
      currentPeriodStart: start,
      currentPeriodEnd: end,
      ...(a.amountPaid > 0 ? { priceCents: a.amountPaid } : {}),
      updatedAt: now,
    })
    .where(and(eq(subscriptions.id, sub.id), inArray(subscriptions.status, ["active", "past_due"])))
    .returning();
  if (!renewed) throw new StripeProcessingError("the subscription changed while renewing");
  return {
    outcome: "renewed",
    invalidate: sub.status === "past_due" ? [{ channelId: c.id, userIds: [sub.subscriberId] }] : [],
    cancelProviderSubscriptions: [],
  };
}

async function invoiceFailed(tx: Executor, stripeSubscription: string, now: Date): Promise<AppliedAction> {
  const [s] = await tx
    .update(subscriptions)
    .set({ status: "past_due", updatedAt: now })
    .where(
      and(
        eq(subscriptions.provider, "stripe"),
        eq(subscriptions.providerRef, stripeSubscription),
        eq(subscriptions.status, "active"),
      ),
    )
    .returning();
  // The badge stays while past_due; nothing for chat to refresh.
  return noop(s ? "past_due" : "not_active");
}

async function subscriptionDeleted(tx: Executor, stripeSubscription: string, now: Date): Promise<AppliedAction> {
  const [s] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.provider, "stripe"), eq(subscriptions.providerRef, stripeSubscription)));
  if (!s) return noop("unknown_subscription");
  const [c] = await tx.select().from(channels).where(eq(channels.id, s.channelId));
  if (!c) return noop("unknown_channel");
  const ended = await endSubscriptions(tx, c, eq(subscriptions.id, s.id), now);
  return {
    outcome: ended.length > 0 ? "canceled" : "already_ended",
    invalidate: [{ channelId: c.id, userIds: ended }],
    cancelProviderSubscriptions: [],
  };
}

async function chargeRefunded(
  tx: Executor,
  a: Extract<StripeAction, { type: "charge.refunded" }>,
  now: Date,
): Promise<AppliedAction> {
  let p = (await lockPaymentByRef(tx, a.paymentIntent)) ?? (await lockPaymentById(tx, a.paymentId));
  if (!p || p.provider !== "stripe") return noop("unknown_payment");
  if (a.currency !== p.currency) throw new StripeProcessingError("refund currency differs from the payment");
  const prior = await tx
    .select({ ref: disputes.providerRef, amount: disputes.amountCents })
    .from(disputes)
    .where(and(eq(disputes.paymentId, p.id), eq(disputes.kind, "refund")));
  const seen = new Set(prior.flatMap((d) => (d.ref ? [d.ref] : [])));
  const already = prior.reduce((sum, d) => sum + d.amount, 0);
  // Each refund once, by its id; without the list, the cumulative total says what is new.
  const fresh = a.refunds
    ? a.refunds.filter((r) => !seen.has(r.id))
    : a.amountRefunded > already
      ? [{ id: `${a.chargeId}:${a.amountRefunded}`, amountCents: a.amountRefunded - already }]
      : [];
  const result: AppliedAction = { outcome: "no_new_refund", invalidate: [], cancelProviderSubscriptions: [] };
  for (const r of fresh) {
    const done = await reversePaymentTx(tx, p, {
      kind: "refund",
      amountCents: r.amountCents,
      reason: null,
      providerRef: r.id,
      disputeStatus: "closed",
      now,
    });
    result.outcome = "refunded";
    result.invalidate.push({ channelId: done.channelId, userIds: done.ended });
    if (done.ended.length > 0) result.cancelProviderSubscriptions.push(...(await providerSubscriptionsOf(tx, p)));
    p = await relock(tx, p.id);
  }
  return result;
}

const isInquiry = (status: string) => status.startsWith("warning_");

async function disputeRow(tx: Executor, paymentId: string, ref: string) {
  const [d] = await tx
    .select()
    .from(disputes)
    .where(and(eq(disputes.paymentId, paymentId), eq(disputes.kind, "chargeback"), eq(disputes.providerRef, ref)))
    .for("update");
  return d ?? null;
}

async function clawBack(
  tx: Executor,
  p: PaymentRow,
  a: DisputeAction,
  status: "open" | "lost",
  now: Date,
): Promise<AppliedAction> {
  if (a.currency !== p.currency) throw new StripeProcessingError("dispute currency differs from the payment");
  const rest = p.amountCents - p.refundedCents;
  const amount = Math.min(a.amountCents, rest);
  if (amount <= 0) return noop("nothing_left_to_claw_back");
  const done = await reversePaymentTx(tx, p, {
    kind: "chargeback",
    amountCents: amount,
    reason: null,
    providerRef: a.disputeId,
    disputeStatus: status,
    disputeFeeCents: a.feeCents,
    now,
  });
  return {
    outcome: "charged_back",
    invalidate: [{ channelId: done.channelId, userIds: done.ended }],
    cancelProviderSubscriptions: await providerSubscriptionsOf(tx, p),
  };
}

async function disputeCreated(tx: Executor, a: DisputeAction, now: Date): Promise<AppliedAction> {
  // An inquiry withdraws nothing; only a real dispute claws back.
  if (isInquiry(a.status)) return noop("inquiry");
  const p = await lockPaymentByRef(tx, a.paymentIntent);
  if (!p) return noop("unknown_payment");
  if (await disputeRow(tx, p.id, a.disputeId)) return noop("already_processed");
  return clawBack(tx, p, a, "open", now);
}

async function disputeClosed(tx: Executor, a: DisputeAction, now: Date): Promise<AppliedAction> {
  const p = await lockPaymentByRef(tx, a.paymentIntent);
  if (!p) return noop("unknown_payment");
  const d = await disputeRow(tx, p.id, a.disputeId);
  const won = a.status === "won" || a.status === "warning_closed";
  if (!d) {
    // Closed before (or without) its created event reached us.
    if (!won) return clawBack(tx, p, a, "lost", now);
    // Record it so a late `created` cannot claw back what Stripe already returned.
    await tx.insert(disputes).values({
      paymentId: p.id,
      kind: "chargeback",
      status: "won",
      amountCents: a.amountCents,
      providerRef: a.disputeId,
      resolvedAt: now,
    });
    return noop("won_without_clawback");
  }
  if (d.status !== "open") return noop("already_processed");
  if (!won) {
    await tx.update(disputes).set({ status: "lost", resolvedAt: now }).where(eq(disputes.id, d.id));
    return noop("lost");
  }
  // Won: reinstate the creator share (postChargebackReversal), give the amount back to the payment.
  await postChargebackReversal(tx, { disputeId: d.id, occurredAt: now, feeRefundCents: a.feeRefundCents });
  await tx.update(disputes).set({ status: "won", resolvedAt: now }).where(eq(disputes.id, d.id));
  const refundedCents = Math.max(0, p.refundedCents - d.amountCents);
  const status = refundedCents === 0 ? "succeeded" : "partially_refunded";
  await tx.update(payments).set({ status, refundedCents, updatedAt: now }).where(eq(payments.id, p.id));
  if (p.tipId) await tx.update(tips).set({ status }).where(eq(tips.id, p.tipId));
  // Ended subscriptions stay ended: the payer may subscribe again.
  return noop("won");
}

async function accountUpdated(
  tx: Executor,
  a: Extract<StripeAction, { type: "account.updated" }>,
  now: Date,
): Promise<AppliedAction> {
  const { payoutRules } = await loadMoneySettings(tx);
  // Lock order: payout batch first, as setPayoutAccount (a run must not read a half-updated account).
  await lockPayoutBatch(tx, payoutRules.currency);
  const changed = await tx
    .update(payoutAccounts)
    .set({ payoutsEnabled: a.payoutsEnabled, updatedAt: now })
    .where(
      and(
        eq(payoutAccounts.provider, "stripe"),
        eq(payoutAccounts.providerAccountId, a.accountId),
        sql`${payoutAccounts.payoutsEnabled} is distinct from ${a.payoutsEnabled}`,
      ),
    )
    .returning({ userId: payoutAccounts.userId });
  for (const { userId } of changed) {
    const released = a.payoutsEnabled
      ? await tx
          .update(payouts)
          .set({ status: "pending", holdReason: null })
          .where(
            and(
              eq(payouts.userId, userId),
              eq(payouts.status, "held"),
              eq(payouts.holdReason, PAYOUT_ACCOUNT_NOT_READY),
            ),
          )
          .returning({ id: payouts.id })
      : [];
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: "payout_account.set",
      subjectType: "user",
      subjectId: userId,
      details: { provider: "stripe", payoutsEnabled: a.payoutsEnabled, payoutsReleased: released.length },
    });
  }
  return noop(changed.length > 0 ? "payout_account_updated" : "payout_account_unchanged");
}

/** Apply one normalized action in the caller's transaction. */
export async function applyStripeAction(
  tx: Executor,
  a: StripeAction,
  prepared: PreparedAction,
  now: Date,
): Promise<AppliedAction> {
  switch (a.type) {
    case "checkout.completed":
      return checkoutCompleted(tx, a, prepared, now);
    case "checkout.failed":
      return checkoutFailed(tx, a.paymentId, now);
    case "invoice.paid":
      return invoicePaid(tx, a, prepared, now);
    case "invoice.failed":
      return invoiceFailed(tx, a.subscription, now);
    case "subscription.deleted":
      return subscriptionDeleted(tx, a.subscription, now);
    case "charge.refunded":
      return chargeRefunded(tx, a, now);
    case "dispute.created":
      return disputeCreated(tx, a, now);
    case "dispute.closed":
      return disputeClosed(tx, a, now);
    case "account.updated":
      return accountUpdated(tx, a, now);
    case "ignored":
      return noop("ignored");
  }
}
