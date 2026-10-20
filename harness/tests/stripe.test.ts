// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from "vite-plus/test";
// The API's own parser and verifier (dependency-free modules): the harness's events must pass them.
import { stripeAction, stripeEnvelope } from "../../packages/payments/src/stripe-events.ts";
import { verifyStripeSignature } from "../../packages/payments/src/stripe-signature.ts";
import { parseProvider } from "../src/money.ts";
import {
  StripeWebhook,
  chargeRefunded,
  dispute,
  firstInvoicePaid,
  isCheckoutRedirect,
  paymentCompleted,
  stripeId,
  stripeSignatureHeader,
  stripeWebhookSecret,
  subscriptionCheckoutCompleted,
} from "../src/stripe.ts";

const SECRET = "whsec_harness";
const parse = (e: unknown) => {
  const env = stripeEnvelope(JSON.parse(JSON.stringify(e)));
  if (!env) throw new Error("not an event");
  return stripeAction(env);
};

describe("signing", () => {
  test("the header verifies with the API's verifier, and only with the right secret", async () => {
    const body = JSON.stringify(
      paymentCompleted({ paymentId: "p", paymentIntent: "pi_1", amountCents: 1, currency: "usd" }),
    );
    const t = Math.floor(Date.now() / 1000);
    const header = await stripeSignatureHeader(SECRET, body, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect((await verifyStripeSignature(body, header, SECRET, { nowS: t })).ok).toBe(true);
    expect((await verifyStripeSignature(body, header, "whsec_other", { nowS: t })).ok).toBe(false);
  });

  test("the secret comes from HARNESS_STRIPE_WEBHOOK_SECRET, else the instance's", () => {
    expect(stripeWebhookSecret({ HARNESS_STRIPE_WEBHOOK_SECRET: "a" }, { STRIPE_WEBHOOK_SECRET: "b" })).toBe("a");
    expect(stripeWebhookSecret({}, { STRIPE_WEBHOOK_SECRET: "b" })).toBe("b");
    expect(stripeWebhookSecret({ HARNESS_STRIPE_WEBHOOK_SECRET: " " }, {})).toBeUndefined();
  });
});

describe("events parse into the actions the API applies", () => {
  const money = { paymentId: "pid", amountCents: 999, currency: "usd" };

  test("payment-mode completion", () => {
    expect(parse(paymentCompleted({ ...money, paymentIntent: "pi_1" }))).toMatchObject({
      type: "checkout.completed",
      mode: "payment",
      paid: true,
      paymentId: "pid",
      paymentIntent: "pi_1",
      amountTotal: 999,
      taxCents: 0,
    });
  });

  test("first invoice and subscription completion", () => {
    expect(
      parse(firstInvoicePaid({ ...money, invoice: "in_1", subscription: "sub_1", paymentIntent: "pi_2" })),
    ).toMatchObject({
      type: "invoice.paid",
      invoiceId: "in_1",
      subscription: "sub_1",
      billingReason: "subscription_create",
      paymentId: "pid",
      paymentIntent: "pi_2",
      amountPaid: 999,
      taxCents: 0,
    });
    expect(parse(subscriptionCheckoutCompleted({ ...money, invoice: "in_1", subscription: "sub_1" }))).toMatchObject({
      type: "checkout.completed",
      mode: "subscription",
      subscription: "sub_1",
    });
  });

  test("refund and dispute", () => {
    expect(
      parse(
        chargeRefunded({
          paymentIntent: "pi_1",
          refundId: "re_1",
          amountCents: 500,
          amountRefunded: 500,
          currency: "usd",
        }),
      ),
    ).toMatchObject({ type: "charge.refunded", paymentIntent: "pi_1", refunds: [{ id: "re_1", amountCents: 500 }] });
    expect(
      parse(
        dispute("charge.dispute.created", {
          disputeId: "dp_1",
          paymentIntent: "pi_1",
          amountCents: 999,
          currency: "usd",
          status: "needs_response",
        }),
      ),
    ).toMatchObject({ type: "dispute.created", disputeId: "dp_1", amountCents: 999, feeCents: 0 });
  });

  test("ids are unique and Stripe-shaped", () => {
    const a = stripeId("pi");
    expect(a).toMatch(/^pi_[A-Za-z0-9]+$/);
    expect(stripeId("pi")).not.toBe(a);
  });
});

describe("delivery", () => {
  const seen: { sig: string | null; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push({ sig: req.headers.get("stripe-signature"), body: await req.text() });
      return new URL(req.url).pathname === "/api/webhooks/stripe"
        ? Response.json({ received: true, outcome: "confirmed" })
        : new Response("no", { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  test("posts the signed raw body; send() rejects non-2xx", async () => {
    const hook = new StripeWebhook(`http://127.0.0.1:${server.port}/`, SECRET);
    const evt = paymentCompleted({ paymentId: "p", paymentIntent: "pi_1", amountCents: 1, currency: "usd" });
    const d = await hook.send(evt);
    expect(d).toEqual({ status: 200, body: { received: true, outcome: "confirmed" } });
    const last = seen.at(-1);
    expect(last?.body).toBe(JSON.stringify(evt));
    const t = Number(/t=(\d+)/.exec(last?.sig ?? "")?.[1]);
    expect((await verifyStripeSignature(last?.body ?? "", last?.sig ?? null, SECRET, { nowS: t })).ok).toBe(true);

    const bad = new StripeWebhook(`http://127.0.0.1:${server.port}/nope`, SECRET);
    await expect(bad.send(evt)).rejects.toThrow(/answered 404/);
  });
});

test("parseProvider and redirect shape", () => {
  expect(parseProvider("Stripe")).toBe("stripe");
  expect(parseProvider("manual")).toBe("manual");
  expect(() => parseProvider("paypal")).toThrow(/provider=paypal/);
  expect(isCheckoutRedirect("https://checkout.stripe.com/c/pay/cs_test_1")).toBe(true);
  expect(isCheckoutRedirect("/relative")).toBe(false);
  expect(isCheckoutRedirect("javascript:alert(1)")).toBe(false);
});
