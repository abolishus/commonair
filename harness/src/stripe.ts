// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe events for `e4b-money --set provider=stripe` (ADR 0003 §7): stripe-mock is stateless and
 * never sends webhooks, so the harness builds the events Stripe would send after a checkout,
 * refund or dispute, signs them with the instance's webhook secret using Stripe's documented
 * scheme (`Stripe-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`) and posts them to the API.
 * Event shapes follow Stripe API version 2024-06-20 (what the API pins).
 */

export const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";
export const STRIPE_EVENT_API_VERSION = "2024-06-20";

/**
 * The instance's `STRIPE_WEBHOOK_SECRET`. Read from the process env until the harness env schema
 * carries `HARNESS_STRIPE_WEBHOOK_SECRET` (contract request); Bun loads the repo `.env`, so the
 * instance's own `STRIPE_WEBHOOK_SECRET` is the fallback.
 */
export function stripeWebhookSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env.HARNESS_STRIPE_WEBHOOK_SECRET?.trim() || env.STRIPE_WEBHOOK_SECRET?.trim();
  return v || undefined;
}

const encoder = new TextEncoder();

/** Hex HMAC-SHA256 of `${t}.${payload}` (Stripe's v1 scheme). */
export async function stripeV1Signature(secret: string, payload: string, timestampS: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampS}.${payload}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function stripeSignatureHeader(secret: string, payload: string, timestampS: number): Promise<string> {
  return `t=${timestampS},v1=${await stripeV1Signature(secret, payload, timestampS)}`;
}

