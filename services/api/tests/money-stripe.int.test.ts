// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Stripe adapter end to end: checkout returns a redirect, and signed Stripe events posted to
 * `POST /api/webhooks/stripe` drive the same transitions, postings and events as the manual
 * adapter. The Stripe API is a local `Bun.serve` fake (stripe-mock is stateless and returns one
 * fixture id for every create, which these flows need to tell apart). The tests share state and
 * run in order.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { PAYOUT_ACCOUNT_NOT_READY } from "@commonair/ledger";
import { loadStripeSignature } from "@commonair/payments";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Redirect {
  kind: "redirect";
  url: string;
  paymentId: string;
}

const SECRET = "whsec_int_test";
const CONNECT_SECRET = "whsec_int_connect";
const FEE = 59;
const TIERS = [
  { tier: 1, name: "Fan", price: { cents: 499, currency: "usd" }, benefits: "" },
  { tier: 2, name: "Super fan", price: { cents: 999, currency: "usd" }, benefits: "" },
  { tier: 3, name: "Patron", price: { cents: 2499, currency: "usd" }, benefits: "" },
];

let api: TestApi;
let fake: ReturnType<typeof Bun.serve>;
const stripeCalls: { method: string; path: string; body: URLSearchParams; key: string | null }[] = [];
let streamer: Account;
let alice: Account;
let bob: Account;
let treasurer: Account;

/** PaymentIntents the fake reports without a balance transaction yet. */
const feeless = new Set<string>();
/** Connect accounts' payouts_enabled as the fake Stripe reports it. */
const accountsEnabled = new Map<string, boolean>();
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 14);
const db = () => api.db.db;

function startFakeStripe() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = new URLSearchParams(req.method === "GET" ? "" : await req.text());
      stripeCalls.push({ method: req.method, path: url.pathname, body, key: req.headers.get("idempotency-key") });
      if (req.headers.get("authorization") !== "Bearer sk_test_int")
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      if (url.pathname === "/v1/checkout/sessions") {
        const id = `cs_test_${rand()}`;
        return Response.json({ id, url: `https://checkout.stripe.test/c/pay/${id}` });
      }
      if (url.pathname.startsWith("/v1/payment_intents/")) {
        // A charge whose balance transaction Stripe has not attached yet.
        if (feeless.has(url.pathname.split("/").pop() ?? ""))
          return Response.json({ latest_charge: { balance_transaction: null } });
        return Response.json({ latest_charge: { balance_transaction: { fee: FEE, currency: "usd" } } });
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/accounts/")) {
        const id = url.pathname.split("/").pop() ?? "";
        return Response.json({ id, payouts_enabled: accountsEnabled.get(id) === true });
      }
      if (url.pathname === "/v1/refunds") return Response.json({ id: `re_${rand()}`, status: "succeeded" });
      if (url.pathname.startsWith("/v1/subscriptions/")) return Response.json({ id: url.pathname.split("/").pop() });
      if (url.pathname === "/v1/accounts") return Response.json({ id: `acct_${rand()}` });
      if (url.pathname === "/v1/account_links") return Response.json({ url: "https://connect.stripe.test/setup/x" });
      return Response.json({ error: { message: "not faked" } }, { status: 404 });
    },
  });
}

beforeAll(async () => {
  fake = startFakeStripe();
  api = await startApi();
  // The test harness builds a manual instance; switch this one to Stripe (handlers read deps.env per call).
  Object.assign(api.deps.env, {
    PAYMENTS_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_int",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_API_BASE: `http://127.0.0.1:${fake.port}`,
  });
  [streamer, alice, bob, treasurer] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  const set = await streamer.client.call("PUT", `/api/channels/${streamer.username}/subscription-tiers`, {
    tiers: TIERS,
  });
  if (set.status !== 200) throw new Error(`setTiers failed: ${set.status}`);
}, 180_000);
afterAll(async () => {
  await api?.stop();
  await fake?.stop(true);
});

