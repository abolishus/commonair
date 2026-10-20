// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { AdapterUnavailableError, type CheckoutRequest, createAdapter } from "../src/index.ts";
import { checkoutSessionParams, stripeAdapter } from "../src/stripe.ts";
import {
  STRIPE_API_VERSION,
  StripeApiError,
  StripeKeyError,
  stripeClient,
  stripeKeyProblem,
} from "../src/stripe-client.ts";
import { type StripeEventEnvelope, StripeEventError, stripeAction, stripeEnvelope } from "../src/stripe-events.ts";
import { encodeForm, formPairs } from "../src/stripe-form.ts";
import {
  constantTimeEqual,
  parseSignatureHeader,
  signStripePayload,
  stripeSignature,
  verifyStripeSignature,
} from "../src/stripe-signature.ts";

const SECRET = "whsec_test_secret";
const NOW = 1_760_000_000;

describe("signature verification", () => {
  const body = JSON.stringify({ id: "evt_1", object: "event" });

  test("a valid signature passes", async () => {
    const header = await signStripePayload(SECRET, body, NOW);
    expect(await verifyStripeSignature(body, header, SECRET, { nowS: NOW })).toEqual({ ok: true, timestamp: NOW });
  });

  test("bytes and string payloads sign alike", async () => {
    expect(await stripeSignature(SECRET, new TextEncoder().encode(body), NOW)).toBe(
      await stripeSignature(SECRET, body, NOW),
    );
  });

  test("a tampered body fails", async () => {
    const header = await signStripePayload(SECRET, body, NOW);
    expect(await verifyStripeSignature(`${body} `, header, SECRET, { nowS: NOW })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  test("an old (or future) timestamp fails outside the 5-minute tolerance", async () => {
    const old = await signStripePayload(SECRET, body, NOW - 301);
    expect(await verifyStripeSignature(body, old, SECRET, { nowS: NOW })).toEqual({ ok: false, reason: "expired" });
    const edge = await signStripePayload(SECRET, body, NOW - 300);
    expect((await verifyStripeSignature(body, edge, SECRET, { nowS: NOW })).ok).toBe(true);
    const future = await signStripePayload(SECRET, body, NOW + 301);
    expect((await verifyStripeSignature(body, future, SECRET, { nowS: NOW })).ok).toBe(false);
  });

  test("any of several v1 signatures may match (secret rolling)", async () => {
    const good = await stripeSignature(SECRET, body, NOW);
    const other = await stripeSignature("whsec_old", body, NOW);
    const header = `t=${NOW},v1=${other},v0=ignored,v1=${good}`;
    expect((await verifyStripeSignature(body, header, SECRET, { nowS: NOW })).ok).toBe(true);
  });

  test("the wrong secret fails", async () => {
    const header = await signStripePayload("whsec_other", body, NOW);
    expect(await verifyStripeSignature(body, header, SECRET, { nowS: NOW })).toEqual({ ok: false, reason: "mismatch" });
  });

  test("missing or malformed headers fail", async () => {
    expect(await verifyStripeSignature(body, null, SECRET, { nowS: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(await verifyStripeSignature(body, "garbage", SECRET, { nowS: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyStripeSignature(body, `t=${NOW}`, SECRET, { nowS: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseSignatureHeader(`t=abc,v1=zz`)).toEqual({ timestamp: null, v1: [] });
  });

  test("constant-time compare", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("form encoding", () => {
  test("nested objects and arrays use Stripe's bracket syntax", () => {
    expect(
      formPairs({
        mode: "payment",
        line_items: [
          { price_data: { currency: "usd", unit_amount: 499, recurring: { interval: "month" } }, quantity: 2 },
        ],
        metadata: { payment_id: "p1" },
        skip: undefined,
        none: null,
        flag: true,
        off: false,
        expand: ["a", "b"],
      }),
    ).toEqual([
      ["mode", "payment"],
      ["line_items[0][price_data][currency]", "usd"],
      ["line_items[0][price_data][unit_amount]", "499"],
      ["line_items[0][price_data][recurring][interval]", "month"],
      ["line_items[0][quantity]", "2"],
      ["metadata[payment_id]", "p1"],
      ["flag", "true"],
      ["off", "false"],
      ["expand[0]", "a"],
      ["expand[1]", "b"],
    ]);
  });

  test("values are URL-encoded", () => {
    expect(encodeForm({ success_url: "https://x.test/a b?c=1&d", metadata: { k: "é" } })).toBe(
      "success_url=https%3A%2F%2Fx.test%2Fa+b%3Fc%3D1%26d&metadata%5Bk%5D=%C3%A9",
    );
  });

  test("non-finite numbers are refused", () => {
    expect(() => formPairs({ amount: Number.NaN })).toThrow(RangeError);
  });
});

describe("keys", () => {
  test("live keys are refused, test keys accepted", () => {
    expect(stripeKeyProblem("sk_live_abc")).toMatch(/live/);
    expect(stripeKeyProblem("rk_live_abc")).toMatch(/live/);
    expect(stripeKeyProblem("pk_test_abc")).toMatch(/test key/);
    expect(stripeKeyProblem(undefined)).toMatch(/not set/);
    expect(stripeKeyProblem("sk_test_abc")).toBeNull();
    expect(stripeKeyProblem("rk_test_abc")).toBeNull();
    expect(() => stripeClient({ secretKey: "sk_live_x" })).toThrow(StripeKeyError);
  });

  test("createAdapter refuses a live key before loading Stripe; manual needs no key", () => {
    const base = { MANUAL_PAYMENT_INSTRUCTIONS: "pay {amount} ref {reference}" };
    expect(() => createAdapter({ ...base, PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_x" })).toThrow(
      AdapterUnavailableError,
    );
    expect(() => createAdapter({ ...base, PAYMENTS_PROVIDER: "stripe" })).toThrow(AdapterUnavailableError);
    expect(createAdapter({ ...base, PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x" }).provider).toBe(
      "stripe",
    );
    expect(createAdapter({ ...base, PAYMENTS_PROVIDER: "manual" }).provider).toBe("manual");
  });
});

const request = (over: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  paymentId: "0190a000-0000-7000-8000-000000000001",
  kind: "subscription",
  amountCents: 999,
  currency: "usd",
  tier: 2,
  quantity: 1,
  recurring: true,
  payerUserId: "u1",
  creatorUserId: "u2",
  successUrl: "https://x.test/chan",
  cancelUrl: "https://x.test/chan",
  subscriptionId: "0190a000-0000-7000-8000-000000000002",
  ...over,
});

describe("checkout session params", () => {
  test("self subscription: mode=subscription with a monthly price and metadata on the subscription", () => {
    const pairs = Object.fromEntries(formPairs(checkoutSessionParams(request(), "CA-AAAAAAAA")));
    expect(pairs).toMatchObject({
      mode: "subscription",
      client_reference_id: request().paymentId,
      "line_items[0][price_data][unit_amount]": "999",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][quantity]": "1",
      "metadata[payment_id]": request().paymentId,
      "metadata[reference]": "CA-AAAAAAAA",
      "subscription_data[metadata][payment_id]": request().paymentId,
      "subscription_data[metadata][subscription_id]": request().subscriptionId,
    });
    expect(pairs["payment_intent_data[metadata][payment_id]"]).toBeUndefined();
  });

  test("gift: mode=payment, quantity × unit price, metadata on the PaymentIntent", () => {
    const pairs = Object.fromEntries(
      formPairs(checkoutSessionParams(request({ recurring: false, quantity: 3, amountCents: 1497, tier: 1 }), "CA-B")),
    );
    expect(pairs).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][unit_amount]": "499",
      "line_items[0][quantity]": "3",
      "payment_intent_data[metadata][payment_id]": request().paymentId,
    });
    expect(pairs["line_items[0][price_data][recurring][interval]"]).toBeUndefined();
  });

  test("uneven gift totals and non-positive amounts are refused", () => {
    expect(() => checkoutSessionParams(request({ recurring: false, quantity: 2, amountCents: 999 }), "r")).toThrow(
      /divide evenly/,
    );
    expect(() => checkoutSessionParams(request({ amountCents: 0 }), "r")).toThrow(/positive/);
  });
});

function fakeFetch(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

describe("client", () => {
  test("posts form bodies with auth, version and idempotency key; the adapter returns a redirect", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ id: "cs_test_1", url: "https://checkout.test/cs_test_1" }));
    const adapter = stripeAdapter({
      client: { secretKey: "sk_test_x", apiBase: "http://mock.test/", fetch: f },
      reference: () => "CA-REF00001",
    });
    const start = await adapter.startCheckout(request());
    expect(start).toEqual({ kind: "redirect", url: "https://checkout.test/cs_test_1", providerRef: "CA-REF00001" });
    const call = calls[0];
    expect(call?.url.href).toBe("http://mock.test/v1/checkout/sessions");
    const h = call?.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk_test_x");
    expect(h["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(h["idempotency-key"]).toBe(`checkout-${request().paymentId}`);
    expect(call?.init.body as string).toContain("mode=subscription");
  });

  test("4xx is not retried; 5xx and network errors are", async () => {
    let n = 0;
    const bad = fakeFetch(() => {
      n++;
      return Response.json({ error: { type: "invalid_request_error", message: "nope", code: "x" } }, { status: 400 });
    });
    const c4 = stripeClient({ secretKey: "sk_test_x", fetch: bad.f, retries: 2 });
    await expect(c4.createRefund({ amount: 1 }, "k")).rejects.toBeInstanceOf(StripeApiError);
    expect(n).toBe(1);

    let m = 0;
    const flaky = fakeFetch(() => {
      m++;
      if (m === 1) throw new TypeError("connection reset");
      if (m === 2) return new Response("oops", { status: 503 });
      return Response.json({ id: "re_1", status: "succeeded" });
    });
    const c5 = stripeClient({ secretKey: "sk_test_x", fetch: flaky.f, retries: 2 });
    expect(await c5.createRefund({ amount: 1 }, "k")).toEqual({ id: "re_1", status: "succeeded" });
    expect(m).toBe(3);
  });

  test("payment intent fee: expanded balance transaction, or none before a charge exists", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.pathname.endsWith("pi_1")
        ? Response.json({ latest_charge: { balance_transaction: { fee: 59, currency: "USD" } } })
        : Response.json({ latest_charge: null }),
    );
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, apiBase: "http://m.test" });
    expect(await c.paymentIntentFee("pi_1")).toEqual({ feeCents: 59, currency: "usd" });
    expect(await c.paymentIntentFee("pi_2")).toBeNull();
    expect(calls[0]?.url.search).toBe("?expand[]=latest_charge.balance_transaction");
    await expect(c.paymentIntentFee("../x")).rejects.toThrow(RangeError);
  });

  test("refunds need a PaymentIntent; onboarding creates the account once", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.pathname === "/v1/accounts"
        ? Response.json({ id: "acct_1" })
        : Response.json({ url: "https://connect.test/onboard" }),
    );
    const a = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f, apiBase: "http://m.test" } });
    await expect(
      a.refund?.({ paymentId: "p", providerRef: "CA-X", amountCents: 1, idempotencyKey: "k" }),
    ).rejects.toThrow(/PaymentIntent/);
    expect(
      await a.payoutOnboarding?.({
        userId: "u1",
        accountId: null,
        returnUrl: "https://x/r",
        refreshUrl: "https://x/r",
      }),
    ).toEqual({ accountId: "acct_1", url: "https://connect.test/onboard" });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/accounts", "/v1/account_links"]);
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("connect-account-u1");
    await a.payoutOnboarding?.({
      userId: "u1",
      accountId: "acct_1",
      returnUrl: "https://x/r",
      refreshUrl: "https://x/r",
    });
    expect(calls.map((c) => c.url.pathname).slice(2)).toEqual(["/v1/account_links"]);
  });
});

const envelope = (type: string, object: Record<string, unknown>): StripeEventEnvelope => {
  const e = stripeEnvelope({ id: "evt_1", object: "event", type, created: NOW, livemode: false, data: { object } });
  if (!e) throw new Error("bad envelope");
  return e;
};

describe("event → action mapping", () => {
  test("envelopes", () => {
    expect(stripeEnvelope({ object: "event" })).toBeNull();
    expect(stripeEnvelope(null)).toBeNull();
    expect(envelope("x.y", {}).livemode).toBe(false);
  });

  test("checkout.session.completed (payment mode) → confirm with tax and PaymentIntent", () => {
    expect(
      stripeAction(
        envelope("checkout.session.completed", {
          mode: "payment",
          payment_status: "paid",
          client_reference_id: "pid",
          metadata: { payment_id: "pid" },
          payment_intent: "pi_1",
          amount_total: 500,
          currency: "usd",
          total_details: { amount_tax: 40 },
        }),
      ),
    ).toEqual({
      type: "checkout.completed",
      paymentId: "pid",
      mode: "payment",
      paid: true,
      paymentIntent: "pi_1",
      subscription: null,
      amountTotal: 500,
      taxCents: 40,
      currency: "usd",
      at: new Date(NOW * 1000),
    });
  });

  test("subscription-mode completion carries the Stripe subscription; unpaid is not paid", () => {
    const a = stripeAction(
      envelope("checkout.session.completed", {
        mode: "subscription",
        payment_status: "unpaid",
        client_reference_id: "pid",
        subscription: { id: "sub_1" },
      }),
    );
    expect(a).toMatchObject({ type: "checkout.completed", mode: "subscription", paid: false, subscription: "sub_1" });
  });

  test("a handled event missing what it needs throws", () => {
    expect(() => stripeAction(envelope("checkout.session.completed", { mode: "payment" }))).toThrow(StripeEventError);
    expect(() => stripeAction(envelope("invoice.paid", { id: "in_1" }))).toThrow(StripeEventError);
  });

  test("expired sessions fail the payment", () => {
    expect(stripeAction(envelope("checkout.session.expired", { metadata: { payment_id: "pid" } }))).toEqual({
      type: "checkout.failed",
      paymentId: "pid",
    });
  });

  test("invoice.paid (2024-06-20 shape and the parent shape)", () => {
    const base = {
      id: "in_1",
      billing_reason: "subscription_cycle",
      payment_intent: "pi_2",
      amount_paid: 999,
      tax: 0,
      currency: "usd",
      status_transitions: { paid_at: NOW - 10 },
      lines: { data: [{ period: { start: NOW - 10, end: NOW + 2_592_000 } }] },
    };
    expect(stripeAction(envelope("invoice.paid", { ...base, subscription: "sub_1" }))).toEqual({
      type: "invoice.paid",
      invoiceId: "in_1",
      subscription: "sub_1",
      billingReason: "subscription_cycle",
      paymentId: null,
      paymentIntent: "pi_2",
      amountPaid: 999,
      taxCents: 0,
      currency: "usd",
      paidAt: new Date((NOW - 10) * 1000),
      periodEnd: new Date((NOW + 2_592_000) * 1000),
    });
    expect(
      stripeAction(
        envelope("invoice.paid", {
          ...base,
          parent: { subscription_details: { subscription: "sub_9", metadata: { payment_id: "pid" } } },
        }),
      ),
    ).toMatchObject({ subscription: "sub_9", paymentId: "pid" });
  });

  test("failed invoices, deleted subscriptions, accounts", () => {
    expect(stripeAction(envelope("invoice.payment_failed", { subscription: "sub_1" }))).toEqual({
      type: "invoice.failed",
      subscription: "sub_1",
    });
    expect(stripeAction(envelope("customer.subscription.deleted", { id: "sub_1" }))).toEqual({
      type: "subscription.deleted",
      subscription: "sub_1",
    });
    expect(stripeAction(envelope("account.updated", { id: "acct_1", payouts_enabled: true }))).toEqual({
      type: "account.updated",
      accountId: "acct_1",
      payoutsEnabled: true,
    });
  });

  test("charge.refunded keeps succeeded and pending refunds by id", () => {
    expect(
      stripeAction(
        envelope("charge.refunded", {
          id: "ch_1",
          payment_intent: "pi_1",
          amount_refunded: 300,
          currency: "usd",
          refunds: {
            data: [
              { id: "re_1", amount: 200, status: "succeeded" },
              { id: "re_2", amount: 100, status: "failed" },
              { id: "re_3", amount: 100 },
            ],
          },
        }),
      ),
    ).toMatchObject({
      type: "charge.refunded",
      amountRefunded: 300,
      refunds: [
        { id: "re_1", amountCents: 200 },
        { id: "re_3", amountCents: 100 },
      ],
    });
    expect(
      stripeAction(envelope("charge.refunded", { id: "ch_1", amount_refunded: 300, currency: "usd" })),
    ).toMatchObject({ refunds: null, paymentIntent: null });
  });

  test("disputes sum withdrawn and returned fees", () => {
    expect(
      stripeAction(
        envelope("charge.dispute.closed", {
          id: "dp_1",
          charge: "ch_1",
          payment_intent: "pi_1",
          amount: 999,
          currency: "usd",
          status: "won",
          balance_transactions: [{ fee: 1500 }, { fee: -1500 }],
        }),
      ),
    ).toEqual({
      type: "dispute.closed",
      disputeId: "dp_1",
      chargeId: "ch_1",
      paymentIntent: "pi_1",
      amountCents: 999,
      currency: "usd",
      status: "won",
      feeCents: 1500,
      feeRefundCents: 1500,
    });
  });

  test("unknown types are ignored", () => {
    expect(stripeAction(envelope("customer.created", { id: "cus_1" }))).toEqual({ type: "ignored" });
    expect(stripeAction(envelope("checkout.session.completed", { mode: "setup" }))).toEqual({ type: "ignored" });
  });
});
