// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * M1-gifts-refunds against Postgres and a local Stripe fake (stripe-mock is stateless and cannot
 * time out on demand; decision (b), ADR 0003 D1): the automatic refund after an end (ADR 0007
 * decision 2), "outcome unknown" (decision 3), the treasurer's refund-request list and resolve, and
 * the payment receipt. Signed webhook events drive Stripe's side. The tests share state and run in
 * order.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import type { Mailer } from "@commonair/email";
import { createLogger } from "@commonair/observability";
import { loadStripeSignature } from "@commonair/payments";
import { autoRefundAfterEnd } from "../src/money/auto-refund.ts";
import { sendPaymentReceipt } from "../src/money/receipt.ts";
import { REFUND_RESOLVE_GRACE_MS, refundFaultKey } from "../src/money/stripe-refunds.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Redirect {
  kind: "redirect";
  url: string;
  paymentId: string;
}
interface View {
  id: string;
  paymentId: string;
  state: string;
  reason: string | null;
  requested: { cents: number; currency: string };
  requestedBy: { id: string; username: string } | null;
  markers: { action: string; at: string }[];
}

const SECRET = "whsec_m1_refunds";
const FEE = 31;
const TIERS = [
  { tier: 1, name: "Fan", price: { cents: 500, currency: "usd" }, benefits: "" },
  { tier: 2, name: "Super fan", price: { cents: 1000, currency: "usd" }, benefits: "" },
  { tier: 3, name: "Patron", price: { cents: 2500, currency: "usd" }, benefits: "" },
];

let api: TestApi;
let fake: ReturnType<typeof Bun.serve>;
let streamer: Account;
let treasurer: Account;
const refundCalls: { amount: string | null; key: string | null; paymentIntent: string | null }[] = [];
/** How the next refund creates are answered: a status (500 retried by the client, 400 final) or ok. */
const refundAnswers: (number | "ok")[] = [];
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 14);
const db = () => api.db.db;
const nowS = () => Math.floor(Date.now() / 1000);

function startFakeStripe() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = new URLSearchParams(req.method === "GET" ? "" : await req.text());
      if (url.pathname === "/v1/checkout/sessions") {
        const id = `cs_test_${rand()}`;
        return Response.json({ id, url: `https://checkout.stripe.test/c/pay/${id}` });
      }
      if (url.pathname.startsWith("/v1/payment_intents/"))
        return Response.json({ latest_charge: { balance_transaction: { fee: FEE, currency: "usd" } } });
      if (url.pathname.startsWith("/v1/subscriptions/")) return Response.json({ id: url.pathname.split("/").pop() });
      if (url.pathname === "/v1/refunds" && req.method === "POST") {
        refundCalls.push({
          amount: body.get("amount"),
          key: req.headers.get("idempotency-key"),
          paymentIntent: body.get("payment_intent"),
        });
        const answer = refundAnswers.shift() ?? "ok";
        if (answer === "ok") return Response.json({ id: `re_${rand()}`, status: "pending" });
        return Response.json({ error: { message: "no", type: "invalid_request_error" } }, { status: answer });
      }
      return Response.json({ error: { message: "not faked" } }, { status: 404 });
    },
  });
}

/** Mail and logs captured in memory (the receipt must log the payment id only). */
const sent: { template: string; props: Record<string, unknown>; to: string }[] = [];
const logLines: string[] = [];