const nowS = () => Math.floor(Date.now() / 1000);
function event(type: string, object: Record<string, unknown>, id = `evt_${rand()}`) {
  return { id, object: "event", type, api_version: "2024-06-20", created: nowS(), livemode: false, data: { object } };
}
async function deliver(evt: unknown, opts: { secret?: string; t?: number; tamper?: boolean } = {}) {
  const { signStripePayload } = await loadStripeSignature();
  const body = JSON.stringify(evt);
  const header = await signStripePayload(opts.secret ?? SECRET, body, opts.t ?? nowS());
  const res = await fetch(`${api.url}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: opts.tamper ? `${body} ` : body,
  });
  return { status: res.status, body: (await res.json()) as { outcome?: string; duplicate?: boolean; code?: string } };
}

const paymentRow = async (id: string) => {
  const [p] = await db().select().from(schema.payments).where(eq(schema.payments.id, id));
  if (!p) throw new Error(`no payment ${id}`);
  return p;
};
const channelId = async () => {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  if (!c) throw new Error("no channel");
  return c.id;
};
const eventsOf = async (type: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, await channelId()), eq(schema.events.type, type)));
const ledgerKinds = async (paymentId: string) =>
  (
    await db()
      .select({ kind: schema.ledgerTransactions.kind })
      .from(schema.ledgerTransactions)
      .where(and(eq(schema.ledgerTransactions.refType, "payment"), eq(schema.ledgerTransactions.refId, paymentId)))
  )
    .map((r) => r.kind)
    .sort();
const subscribe = (as: Account, body: Record<string, unknown>) =>
  as.client.call<Redirect>("POST", `/api/channels/${streamer.username}/subscriptions`, {
    returnPath: `/${streamer.username}`,
    ...body,
  });
const tip = (as: Account, cents: number) =>
  as.client.call<Redirect>("POST", `/api/channels/${streamer.username}/tips`, {
    amountCents: cents,
    message: "hi",
    anonymous: false,
    returnPath: `/${streamer.username}`,
  });
const subscriptionOf = async (userId: string) =>
  db()
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.subscriberId, userId))
    .orderBy(schema.subscriptions.id);

let subPay: Redirect; // alice's tier-2 subscription
const SUB_A = `sub_${rand()}`;
const PI_A = `pi_${rand()}`;

describe("checkout", () => {
  test("a self subscription returns a Stripe Checkout redirect; the payment waits with a reference", async () => {
    const r = await subscribe(alice, { tier: 2 });
    expect(r.status).toBe(200);
    subPay = r.body;
    expect(r.body.kind).toBe("redirect");
    expect(r.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_/);
    const call = stripeCalls.findLast((c) => c.path === "/v1/checkout/sessions");
    expect(call?.key).toBe(`checkout-${r.body.paymentId}`);
    expect(call?.body.get("mode")).toBe("subscription");
    expect(call?.body.get("line_items[0][price_data][unit_amount]")).toBe("999");
    expect(call?.body.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(call?.body.get("subscription_data[metadata][payment_id]")).toBe(r.body.paymentId);
    expect(call?.body.get("success_url")).toBe(`${api.url}/${streamer.username}`);
    const p = await paymentRow(r.body.paymentId);
    expect(p).toMatchObject({ provider: "stripe", status: "pending", amountCents: 999 });
    expect(p.providerRef).toMatch(/^CA-/);
  });

  test("asking again while pending returns the same checkout (same payment, same idempotency key)", async () => {
    const before = stripeCalls.length;
    const r = await subscribe(alice, { tier: 2 });
    expect(r.status).toBe(200);
    expect(r.body.paymentId).toBe(subPay.paymentId);
    expect(stripeCalls.slice(before).map((c) => c.key)).toEqual([`checkout-${subPay.paymentId}`]);
  });
});

describe("webhook security", () => {
  test("a bad signature, an old timestamp or the wrong secret is 400 and stores nothing", async () => {
    const evt = event("customer.created", { id: "cus_1" });
    expect((await deliver(evt, { tamper: true })).status).toBe(400);
    expect((await deliver(evt, { t: nowS() - 600 })).status).toBe(400);
    expect((await deliver(evt, { secret: "whsec_other" })).status).toBe(400);
    const rows = await db().select().from(schema.paymentEvents).where(eq(schema.paymentEvents.providerEventId, evt.id));
    expect(rows).toHaveLength(0);
  });

  test("an oversized body is 413; with the manual adapter the route does not exist", async () => {
    const big = await fetch(`${api.url}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=00" },
      body: "x".repeat(600 * 1024),
    });
    expect(big.status).toBe(413);
    api.deps.env.PAYMENTS_PROVIDER = "manual";
    try {
      const evt = event("customer.created", { id: "cus_1" });
      expect((await deliver(evt)).status).toBe(404);
    } finally {
      api.deps.env.PAYMENTS_PROVIDER = "stripe";
    }
  });

  test("live-mode events are refused", async () => {
    const evt = { ...event("customer.created", { id: "cus_1" }), livemode: true };
    expect((await deliver(evt)).status).toBe(400);
  });

  test("unknown event types are stored and processed as no-ops", async () => {
    const evt = event("customer.created", { id: "cus_1" });
    const r = await deliver(evt);
    expect(r).toEqual({ status: 200, body: { received: true, outcome: "ignored" } });
    const [row] = await db()
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.providerEventId, evt.id));
    expect(row?.processedAt).not.toBeNull();
    expect(row?.attempts).toBe(1);
  });
});

