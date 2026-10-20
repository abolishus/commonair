// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe webhook events → normalized actions (pure; the API applies them). Shapes are those of
 * `STRIPE_API_VERSION` (2024-06-20), with the later `parent.subscription_details` location read
 * too. Types the platform does not act on parse to `{ type: "ignored" }`; a handled type missing
 * a field it needs throws `StripeEventError` (stored on the event, answered 500 so Stripe retries).
 */

export class StripeEventError extends Error {
  override name = "StripeEventError";
}

export interface StripeEventEnvelope {
  id: string;
  type: string;
  /** Unix seconds. */
  created: number;
  livemode: boolean;
  object: Record<string, unknown>;
}

export interface StripeRefundItem {
  id: string;
  amountCents: number;
}

export type StripeAction =
  | {
      type: "checkout.completed";
      paymentId: string;
      mode: "payment" | "subscription";
      paid: boolean;
      paymentIntent: string | null;
      subscription: string | null;
      amountTotal: number | null;
      taxCents: number;
      currency: string | null;
      at: Date;
    }
  | { type: "checkout.failed"; paymentId: string }
  | {
      type: "invoice.paid";
      invoiceId: string;
      subscription: string;
      billingReason: string | null;
      /** Our payment id from the subscription's metadata (the first invoice of a checkout). */
      paymentId: string | null;
      paymentIntent: string | null;
      amountPaid: number;
      taxCents: number;
      currency: string;
      paidAt: Date;
      periodEnd: Date | null;
    }
  | { type: "invoice.failed"; subscription: string }
  | { type: "subscription.deleted"; subscription: string }
  | {
      type: "charge.refunded";
      chargeId: string;
      paymentIntent: string | null;
      paymentId: string | null;
      amountRefunded: number;
      currency: string;
      /** The refunds listed on the charge, when the event carries them. */
      refunds: StripeRefundItem[] | null;
    }
  | {
      type: "dispute.created" | "dispute.closed";
      disputeId: string;
      chargeId: string | null;
      paymentIntent: string | null;
      amountCents: number;
      currency: string;
      status: string;
      /** Dispute fees Stripe withdrew (positive fees on the dispute's balance transactions). */
      feeCents: number;
      /** Dispute fees Stripe gave back (a won dispute's reinstatement). */
      feeRefundCents: number;
    }
  | { type: "account.updated"; accountId: string; payoutsEnabled: boolean }
  | { type: "ignored" };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
/** An expandable field: the id string, or the expanded object's id. */
const ref = (v: unknown): string | null => str(v) ?? (isObj(v) ? str(v.id) : null);
const meta = (o: unknown, key: string): string | null => (isObj(o) && isObj(o.metadata) ? str(o.metadata[key]) : null);
const date = (s: number) => new Date(s * 1000);

function need<T>(v: T | null, what: string): T {
  if (v === null) throw new StripeEventError(`event is missing ${what}`);
  return v;
}

/** The envelope of a parsed webhook body, or null if it is not a Stripe event. */
export function stripeEnvelope(body: unknown): StripeEventEnvelope | null {
  if (!isObj(body) || body.object !== "event") return null;
  const id = str(body.id);
  const type = str(body.type);
  const created = int(body.created);
  const object = isObj(body.data) && isObj(body.data.object) ? body.data.object : null;
  if (!id || !type || created === null || !object) return null;
  return { id, type, created, livemode: body.livemode === true, object };
}

function invoiceSubscription(o: Obj): string | null {
  if (ref(o.subscription)) return ref(o.subscription);
  const parent = isObj(o.parent) ? o.parent : null;
  const details = parent && isObj(parent.subscription_details) ? parent.subscription_details : null;
  return details ? ref(details.subscription) : null;
}

function invoicePaymentId(o: Obj): string | null {
  const details = isObj(o.subscription_details)
    ? o.subscription_details
    : isObj(o.parent) && isObj(o.parent.subscription_details)
      ? o.parent.subscription_details
      : null;
  return meta(details, "payment_id");
}

function invoicePeriodEnd(o: Obj): Date | null {
  const lines = isObj(o.lines) && Array.isArray(o.lines.data) ? o.lines.data : [];
  for (const line of lines) {
    if (isObj(line) && isObj(line.period)) {
      const end = int(line.period.end);
      if (end !== null) return date(end);
    }
  }
  return null;
}