beforeAll(async () => {
  fake = startFakeStripe();
  api = await startApi({ env: { OPS_TEST_HOOKS: "true" } });
  Object.assign(api.deps.env, {
    PAYMENTS_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_m1",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_API_BASE: `http://127.0.0.1:${fake.port}`,
  });
  [streamer, treasurer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  const set = await streamer.client.call("PUT", `/api/channels/${streamer.username}/subscription-tiers`, {
    tiers: TIERS,
  });
  if (set.status !== 200) throw new Error(`setTiers failed: ${set.status}`);
  // From here on, mail and logs stay in memory.
  const mailer: Mailer = {
    async send(template, props, to) {
      sent.push({ template, props: props as Record<string, unknown>, to });
      return `m-${sent.length}`;
    },
    close: async () => {},
  };
  api.deps.mailer = mailer;
  api.deps.logger = createLogger({ service: "api-test", level: "debug", write: (l) => logLines.push(l) });
}, 180_000);
afterAll(async () => {
  await api?.stop();
  await fake?.stop(true);
});

function event(type: string, object: Record<string, unknown>, id = `evt_${rand()}`) {
  return { id, object: "event", type, api_version: "2024-06-20", created: nowS(), livemode: false, data: { object } };
}
async function deliver(evt: unknown) {
  const { signStripePayload } = await loadStripeSignature();
  const body = JSON.stringify(evt);
  const header = await signStripePayload(SECRET, body, nowS());
  const res = await fetch(`${api.url}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body,
  });
  return { status: res.status, body: (await res.json()) as { outcome?: string; duplicate?: boolean } };
}
const paymentRow = async (id: string) => {
  const [p] = await db().select().from(schema.payments).where(eq(schema.payments.id, id));
  if (!p) throw new Error(`no payment ${id}`);
  return p;
};
const paymentByRef = async (ref: string) => {
  const [p] = await db()
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.provider, "stripe"), eq(schema.payments.providerRef, ref)));
  if (!p) throw new Error(`no payment ${ref}`);
  return p;
};
const markers = async (paymentId: string) =>
  db()
    .select({
      action: schema.auditLog.action,
      actorType: schema.auditLog.actorType,
      actorId: schema.auditLog.actorId,
      reason: schema.auditLog.reason,
      details: schema.auditLog.details,
    })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectType, "payment"), eq(schema.auditLog.subjectId, paymentId)))
    .orderBy(schema.auditLog.createdAt, schema.auditLog.id);
const subscribe = (as: Account, body: Record<string, unknown>) =>
  as.client.call<Redirect>("POST", `/api/channels/${streamer.username}/subscriptions`, {
    returnPath: `/${streamer.username}`,
    ...body,
  });
const listRequests = (state: string) =>
  treasurer.client.call<{ items: View[]; nextCursor: string | null }>(
    "GET",
    `/api/treasurer/refund-requests?state=${state}`,
  );

/** A paid tip (confirmed by a signed checkout.session.completed). */
async function paidTip(payer: Account, cents: number) {
  const r = await payer.client.call<Redirect>("POST", `/api/channels/${streamer.username}/tips`, {
    amountCents: cents,
    message: "hi",
    anonymous: false,
    returnPath: `/${streamer.username}`,
  });
  const pi = `pi_${rand()}`;
  const done = await deliver(
    event("checkout.session.completed", {
      mode: "payment",
      payment_status: "paid",
      metadata: { payment_id: r.body.paymentId },
      payment_intent: pi,
      amount_total: cents,
      currency: "usd",
    }),
  );
  expect(done.body.outcome).toBe("confirmed");
  return { paymentId: r.body.paymentId, pi };
}

/** A Stripe subscription confirmed, then ended by a full refund (the canceled state). */
async function endedSubscription(payer: Account) {
  const s = await subscribe(payer, { tier: 1 });
  const sub = `sub_${rand()}`;
  const pi = `pi_${rand()}`;
  const first = event("invoice.paid", {
    id: `in_${rand()}`,
    billing_reason: "subscription_create",
    subscription: sub,
    subscription_details: { metadata: { payment_id: s.body.paymentId } },
    payment_intent: pi,
    amount_paid: 500,
    currency: "usd",
    status_transitions: { paid_at: nowS() },
  });
  expect((await deliver(first)).body.outcome).toBe("confirmed");
  const refundAll = event("charge.refunded", {
    id: `ch_${rand()}`,
    payment_intent: pi,
    amount_refunded: 500,
    currency: "usd",
    refunds: { data: [{ id: `re_${rand()}`, amount: 500 }] },
  });
  expect((await deliver(refundAll)).body.outcome).toBe("refunded");
  return { firstPaymentId: s.body.paymentId, sub };
}
const renewal = (pi: string, sub: string, firstPaymentId: string, amount = 500) =>
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

describe("automatic refund after an end (ADR 0007 decision 2)", () => {
  let booked: string;
  let pi: string;

  test("a paid_after_end booking asks Stripe to refund it in full, once, as the system", async () => {
    const payer = await signUpAndSignIn(api);
    const ended = await endedSubscription(payer);
    pi = `pi_${rand()}`;
    const before = refundCalls.length;
    const evt = renewal(pi, ended.sub, ended.firstPaymentId);
    const r = await deliver(evt);
    expect(r).toMatchObject({ status: 200, body: { outcome: "paid_after_end" } });
    const p = await paymentByRef(pi);
    booked = p.id;
    expect(refundCalls.slice(before)).toEqual([{ amount: "500", key: `refund-${p.id}-0-500`, paymentIntent: pi }]);
    const ms = await markers(p.id);
    const requested = ms.filter((m) => m.action === "payment.refund_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ actorType: "system", actorId: null, reason: "" });
    expect(requested[0]?.details).toMatchObject({ amountCents: 500, reason: "paid_after_end" });
    expect(ms.map((m) => m.action)).toContain("payment.refund_submitted");
    // Never reactivated.
    const [sub] = await db()
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.subscriberId, payer.userId));
    expect(sub?.status).toBe("canceled");

    // A redelivered event, and the hook run again (the reconciler's sweep), add nothing.
    expect((await deliver(evt)).body.duplicate).toBe(true);
    const api2 = await autoRefundAfterEnd(api.deps, p.id);
    expect(api2).toBe("already_requested");
    expect(refundCalls.length).toBe(before + 1);
    expect((await markers(p.id)).filter((m) => m.action === "payment.refund_requested")).toHaveLength(1);
  });

  test("the treasurer list shows it with reason paid_after_end; charge.refunded posts it", async () => {
    const out = await listRequests("outstanding");
    expect(out.status).toBe(200);
    const v = out.body.items.find((i) => i.paymentId === booked);
    expect(v).toMatchObject({ state: "outstanding", reason: "paid_after_end", requestedBy: null });
    expect(v?.requested).toEqual({ cents: 500, currency: "usd" });
    expect(v?.markers.map((m) => m.action)).toEqual(["payment.refund_requested", "payment.refund_submitted"]);
    const submitted = (await markers(booked)).find((m) => m.action === "payment.refund_submitted");
    const refundRef = String(submitted?.details.refundRef);
    const r = await deliver(
      event("charge.refunded", {
        id: `ch_${rand()}`,
        payment_intent: pi,
        amount_refunded: 500,
        currency: "usd",
        refunds: { data: [{ id: refundRef, amount: 500 }] },
      }),
    );
    expect(r.body.outcome).toBe("refunded");
    expect(await paymentRow(booked)).toMatchObject({ status: "refunded", refundedCents: 500 });
    const after = await listRequests("all");
    expect(after.body.items.find((i) => i.paymentId === booked)?.state).toBe("resolved");
  });

  test("a payment already partly refunded by a treasurer is refunded for the rest only", async () => {
    // The rule does not care how the payment was booked; a paid tip partly refunded stands in for a
    // paid_after_end booking a treasurer reached before the hook did.
    const payer = await signUpAndSignIn(api);
    const { paymentId, pi: pi2 } = await paidTip(payer, 1000);
    const path = `/api/treasurer/payments/${paymentId}/refund`;
    expect((await treasurer.client.call("POST", path, { amountCents: 300, reason: "partial" })).status).toBe(200);
    // While the treasurer's request waits for Stripe, the automatic refund stands back.
    expect(await autoRefundAfterEnd(api.deps, paymentId)).toBe("outstanding");
    await deliver(
      event("charge.refunded", {
        id: `ch_${rand()}`,
        payment_intent: pi2,
        amount_refunded: 300,
        currency: "usd",
        refunds: { data: [{ id: `re_${rand()}`, amount: 300 }] },
      }),
    );
    expect(await paymentRow(paymentId)).toMatchObject({ status: "partially_refunded", refundedCents: 300 });
    const before = refundCalls.length;
    expect(await autoRefundAfterEnd(api.deps, paymentId)).toBe("requested");
    expect(refundCalls.slice(before).map((c) => c.amount)).toEqual(["700"]);
    expect(refundCalls.at(-1)?.key).toBe(`refund-${paymentId}-300-700`);
    expect(await autoRefundAfterEnd(api.deps, paymentId)).toBe("already_requested");
  });
});

describe("outcome unknown (ADR 0007 decision 3)", () => {
  test("Stripe answering 5xx then 200 inside the client is a success, not unknown", async () => {
    const { paymentId } = await paidTip(await signUpAndSignIn(api), 900);
    refundAnswers.push(500);
    const r = await treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/refund`, {
      amountCents: 100,
      reason: "x",
    });
    expect(r.status).toBe(200);
    expect((await markers(paymentId)).map((m) => m.action)).toEqual([
      "payment.refund_requested",
      "payment.refund_submitted",
    ]);
  });

  test("a timeout writes outcome_unknown with its key and keeps blocking; a matching posting releases", async () => {
    const payer = await signUpAndSignIn(api);
    const { paymentId, pi } = await paidTip(payer, 1100);
    const path = `/api/treasurer/payments/${paymentId}/refund`;
    refundAnswers.push(500, 500, 500); // the first try and the client's two retries
    const r = await treasurer.client.call("POST", path, { amountCents: 400, reason: "x" });
    expect(r.status).toBe(412);
    const ms = await markers(paymentId);
    expect(ms.map((m) => m.action)).toEqual(["payment.refund_requested", "payment.refund_outcome_unknown"]);
    expect(ms[1]?.details).toMatchObject({ idempotencyKey: `refund-${paymentId}-0-400` });
    // Stripe may have refunded: a second request is refused.
    expect((await treasurer.client.call("POST", path, { amountCents: 400, reason: "x" })).status).toBe(409);
    const unknown = await listRequests("unknown");
    const v = unknown.body.items.find((i) => i.paymentId === paymentId);
    expect(v).toMatchObject({ state: "unknown", requestedBy: { id: treasurer.userId, username: treasurer.username } });
    expect(v?.markers.map((m) => m.action)).toEqual(["payment.refund_requested", "payment.refund_outcome_unknown"]);

    // Stripe did refund: its charge.refunded (of that amount) settles it.
    const posted = await deliver(
      event("charge.refunded", {
        id: `ch_${rand()}`,
        payment_intent: pi,
        amount_refunded: 400,
        currency: "usd",
        refunds: { data: [{ id: `re_${rand()}`, amount: 400 }] },
      }),
    );
    expect(posted.body.outcome).toBe("refunded");
    expect((await listRequests("unknown")).body.items.some((i) => i.paymentId === paymentId)).toBe(false);
    expect((await treasurer.client.call("POST", path, { amountCents: 100, reason: "x" })).status).toBe(200);
  });

  test("the harness fault hook (OPS_TEST_HOOKS) times out one call without reaching Stripe", async () => {
    const payer = await signUpAndSignIn(api);
    const { paymentId } = await paidTip(payer, 1200);
    await api.deps.valkey.set(refundFaultKey(paymentId), "1", "EX", 600);
    const before = refundCalls.length;
    const r = await treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/refund`, {
      amountCents: 1200,
      reason: "x",
    });
    expect(r.status).toBe(412);
    expect(refundCalls.length).toBe(before);
    expect((await markers(paymentId)).map((m) => m.action)).toContain("payment.refund_outcome_unknown");
    expect(await api.deps.valkey.exists(refundFaultKey(paymentId))).toBe(0);
  });

  test("a 4xx is a definite refusal: released, and the retry goes through", async () => {
    const payer = await signUpAndSignIn(api);
    const { paymentId } = await paidTip(payer, 1300);
    const path = `/api/treasurer/payments/${paymentId}/refund`;
    refundAnswers.push(400);
    expect((await treasurer.client.call("POST", path, { amountCents: 100, reason: "x" })).status).toBe(412);
    expect((await markers(paymentId)).map((m) => m.action)).toEqual([
      "payment.refund_requested",
      "payment.refund_request_failed",
    ]);
    expect((await treasurer.client.call("POST", path, { amountCents: 100, reason: "x" })).status).toBe(200);
  });

  test("refund.updated names the refund of an unknown request; its refund.failed then releases it once", async () => {
    const payer = await signUpAndSignIn(api);
    const { paymentId, pi } = await paidTip(payer, 1400);
    refundAnswers.push(500, 500, 500);
    await treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/refund`, {
      amountCents: 200,
      reason: "x",
    });
    const refundId = `re_${rand()}`;
    const updated = { id: refundId, object: "refund", amount: 200, currency: "usd", payment_intent: pi };
    expect((await deliver(event("refund.updated", { ...updated, status: "pending" }))).body.outcome).toBe(
      "refund_attached",
    );
    // Stripe sends the same refund as charge.refund.updated too: recorded once.
    expect((await deliver(event("charge.refund.updated", { ...updated, status: "pending" }))).body.outcome).toBe(
      "refund_updated",
    );
    expect((await deliver(event("refund.failed", { ...updated, status: "failed" }))).body.outcome).toBe(
      "refund_failed",
    );
    expect((await deliver(event("refund.updated", { ...updated, status: "failed" }))).body.outcome).toBe(
      "refund_failed",
    );
    const ms = await markers(paymentId);
    expect(ms.filter((m) => m.action === "payment.refund_request_failed")).toHaveLength(1);
    expect(ms.filter((m) => m.action === "payment.refund_submitted")).toHaveLength(1);
    expect(
      (
        await treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/refund`, {
          amountCents: 200,
          reason: "x",
        })
      ).status,
    ).toBe(200);
  });

  test("a failure of a refund nobody named releases an unknown request only when its amount matches", async () => {
    const payer = await signUpAndSignIn(api);
    const { paymentId, pi } = await paidTip(payer, 1400);
    refundAnswers.push(500, 500, 500);
    await treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/refund`, {
      amountCents: 1000,
      reason: "x",
    });
    const again = () =>
      treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/refund`, { amountCents: 300, reason: "x" });
    // A dashboard refund of 300 fails: refund.failed carries no amount, so it is recorded by id only.
    const dash = { object: "refund", amount: 300, currency: "usd", payment_intent: pi };
    await deliver(event("refund.failed", { ...dash, id: `re_${rand()}`, status: "failed" }));
    // refund.updated canceled of another amount: not this request's either.
    await deliver(event("refund.updated", { ...dash, id: `re_${rand()}`, status: "canceled" }));
    expect((await again()).status).toBe(409);
    const failed = (await markers(paymentId)).filter((m) => m.action === "payment.refund_request_failed");
    expect(failed).toHaveLength(2);
    for (const f of failed) expect(f.details).not.toHaveProperty("requestId");
    // A canceled refund of exactly its amount is its refund: released.
    await deliver(event("refund.updated", { ...dash, amount: 1000, id: `re_${rand()}`, status: "canceled" }));
    expect((await again()).status).toBe(200);
  });

  test("a refund.updated for a payment we do not know is ignored", async () => {
    const r = await deliver(
      event("refund.updated", {
        id: `re_${rand()}`,
        amount: 1,
        currency: "usd",
        payment_intent: "pi_nobody",
        status: "succeeded",
      }),
    );
    expect(r.body.outcome).toBe("ignored");
  });
});

describe("a gift paid after its window", () => {
  test("is never credited: the late checkout is refused (500, retried by Stripe) and nothing is posted", async () => {
    // Today the late one-off charge of an expired gift stops at refuseFinished in stripe-events.ts
    // ("refund it in Stripe"); booking and auto-refunding it is a contract request (report).
    const [gifter, recipient] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const g = await subscribe(gifter, { tier: 1, gift: { count: 1, to: recipient.username } });
    expect(g.status).toBe(200);
    const p = await paymentRow(g.body.paymentId);
    expect(p.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 5_000);
    // 24 h 01 m later, money-expire-pending has failed it (the worker's own test covers the job).
    await db().update(schema.payments).set({ status: "failed" }).where(eq(schema.payments.id, p.id));
    const late = await deliver(
      event("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        metadata: { payment_id: p.id },
        payment_intent: `pi_${rand()}`,
        amount_total: p.amountCents,
        currency: "usd",
      }),
    );
    expect(late.status).toBe(500);
    expect((await paymentRow(p.id)).status).toBe("failed");
    const posted = await db()
      .select()
      .from(schema.ledgerTransactions)
      .where(and(eq(schema.ledgerTransactions.refType, "payment"), eq(schema.ledgerTransactions.refId, p.id)));
    expect(posted).toEqual([]);
  });

  test("one paid inside its window confirms", async () => {
    const [gifter, recipient] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const g = await subscribe(gifter, { tier: 1, gift: { count: 1, to: recipient.username } });
    const ok = await deliver(
      event("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        metadata: { payment_id: g.body.paymentId },
        payment_intent: `pi_${rand()}`,
        amount_total: 500,
        currency: "usd",
      }),
    );
    expect(ok.body.outcome).toBe("confirmed");
    expect((await paymentRow(g.body.paymentId)).status).toBe("succeeded");
  });
});

describe("refundRequests.resolve", () => {
  let paymentId: string;
  let requestId: string;

  test("is refused in the first 15 minutes, while the reconciler still asks Stripe", async () => {
    const payer = await signUpAndSignIn(api);
    ({ paymentId } = await paidTip(payer, 1500));
    refundAnswers.push(500, 500, 500);
    await treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/refund`, {
      amountCents: 1500,
      reason: "x",
    });
    const v = (await listRequests("unknown")).body.items.find((i) => i.paymentId === paymentId);
    requestId = v?.id ?? "";
    expect(requestId).not.toBe("");
    const r = await treasurer.client.call("POST", `/api/treasurer/refund-requests/${requestId}/resolve`, {
      outcome: "failed",
      note: "checked the dashboard",
    });
    expect(r.status).toBe(412);
    expect((r.body as { data?: { requirement?: string } }).data?.requirement).toBe("refund_reconciling");
  });

  test("afterwards it is audited with the treasurer and the note, and releases the request", async () => {
    const realNow = api.deps.now;
    api.deps.now = () => new Date(Date.now() + REFUND_RESOLVE_GRACE_MS + 60_000);
    try {
      const r = await treasurer.client.call<View>("POST", `/api/treasurer/refund-requests/${requestId}/resolve`, {
        outcome: "failed",
        note: "checked the dashboard",
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: requestId, state: "resolved" });
      const audit = (await markers(paymentId)).find((m) => m.action === "payment.refund_resolved");
      expect(audit).toMatchObject({
        actorType: "admin",
        actorId: treasurer.userId,
        reason: "checked the dashboard",
        details: { requestId, outcome: "failed" },
      });
      // A second resolve finds it settled.
      expect(
        (
          await treasurer.client.call("POST", `/api/treasurer/refund-requests/${requestId}/resolve`, {
            outcome: "refunded",
          })
        ).status,
      ).toBe(409);
    } finally {
      api.deps.now = realNow;
    }
  });

  test("an unknown request id is NOT_FOUND; a viewer is refused", async () => {
    const id = "01890000-0000-7000-8000-00000000dead";
    expect(
      (await treasurer.client.call("POST", `/api/treasurer/refund-requests/${id}/resolve`, { outcome: "failed" }))
        .status,
    ).toBe(404);
    const viewer = await signUpAndSignIn(api);
    expect((await viewer.client.call("GET", "/api/treasurer/refund-requests")).status).toBe(403);
  });

  test("the list pages", async () => {
    const first = await treasurer.client.call<{ items: View[]; nextCursor: string | null }>(
      "GET",
      "/api/treasurer/refund-requests?state=all&limit=2",
    );
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await treasurer.client.call<{ items: View[] }>(
      "GET",
      `/api/treasurer/refund-requests?state=all&limit=2&cursor=${first.body.nextCursor}`,
    );
    const ids = [...first.body.items, ...second.body.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the payment receipt", () => {
  test("is sent once per payment, with the breakdown lines, and logs the payment id only", async () => {
    const payer = await signUpAndSignIn(api);
    sent.length = 0;
    logLines.length = 0;
    const { paymentId, pi } = await paidTip(payer, 2000);
    const mine = sent.filter((m) => m.template === "paymentReceipt");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.to).toBe(payer.email);
    expect(mine[0]?.props).toMatchObject({
      amountCents: 2000,
      currency: "usd",
      reference: pi,
      channelName: expect.any(String),
      kind: "tip",
    });
    const lines = mine[0]?.props.lines as { kind: string; amountCents: number }[];
    expect(lines.map((l) => l.kind)).toEqual(expect.arrayContaining(["creator", "coop_share"]));
    expect(lines.filter((l) => l.kind !== "processor_fee").reduce((s, l) => s + l.amountCents, 0)).toBeGreaterThan(0);

    // Once: a second call (a retry, the treasurer path) finds the marker.
    expect(await sendPaymentReceipt(api.deps, paymentId)).toBe("already_sent");
    expect(sent.filter((m) => m.template === "paymentReceipt")).toHaveLength(1);
    const receipts = await db()
      .select({ action: schema.auditLog.action, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "payment_receipt"), eq(schema.auditLog.subjectId, paymentId)));
    expect(receipts).toEqual([{ action: "payment.receipt_sent", details: { paymentId, kind: "tip" } }]);

    const logged = logLines.join("\n");
    expect(logged).toContain(paymentId);
    expect(logged).not.toContain(payer.email);
    expect(logged).not.toContain(payer.username);
  });

  test("is skipped for a deleted payer or one without a verified address", async () => {
    const payer = await signUpAndSignIn(api);
    await db().update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, payer.userId));
    sent.length = 0;
    const { paymentId } = await paidTip(payer, 2100);
    expect(sent.filter((m) => m.template === "paymentReceipt")).toHaveLength(0);
    expect(await sendPaymentReceipt(api.deps, paymentId)).toBe("email_unverified");
    await db()
      .update(schema.users)
      .set({ emailVerified: true, deletedAt: new Date() })
      .where(eq(schema.users.id, payer.userId));
    expect(await sendPaymentReceipt(api.deps, paymentId)).toBe("payer_deleted");
  });

  test("a pending payment gets none", async () => {
    const payer = await signUpAndSignIn(api);
    const r = await subscribe(payer, { tier: 1 });
    expect(await sendPaymentReceipt(api.deps, r.body.paymentId)).toBe("not_succeeded");
  });
});

test("every ledger transaction balances", async () => {
  const off = await db().execute<{ transaction_id: string }>(sql`
    select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
  expect([...off]).toEqual([]);
});