/** A renewal invoice as Stripe sends it: the subscription's metadata (our first payment id) included. */
const renewalInvoice = (pi: string, sub: string, firstPaymentId: string, amount: number) =>
  event("invoice.paid", {
    id: `in_${rand()}`,
    billing_reason: "subscription_cycle",
    subscription: sub,
    subscription_details: { metadata: { payment_id: firstPaymentId } },
    payment_intent: pi,
    amount_paid: amount,
    tax: 0,
    currency: "usd",
    status_transitions: { paid_at: nowS() },
    lines: { data: [] },
  });

const firstInvoice = () =>
  event("invoice.paid", {
    id: `in_${rand()}`,
    object: "invoice",
    billing_reason: "subscription_create",
    subscription: SUB_A,
    subscription_details: { metadata: { payment_id: subPay.paymentId } },
    payment_intent: PI_A,
    amount_paid: 999,
    tax: 0,
    currency: "usd",
    status_transitions: { paid_at: nowS() },
    lines: { data: [{ period: { start: nowS(), end: nowS() + 31 * 86_400 } }] },
  });
let firstInvoiceEvent: ReturnType<typeof firstInvoice>;

describe("subscriptions", () => {
  test("invoice.paid before checkout.session.completed confirms the first payment with Stripe's fee", async () => {
    firstInvoiceEvent = firstInvoice();
    const r = await deliver(firstInvoiceEvent);
    expect(r).toMatchObject({ status: 200, body: { outcome: "confirmed" } });
    const p = await paymentRow(subPay.paymentId);
    expect(p).toMatchObject({ status: "succeeded", providerRef: PI_A, feeCents: FEE, taxCents: 0 });
    const [s] = await subscriptionOf(alice.userId);
    expect(s).toMatchObject({ status: "active", providerRef: SUB_A, tier: 2 });
    expect(await ledgerKinds(p.id)).toEqual(["payment"]);
    const fees = await db().execute<{ sum: string }>(sql`
      select coalesce(sum(e.amount_cents), 0)::text as sum from ledger_entries e
      join ledger_transactions t on t.id = e.transaction_id
      join ledger_accounts a on a.id = e.account_id
      where t.ref_id = ${p.id} and a.code like 'expense:payment-fees%'`);
    expect(Number(fees[0]?.sum)).toBe(FEE);
    expect((await eventsOf("channel.subscribe")).length).toBe(1);
  });

  test("the later checkout.session.completed only links; nothing posts twice", async () => {
    const r = await deliver(
      event("checkout.session.completed", {
        id: `cs_test_${rand()}`,
        mode: "subscription",
        payment_status: "paid",
        client_reference_id: subPay.paymentId,
        metadata: { payment_id: subPay.paymentId },
        subscription: SUB_A,
        amount_total: 999,
        currency: "usd",
      }),
    );
    expect(r).toMatchObject({ status: 200, body: { outcome: "subscription_linked" } });
    expect(await ledgerKinds(subPay.paymentId)).toEqual(["payment"]);
    expect((await eventsOf("channel.subscribe")).length).toBe(1);
  });

  test("a duplicate delivery answers 200 and is not reprocessed", async () => {
    const r = await deliver(firstInvoiceEvent);
    expect(r).toEqual({ status: 200, body: { received: true, duplicate: true } });
    const rows = await db()
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.providerEventId, firstInvoiceEvent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(1);
  });

  const renewal = (pi: string) => renewalInvoice(pi, SUB_A, subPay.paymentId, 999);

  test("a renewal invoice creates and posts the period's payment without channel.subscribe", async () => {
    const [before] = await subscriptionOf(alice.userId);
    const pi = `pi_${rand()}`;
    const r = await deliver(renewal(pi));
    expect(r).toMatchObject({ status: 200, body: { outcome: "renewed" } });
    const [renewed] = await db()
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.provider, "stripe"), eq(schema.payments.providerRef, pi)));
    expect(renewed).toMatchObject({ status: "succeeded", amountCents: 999, feeCents: FEE, subscriptionId: before?.id });
    expect(await ledgerKinds(renewed?.id ?? "")).toEqual(["payment"]);
    const [after] = await subscriptionOf(alice.userId);
    expect(after?.currentPeriodStart?.getTime()).toBe(before?.currentPeriodEnd?.getTime());
    expect((after?.currentPeriodEnd?.getTime() ?? 0) > (before?.currentPeriodEnd?.getTime() ?? 0)).toBe(true);
    expect((await eventsOf("channel.subscribe")).length).toBe(1);
    // Another event for the same invoice payment is a no-op.
    expect((await deliver(renewal(pi))).body.outcome).toBe("already_processed");
  });

  test("invoice.payment_failed → past_due; the next paid invoice → active again", async () => {
    expect(
      (await deliver(event("invoice.payment_failed", { id: `in_${rand()}`, subscription: SUB_A }))).body.outcome,
    ).toBe("past_due");
    expect((await subscriptionOf(alice.userId))[0]?.status).toBe("past_due");
    expect((await deliver(renewal(`pi_${rand()}`))).body.outcome).toBe("renewed");
    expect((await subscriptionOf(alice.userId))[0]?.status).toBe("active");
  });

  test("the treasurer cannot confirm or charge back a Stripe payment", async () => {
    const tp = await tip(alice, 300);
    const confirm = await treasurer.client.call("POST", `/api/treasurer/payments/${tp.body.paymentId}/confirm`, {
      receivedAt: new Date().toISOString(),
    });
    expect(confirm.status).toBe(409);
    const cb = await treasurer.client.call("POST", `/api/treasurer/payments/${subPay.paymentId}/chargeback`, {
      amountCents: 1,
      reason: "x",
    });
    expect(cb.status).toBe(409);
    // checkout.session.expired fails it
    const r = await deliver(event("checkout.session.expired", { metadata: { payment_id: tp.body.paymentId } }));
    expect(r.body.outcome).toBe("checkout_failed");
    expect((await paymentRow(tp.body.paymentId)).status).toBe("failed");
  });
});