/** A Stripe-looking id, unique per run (`pi_…`, `in_…`, `evt_…`). */
export function stripeId(prefix: string): string {
  return `${prefix}_harness${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export interface StripeEvent {
  id: string;
  object: "event";
  api_version: string;
  type: string;
  created: number;
  livemode: false;
  data: { object: Record<string, unknown> };
}

export function stripeEvent(type: string, object: Record<string, unknown>, createdS = nowS()): StripeEvent {
  return {
    id: stripeId("evt"),
    object: "event",
    api_version: STRIPE_EVENT_API_VERSION,
    type,
    created: createdS,
    livemode: false,
    data: { object },
  };
}

const nowS = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- the events a flow needs

/** A paid one-off Checkout Session (gifts, tips). */
export function paymentCompleted(o: {
  paymentId: string;
  paymentIntent: string;
  amountCents: number;
  currency: string;
}) {
  return stripeEvent("checkout.session.completed", {
    id: stripeId("cs_test"),
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    status: "complete",
    client_reference_id: o.paymentId,
    metadata: { payment_id: o.paymentId },
    payment_intent: o.paymentIntent,
    subscription: null,
    amount_total: o.amountCents,
    currency: o.currency,
    total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
  });
}

/** A completed subscription-mode Checkout Session (links the Stripe subscription). */
export function subscriptionCheckoutCompleted(o: {
  paymentId: string;
  subscription: string;
  invoice: string;
  amountCents: number;
  currency: string;
}) {
  return stripeEvent("checkout.session.completed", {
    id: stripeId("cs_test"),
    object: "checkout.session",
    mode: "subscription",
    payment_status: "paid",
    status: "complete",
    client_reference_id: o.paymentId,
    metadata: { payment_id: o.paymentId },
    payment_intent: null,
    subscription: o.subscription,
    invoice: o.invoice,
    amount_total: o.amountCents,
    currency: o.currency,
    total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
  });
}

/** The paid first invoice of a subscription checkout (it confirms the payment). */
export function firstInvoicePaid(o: {
  paymentId: string;
  invoice: string;
  subscription: string;
  paymentIntent: string;
  amountCents: number;
  currency: string;
}) {
  const now = nowS();
  return stripeEvent("invoice.paid", {
    id: o.invoice,
    object: "invoice",
    billing_reason: "subscription_create",
    status: "paid",
    subscription: o.subscription,
    subscription_details: { metadata: { payment_id: o.paymentId } },
    payment_intent: o.paymentIntent,
    amount_paid: o.amountCents,
    tax: null,
    currency: o.currency,
    status_transitions: { paid_at: now },
    lines: { object: "list", data: [{ period: { start: now, end: now + 30 * 86_400 } }] },
  });
}

export function chargeRefunded(o: {
  paymentIntent: string;
  refundId: string;
  amountCents: number;
  amountRefunded: number;
  currency: string;
}) {
  return stripeEvent("charge.refunded", {
    id: stripeId("ch"),
    object: "charge",
    payment_intent: o.paymentIntent,
    amount: o.amountCents,
    amount_refunded: o.amountRefunded,
    refunded: o.amountRefunded >= o.amountCents,
    currency: o.currency,
    refunds: { object: "list", data: [{ id: o.refundId, amount: o.amountRefunded, status: "succeeded" }] },
  });
}

export function dispute(
  type: "charge.dispute.created" | "charge.dispute.closed",
  o: { disputeId: string; paymentIntent: string; amountCents: number; currency: string; status: string },
) {
  return stripeEvent(type, {
    id: o.disputeId,
    object: "dispute",
    charge: stripeId("ch"),
    payment_intent: o.paymentIntent,
    amount: o.amountCents,
    currency: o.currency,
    status: o.status,
    reason: "general",
    balance_transactions: [],
  });
}

// ---------------------------------------------------------------- delivery

export interface Delivery {
  status: number;
  body: { received?: boolean; outcome?: string; duplicate?: boolean; code?: string; message?: string };
}

/** Signs and posts events to the API's Stripe webhook. */
export class StripeWebhook {
  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly signal?: AbortSignal,
  ) {}

  async deliver(event: StripeEvent): Promise<Delivery> {
    const body = JSON.stringify(event);
    const res = await fetch(`${this.apiUrl.replace(/\/+$/, "")}${STRIPE_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": await stripeSignatureHeader(this.secret, body, nowS()),
        "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks) commonair-harness",
      },
      body,
      ...(this.signal ? { signal: this.signal } : {}),
    });
    const text = await res.text();
    let parsed: Delivery["body"] = {};
    try {
      parsed = text ? (JSON.parse(text) as Delivery["body"]) : {};
    } catch {
      parsed = { message: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }

  /** Deliver and require a 2xx (the API processed or already had it). */
  async send(event: StripeEvent): Promise<Delivery> {
    const d = await this.deliver(event);
    if (d.status < 200 || d.status > 299)
      throw new Error(`webhook ${event.type} answered ${d.status}: ${JSON.stringify(d.body)}`);
    return d;
  }
}

/**
 * The processor fee stripe-mock reports for a PaymentIntent, read the way the API reads it, so
 * the scenario can check the fee the API posted. stripe-mock answers fixtures; null = no fee.
 */
export async function stripeMockFee(mockUrl: string, paymentIntent: string): Promise<number | null> {
  const res = await fetch(
    `${mockUrl.replace(/\/+$/, "")}/v1/payment_intents/${paymentIntent}?expand[]=latest_charge.balance_transaction`,
    { headers: { authorization: "Bearer sk_test_123", "stripe-version": STRIPE_EVENT_API_VERSION } },
  );
  if (!res.ok) throw new Error(`stripe-mock answered ${res.status}`);
  const pi = (await res.json()) as { latest_charge?: unknown };
  const charge = pi.latest_charge;
  if (!charge || typeof charge !== "object") return null;
  const bt = (charge as { balance_transaction?: unknown }).balance_transaction;
  if (!bt || typeof bt !== "object") return null;
  const fee = (bt as { fee?: unknown }).fee;
  return typeof fee === "number" && Number.isSafeInteger(fee) ? fee : null;
}

/** `https://…` (or `http://` for a local mock), absolute: what the Support dialog navigates to. */
export function isCheckoutRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