function disputeFees(o: Obj): { feeCents: number; feeRefundCents: number } {
  let feeCents = 0;
  let feeRefundCents = 0;
  const txns = Array.isArray(o.balance_transactions) ? o.balance_transactions : [];
  for (const t of txns) {
    const fee = isObj(t) ? int(t.fee) : null;
    if (fee === null) continue;
    if (fee > 0) feeCents += fee;
    else feeRefundCents += -fee;
  }
  return { feeCents, feeRefundCents };
}

export function stripeAction(e: StripeEventEnvelope): StripeAction {
  const o = e.object;
  switch (e.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const mode = str(o.mode);
      if (mode !== "payment" && mode !== "subscription") return { type: "ignored" };
      const paymentId = meta(o, "payment_id") ?? str(o.client_reference_id);
      const totals = isObj(o.total_details) ? o.total_details : {};
      return {
        type: "checkout.completed",
        paymentId: need(paymentId, "metadata.payment_id"),
        mode,
        paid: o.payment_status === "paid" || o.payment_status === "no_payment_required",
        paymentIntent: ref(o.payment_intent),
        subscription: ref(o.subscription),
        amountTotal: int(o.amount_total),
        taxCents: int(totals.amount_tax) ?? 0,
        currency: str(o.currency)?.toLowerCase() ?? null,
        at: date(e.created),
      };
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const paymentId = meta(o, "payment_id") ?? str(o.client_reference_id);
      return { type: "checkout.failed", paymentId: need(paymentId, "metadata.payment_id") };
    }
    case "invoice.paid": {
      const transitions = isObj(o.status_transitions) ? o.status_transitions : {};
      return {
        type: "invoice.paid",
        invoiceId: need(str(o.id), "invoice id"),
        subscription: need(invoiceSubscription(o), "invoice subscription"),
        billingReason: str(o.billing_reason),
        paymentId: invoicePaymentId(o),
        paymentIntent: ref(o.payment_intent),
        amountPaid: need(int(o.amount_paid), "amount_paid"),
        taxCents: int(o.tax) ?? 0,
        currency: need(str(o.currency), "currency").toLowerCase(),
        paidAt: date(int(transitions.paid_at) ?? e.created),
        periodEnd: invoicePeriodEnd(o),
      };
    }
    case "invoice.payment_failed":
      return { type: "invoice.failed", subscription: need(invoiceSubscription(o), "invoice subscription") };
    case "customer.subscription.deleted":
      return { type: "subscription.deleted", subscription: need(str(o.id), "subscription id") };
    case "charge.refunded": {
      const list = isObj(o.refunds) && Array.isArray(o.refunds.data) ? o.refunds.data : null;
      const refunds = list
        ? list.flatMap((r): StripeRefundItem[] => {
            if (!isObj(r) || (r.status !== undefined && r.status !== "succeeded" && r.status !== "pending")) return [];
            const id = str(r.id);
            const amount = int(r.amount);
            return id && amount !== null && amount > 0 ? [{ id, amountCents: amount }] : [];
          })
        : null;
      return {
        type: "charge.refunded",
        chargeId: need(str(o.id), "charge id"),
        paymentIntent: ref(o.payment_intent),
        paymentId: meta(o, "payment_id"),
        amountRefunded: need(int(o.amount_refunded), "amount_refunded"),
        currency: need(str(o.currency), "currency").toLowerCase(),
        refunds,
      };
    }
    case "charge.dispute.created":
    case "charge.dispute.closed":
      return {
        type: e.type === "charge.dispute.created" ? "dispute.created" : "dispute.closed",
        disputeId: need(str(o.id), "dispute id"),
        chargeId: ref(o.charge),
        paymentIntent: ref(o.payment_intent),
        amountCents: need(int(o.amount), "amount"),
        currency: need(str(o.currency), "currency").toLowerCase(),
        status: need(str(o.status), "status"),
        ...disputeFees(o),
      };
    case "account.updated":
      return {
        type: "account.updated",
        accountId: need(str(o.id), "account id"),
        payoutsEnabled: o.payouts_enabled === true,
      };
    default:
      return { type: "ignored" };
  }
}