let tipPay: Redirect;
const PI_T = `pi_${rand()}`;

describe("tips and refunds", () => {
  test("a payment-mode session confirms the tip and emits channel.tip", async () => {
    tipPay = (await tip(alice, 500)).body;
    expect(tipPay.kind).toBe("redirect");
    const call = stripeCalls.findLast((c) => c.path === "/v1/checkout/sessions");
    expect(call?.body.get("mode")).toBe("payment");
    expect(call?.body.get("payment_intent_data[metadata][payment_id]")).toBe(tipPay.paymentId);
    const r = await deliver(
      event("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        client_reference_id: tipPay.paymentId,
        metadata: { payment_id: tipPay.paymentId },
        payment_intent: PI_T,
        amount_total: 500,
        currency: "usd",
        total_details: { amount_tax: 0 },
      }),
    );
    expect(r.body.outcome).toBe("confirmed");
    expect(await paymentRow(tipPay.paymentId)).toMatchObject({ status: "succeeded", providerRef: PI_T, feeCents: FEE });
    expect((await eventsOf("channel.tip")).length).toBe(1);
  });

  test("a session whose amount disagrees records the error, answers 500 and counts attempts", async () => {
    const other = (await tip(alice, 700)).body;
    const evt = event("checkout.session.completed", {
      mode: "payment",
      payment_status: "paid",
      metadata: { payment_id: other.paymentId },
      payment_intent: `pi_${rand()}`,
      amount_total: 1,
      currency: "usd",
    });
    expect((await deliver(evt)).status).toBe(500);
    expect((await deliver(evt)).status).toBe(500);
    const [row] = await db()
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.providerEventId, evt.id));
    expect(row).toMatchObject({ processedAt: null, attempts: 2 });
    expect(row?.error).toMatch(/charged 1 cents/);
    expect((await paymentRow(other.paymentId)).status).toBe("pending");
  });

  test("the treasurer's refund asks Stripe; charge.refunded posts it once per refund id", async () => {
    const r = await treasurer.client.call("POST", `/api/treasurer/payments/${tipPay.paymentId}/refund`, {
      amountCents: 500,
      reason: "asked",
    });
    expect(r.status).toBe(200);
    const call = stripeCalls.findLast((c) => c.path === "/v1/refunds");
    expect(call?.body.get("payment_intent")).toBe(PI_T);
    expect(call?.body.get("amount")).toBe("500");
    expect((await paymentRow(tipPay.paymentId)).status).toBe("succeeded");

    const refunded = (id: string) =>
      event(
        "charge.refunded",
        {
          id: `ch_${rand()}`,
          payment_intent: PI_T,
          amount_refunded: 500,
          currency: "usd",
          refunds: { data: [{ id: "re_tip_1", amount: 500, status: "succeeded" }] },
        },
        id,
      );
    expect((await deliver(refunded(`evt_${rand()}`))).body.outcome).toBe("refunded");
    expect((await deliver(refunded(`evt_${rand()}`))).body.outcome).toBe("no_new_refund");
    expect(await paymentRow(tipPay.paymentId)).toMatchObject({ status: "refunded", refundedCents: 500 });
    const ds = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, tipPay.paymentId));
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ kind: "refund", status: "closed", providerRef: "re_tip_1" });
    expect(await ledgerKinds(tipPay.paymentId)).toEqual(["payment", "refund"]);
  });
});

describe("disputes", () => {
  test("gift: dispute created claws back now and ends the gift; closed lost keeps it", async () => {
    const g = await subscribe(alice, { tier: 1, gift: { count: 1, to: bob.username } });
    expect(g.status).toBe(200);
    const pi = `pi_${rand()}`;
    await deliver(
      event("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        metadata: { payment_id: g.body.paymentId },
        payment_intent: pi,
        amount_total: 499,
        currency: "usd",
      }),
    );
    expect((await subscriptionOf(bob.userId))[0]).toMatchObject({ status: "active", giftPaymentId: g.body.paymentId });
    expect((await eventsOf("channel.subscription.gift")).length).toBe(1);

    const dispute = (type: string, status: string) =>
      event(type, {
        id: "dp_gift",
        charge: "ch_x",
        payment_intent: pi,
        amount: 499,
        currency: "usd",
        status,
        balance_transactions: [{ fee: 1500 }],
      });
    expect((await deliver(dispute("charge.dispute.created", "needs_response"))).body.outcome).toBe("charged_back");
    expect((await deliver(dispute("charge.dispute.created", "needs_response"))).body.outcome).toBe("already_processed");
    expect(await paymentRow(g.body.paymentId)).toMatchObject({ status: "charged_back", refundedCents: 499 });
    expect((await subscriptionOf(bob.userId))[0]?.status).toBe("canceled");
    expect(await ledgerKinds(g.body.paymentId)).toEqual(["chargeback", "payment"]);
    expect((await deliver(dispute("charge.dispute.closed", "lost"))).body.outcome).toBe("lost");
    const [d] = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, g.body.paymentId));
    expect(d).toMatchObject({ kind: "chargeback", status: "lost", providerRef: "dp_gift" });
  });

  test("won: the clawback is reversed and Stripe was told to end the subscription", async () => {
    const dispute = (type: string, status: string, fees: number[]) =>
      event(type, {
        id: "dp_sub",
        payment_intent: PI_A,
        amount: 999,
        currency: "usd",
        status,
        balance_transactions: fees.map((fee) => ({ fee })),
      });
    expect((await deliver(dispute("charge.dispute.created", "needs_response", [1500]))).body.outcome).toBe(
      "charged_back",
    );
    expect((await subscriptionOf(alice.userId))[0]?.status).toBe("canceled");
    expect(stripeCalls.some((c) => c.method === "DELETE" && c.path === `/v1/subscriptions/${SUB_A}`)).toBe(true);
    expect((await deliver(dispute("charge.dispute.closed", "won", [1500, -1500]))).body.outcome).toBe("won");
    expect(await paymentRow(subPay.paymentId)).toMatchObject({ status: "succeeded", refundedCents: 0 });
    expect(await ledgerKinds(subPay.paymentId)).toEqual(["chargeback", "chargeback_reversal", "payment"]);
    // Stripe then deletes the subscription it ended: already ended here.
    expect((await deliver(event("customer.subscription.deleted", { id: SUB_A }))).body.outcome).toBe("already_ended");
  });

  test("a dispute closed as won before its created event never claws back", async () => {
    const p = await tip(alice, 600);
    const pi = `pi_${rand()}`;
    await deliver(
      event("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        metadata: { payment_id: p.body.paymentId },
        payment_intent: pi,
        amount_total: 600,
        currency: "usd",
      }),
    );
    const d = (type: string, status: string) =>
      event(type, { id: "dp_late", payment_intent: pi, amount: 600, currency: "usd", status });
    expect((await deliver(d("charge.dispute.closed", "won"))).body.outcome).toBe("won_without_clawback");
    expect((await deliver(d("charge.dispute.created", "needs_response"))).body.outcome).toBe("already_processed");
    expect((await paymentRow(p.body.paymentId)).status).toBe("succeeded");
  });
});

describe("cancel and subscription.deleted", () => {
  test("cancel asks Stripe to stop at period end; customer.subscription.deleted ends it with the event", async () => {
    // bob's gift was charged back, so the slot is free for his own subscription.
    const s = await subscribe(bob, { tier: 1 });
    const sub = `sub_${rand()}`;
    await deliver(
      event("invoice.paid", {
        id: `in_${rand()}`,
        billing_reason: "subscription_create",
        subscription: sub,
        subscription_details: { metadata: { payment_id: s.body.paymentId } },
        payment_intent: `pi_${rand()}`,
        amount_paid: 499,
        currency: "usd",
        status_transitions: { paid_at: nowS() },
      }),
    );
    const own = (await subscriptionOf(bob.userId)).find((x) => x.giftPaymentId === null);
    expect(own).toMatchObject({ status: "active", providerRef: sub });
    const c = await bob.client.call<{ cancelAtPeriodEnd: boolean }>("POST", `/api/me/subscriptions/${own?.id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.cancelAtPeriodEnd).toBe(true);
    const call = stripeCalls.findLast((x) => x.path === `/v1/subscriptions/${sub}`);
    expect(call?.method).toBe("POST");
    expect(call?.body.get("cancel_at_period_end")).toBe("true");

    const ends = (await eventsOf("channel.subscription.end")).length;
    expect((await deliver(event("customer.subscription.deleted", { id: sub }))).body.outcome).toBe("canceled");
    expect((await subscriptionOf(bob.userId)).find((x) => x.id === own?.id)?.status).toBe("canceled");
    expect((await eventsOf("channel.subscription.end")).length).toBe(ends + 1);
  });
});

describe("Connect payout accounts", () => {
  test("the payout card creates the Express account once and returns an onboarding link", async () => {
    const first = await streamer.client.call<{ provider: string; payoutsEnabled: boolean; onboardingUrl: string }>(
      "GET",
      "/api/me/payout-account",
    );
    expect(first.body).toEqual({
      provider: "stripe",
      payoutsEnabled: false,
      onboardingUrl: "https://connect.stripe.test/setup/x",
      instructions: null,
    });
    await streamer.client.call("GET", "/api/me/payout-account");
    expect(stripeCalls.filter((c) => c.path === "/v1/accounts")).toHaveLength(1);
    const [acct] = await db()
      .select()
      .from(schema.payoutAccounts)
      .where(eq(schema.payoutAccounts.userId, streamer.userId));
    expect(acct).toMatchObject({ provider: "stripe", payoutsEnabled: false });
    expect(acct?.providerAccountId).toMatch(/^acct_/);

    // The treasurer cannot overwrite a Stripe account.
    const set = await treasurer.client.call("PUT", `/api/treasurer/payout-accounts/${streamer.username}`, {
      reference: "bank",
      payoutsEnabled: true,
    });
    expect(set.status).toBe(409);
  });

  test("account.updated with payouts_enabled enables it and re-pends held payouts", async () => {
    const [acct] = await db()
      .select()
      .from(schema.payoutAccounts)
      .where(eq(schema.payoutAccounts.userId, streamer.userId));
    const [held] = await db()
      .insert(schema.payouts)
      .values({
        userId: streamer.userId,
        periodStart: new Date("2020-01-01T00:00:00Z"),
        periodEnd: new Date("2020-02-01T00:00:00Z"),
        amountCents: 1000,
        currency: "usd",
        status: "held",
        provider: "stripe",
        holdReason: PAYOUT_ACCOUNT_NOT_READY,
      })
      .returning();
    // Connected accounts' events come from the Connect endpoint, signed with its own secret.
    api.deps.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
    accountsEnabled.set(acct?.providerAccountId ?? "", true);
    const evt = event("account.updated", { id: acct?.providerAccountId, payouts_enabled: true });
    expect((await deliver(evt, { secret: "whsec_neither" })).status).toBe(400);
    const r = await deliver(evt, { secret: CONNECT_SECRET });
    expect(r.body.outcome).toBe("payout_account_updated");
    const [after] = await db()
      .select()
      .from(schema.payoutAccounts)
      .where(eq(schema.payoutAccounts.userId, streamer.userId));
    expect(after?.payoutsEnabled).toBe(true);
    const [p] = await db()
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, held?.id ?? ""));
    expect(p).toMatchObject({ status: "pending", holdReason: null });
    const info = await streamer.client.call<{ payoutsEnabled: boolean; onboardingUrl: string | null }>(
      "GET",
      "/api/me/payout-account",
    );
    expect(info.body).toMatchObject({ payoutsEnabled: true, onboardingUrl: null });
  });

  test("each payout-card visit syncs payouts_enabled from Stripe (a missed event heals)", async () => {
    const [acct] = await db()
      .select()
      .from(schema.payoutAccounts)
      .where(eq(schema.payoutAccounts.userId, streamer.userId));
    const id = acct?.providerAccountId ?? "";
    accountsEnabled.set(id, false);
    const off = await streamer.client.call<{ payoutsEnabled: boolean; onboardingUrl: string | null }>(
      "GET",
      "/api/me/payout-account",
    );
    expect(off.body).toMatchObject({ payoutsEnabled: false, onboardingUrl: "https://connect.stripe.test/setup/x" });
    expect(stripeCalls.findLast((c) => c.method === "GET" && c.path === `/v1/accounts/${id}`)).toBeDefined();
    const [disabled] = await db()
      .select()
      .from(schema.payoutAccounts)
      .where(eq(schema.payoutAccounts.userId, streamer.userId));
    expect(disabled?.payoutsEnabled).toBe(false);

    const [held] = await db()
      .insert(schema.payouts)
      .values({
        userId: streamer.userId,
        periodStart: new Date("2020-03-01T00:00:00Z"),
        periodEnd: new Date("2020-04-01T00:00:00Z"),
        amountCents: 1000,
        currency: "usd",
        status: "held",
        provider: "stripe",
        holdReason: PAYOUT_ACCOUNT_NOT_READY,
      })
      .returning();
    accountsEnabled.set(id, true);
    const on = await streamer.client.call<{ payoutsEnabled: boolean; onboardingUrl: string | null }>(
      "GET",
      "/api/me/payout-account",
    );
    expect(on.body).toMatchObject({ payoutsEnabled: true, onboardingUrl: null });
    const [p] = await db()
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, held?.id ?? ""));
    expect(p).toMatchObject({ status: "pending", holdReason: null });
  });
});

describe("review fixes", () => {
  test("a renewal after the first payment was charged back is booked, keeps the subscription ended and stops Stripe", async () => {
    // alice's first payment (PI_A) went through a won dispute; her subscription stayed canceled.
    expect((await subscriptionOf(alice.userId))[0]?.status).toBe("canceled");
    const pi = `pi_${rand()}`;
    const before = stripeCalls.length;
    const r = await deliver(renewalInvoice(pi, SUB_A, subPay.paymentId, 999));
    expect(r).toMatchObject({ status: 200, body: { outcome: "paid_after_end" } });
    const [booked] = await db()
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.provider, "stripe"), eq(schema.payments.providerRef, pi)));
    expect(booked).toMatchObject({ status: "succeeded", amountCents: 999, feeCents: FEE });
    expect(await ledgerKinds(booked?.id ?? "")).toEqual(["payment"]);
    expect((await subscriptionOf(alice.userId))[0]?.status).toBe("canceled");
    expect(
      stripeCalls.slice(before).some((c) => c.method === "DELETE" && c.path === `/v1/subscriptions/${SUB_A}`),
    ).toBe(true);
  });

  test("first payment refunded in full: a renewal is booked, not dropped and not a 500 loop", async () => {
    const carol = await signUpAndSignIn(api);
    const s = await subscribe(carol, { tier: 1 });
    const sub = `sub_${rand()}`;
    const pi = `pi_${rand()}`;
    const first = event("invoice.paid", {
      id: `in_${rand()}`,
      billing_reason: "subscription_create",
      subscription: sub,
      subscription_details: { metadata: { payment_id: s.body.paymentId } },
      payment_intent: pi,
      amount_paid: 499,
      currency: "usd",
      status_transitions: { paid_at: nowS() },
    });
    expect((await deliver(first)).body.outcome).toBe("confirmed");
    const refundAll = event("charge.refunded", {
      id: `ch_${rand()}`,
      payment_intent: pi,
      amount_refunded: 499,
      currency: "usd",
      refunds: { data: [{ id: `re_${rand()}`, amount: 499 }] },
    });
    expect((await deliver(refundAll)).body.outcome).toBe("refunded");
    expect((await subscriptionOf(carol.userId))[0]?.status).toBe("canceled");
    const r = await deliver(renewalInvoice(`pi_${rand()}`, sub, s.body.paymentId, 499));
    expect(r).toMatchObject({ status: 200, body: { outcome: "paid_after_end" } });
  });

  test("first payment expired (failed): its paid first invoice and renewals are booked, never a 500 loop", async () => {
    const dave = await signUpAndSignIn(api);
    const s = await subscribe(dave, { tier: 1 });
    expect(
      (await deliver(event("checkout.session.expired", { metadata: { payment_id: s.body.paymentId } }))).body.outcome,
    ).toBe("checkout_failed");
    const sub = `sub_${rand()}`;
    const first = event("invoice.paid", {
      id: `in_${rand()}`,
      billing_reason: "subscription_create",
      subscription: sub,
      subscription_details: { metadata: { payment_id: s.body.paymentId } },
      payment_intent: `pi_${rand()}`,
      amount_paid: 499,
      currency: "usd",
      status_transitions: { paid_at: nowS() },
    });
    expect(await deliver(first)).toMatchObject({ status: 200, body: { outcome: "paid_after_end" } });
    expect((await paymentRow(s.body.paymentId)).status).toBe("failed");
    expect((await subscriptionOf(dave.userId))[0]?.status).toBe("expired");
    const r = await deliver(renewalInvoice(`pi_${rand()}`, sub, s.body.paymentId, 499));
    expect(r).toMatchObject({ status: 200, body: { outcome: "paid_after_end" } });
  });

  test("a charge without its balance transaction yet answers 500 (never a fee of 0); the retry books the fee", async () => {
    const p = (await tip(alice, 800)).body;
    const pi = `pi_${rand()}`;
    feeless.add(pi);
    const evt = event("checkout.session.completed", {
      mode: "payment",
      payment_status: "paid",
      metadata: { payment_id: p.paymentId },
      payment_intent: pi,
      amount_total: 800,
      currency: "usd",
    });
    const first = await deliver(evt);
    expect(first.status).toBe(500);
    expect((await paymentRow(p.paymentId)).status).toBe("pending");
    const [row] = await db()
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.providerEventId, evt.id));
    expect(row?.error).toMatch(/balance transaction/);
    feeless.delete(pi);
    expect((await deliver(evt)).body.outcome).toBe("confirmed");
    expect(await paymentRow(p.paymentId)).toMatchObject({ status: "succeeded", feeCents: FEE });
  });

  test("payment_events keeps no payer details (customer_details, emails, names, addresses)", async () => {
    const p = (await tip(alice, 900)).body;
    const evt = event("checkout.session.completed", {
      mode: "payment",
      payment_status: "paid",
      metadata: { payment_id: p.paymentId, note: "free text" },
      payment_intent: `pi_${rand()}`,
      amount_total: 900,
      currency: "usd",
      customer_email: "payer@example.test",
      customer_details: { email: "payer@example.test", name: "Pat Payer", address: { line1: "1 Main St" } },
    });
    expect((await deliver(evt)).body.outcome).toBe("confirmed");
    const [row] = await db()
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.providerEventId, evt.id));
    const stored = JSON.stringify(row?.payload);
    expect(stored).not.toContain("customer_details");
    expect(stored).not.toContain("payer@example.test");
    expect(stored).not.toContain("Pat Payer");
    expect(stored).not.toContain("free text");
    expect(stored).toContain(p.paymentId);
  });

  test("a second treasurer refund is refused while the first awaits Stripe's charge.refunded", async () => {
    const p = (await tip(alice, 1000)).body;
    const pi = `pi_${rand()}`;
    await deliver(
      event("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        metadata: { payment_id: p.paymentId },
        payment_intent: pi,
        amount_total: 1000,
        currency: "usd",
      }),
    );
    const path = `/api/treasurer/payments/${p.paymentId}/refund`;
    expect((await treasurer.client.call("POST", path, { amountCents: 200, reason: "one" })).status).toBe(200);
    expect((await treasurer.client.call("POST", path, { amountCents: 300, reason: "two" })).status).toBe(409);

    // charge.refunded without a `refunds` list (API 2024-06-20): the cumulative amount says what is new.
    const cumulative = (total: number) =>
      event("charge.refunded", { id: "ch_cumulative", payment_intent: pi, amount_refunded: total, currency: "usd" });
    expect((await deliver(cumulative(200))).body.outcome).toBe("refunded");
    expect((await deliver(cumulative(200))).body.outcome).toBe("no_new_refund");
    expect(await paymentRow(p.paymentId)).toMatchObject({ status: "partially_refunded", refundedCents: 200 });

    // Posted: the next request goes through, and its event adds only the difference.
    expect((await treasurer.client.call("POST", path, { amountCents: 800, reason: "rest" })).status).toBe(200);
    expect((await deliver(cumulative(1000))).body.outcome).toBe("refunded");
    expect(await paymentRow(p.paymentId)).toMatchObject({ status: "refunded", refundedCents: 1000 });
    const ds = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, p.paymentId));
    expect(ds.map((d) => d.amountCents).sort((a, b) => a - b)).toEqual([200, 800]);
  });
});

test("every ledger transaction balances", async () => {
  const off = await db().execute<{ transaction_id: string }>(sql`
    select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
  expect([...off]).toEqual([]);
});
