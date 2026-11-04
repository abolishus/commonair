// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Member shares paid by card (batch 8, M1-coop-money; ADR 0020): `buyShare` starts a Stripe Checkout
 * only when the instance runs Stripe and `shares.cardPayments` is on; a signed `checkout.completed`
 * books the share, posts `share_purchase` and activates the viewer membership in one transaction; a
 * member who left during the checkout is booked and set `refund_pending`; a failed checkout
 * releases the share; the treasurer's refund of a card share goes through the shared request guard
 * and the `shareRefund` posting follows `charge.refunded`. The manual path is unchanged.
 *
 * Stripe is a local `Bun.serve` fake for refunds (stripe-mock answers one fixture id for every
 * create). The share's Checkout Session comes from an injected adapter: the stock Stripe adapter
 * refuses `membership_share` until the contract request lands (`packages/payments/src/stripe.ts`).
 * The `charge.refunded` and `checkout.failed` dispatch for shares is a contract request
 * (`stripe-events.ts`), so those handlers are driven directly in a transaction, as the webhook will.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { accounts, rawBalance } from "@commonair/ledger";
import { type PaymentAdapter, type StripeAction, createAdapter, loadStripeSignature } from "@commonair/payments";
import { setShareAdapter, shareCheckoutMode } from "../src/coop/shares.ts";
import { shareChargeRefundedAction, shareCheckoutFailed } from "../src/money/stripe-events/shares.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Err {
  code: string;
  data?: Record<string, unknown>;
}
type Checkout =
  | { kind: "redirect"; url: string; paymentId: string }
  | { kind: "instructions"; paymentId: string; reference: string; instructions: string };

const SECRET = "whsec_int_shares";
const SHARE_ON = { "shares.cardPayments": { enabled: true } };
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 14);
const nowS = () => Math.floor(Date.now() / 1000);

function startFakeStripe(calls: { path: string; body: URLSearchParams; key: string | null }[]) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = new URLSearchParams(req.method === "GET" ? "" : await req.text());
      calls.push({ path: url.pathname, body, key: req.headers.get("idempotency-key") });
      if (url.pathname === "/v1/refunds") return Response.json({ id: `re_${rand()}`, status: "succeeded" });
      if (url.pathname.startsWith("/v1/payment_intents/"))
        return Response.json({ latest_charge: { balance_transaction: { fee: 59, currency: "usd" } } });
      return Response.json({ error: { message: "not faked" } }, { status: 404 });
    },
  });
}

/** The share Checkout Session as the Stripe adapter will build it once it accepts shares. */
function checkoutAdapter(base: PaymentAdapter, sessions: { paymentId: string; reference: string }[]): PaymentAdapter {
  return {
    ...base,
    provider: "stripe",
    async startCheckout(r) {
      expect(r.kind).toBe("membership_share");
      expect(r.creatorUserId).toBeNull();
      const reference = r.reference ?? `CA-${rand().slice(0, 6).toUpperCase()}`;
      sessions.push({ paymentId: r.paymentId, reference });
      return { kind: "redirect", url: `https://checkout.stripe.test/c/pay/cs_${r.paymentId}`, providerRef: reference };
    },
  };
}

function event(type: string, object: Record<string, unknown>) {
  return {
    id: `evt_${rand()}`,
    object: "event",
    type,
    api_version: "2024-06-20",
    created: nowS(),
    livemode: false,
    data: { object },
  };
}

describe("shareCheckoutMode", () => {
  const on = { "shares.cardPayments": { enabled: true } };
  const off = { "shares.cardPayments": { enabled: false } };
  test("card only with Stripe and the setting on; manual instances stay manual", () => {
    expect(shareCheckoutMode({ PAYMENTS_PROVIDER: "stripe", COOP_TEST_HOOKS: false }, on)).toBe("card");
    expect(shareCheckoutMode({ PAYMENTS_PROVIDER: "stripe", COOP_TEST_HOOKS: true }, on)).toBe("card");
    expect(shareCheckoutMode({ PAYMENTS_PROVIDER: "manual", COOP_TEST_HOOKS: false }, on)).toBe("manual");
    expect(shareCheckoutMode({ PAYMENTS_PROVIDER: "manual", COOP_TEST_HOOKS: false }, off)).toBe("manual");
  });
  test("Stripe with the setting off (or unreadable) refuses, except under the test hooks", () => {
    expect(shareCheckoutMode({ PAYMENTS_PROVIDER: "stripe", COOP_TEST_HOOKS: false }, off)).toBe("refused");
    expect(shareCheckoutMode({ PAYMENTS_PROVIDER: "stripe", COOP_TEST_HOOKS: false }, {})).toBe("refused");
    expect(
      shareCheckoutMode(
        { PAYMENTS_PROVIDER: "stripe", COOP_TEST_HOOKS: false },
        { "shares.cardPayments": { enabled: "yes" } },
      ),
    ).toBe("refused");
    expect(shareCheckoutMode({ PAYMENTS_PROVIDER: "stripe", COOP_TEST_HOOKS: true }, off)).toBe("manual");
  });
});

describe("the setting off, and the manual path", () => {
  let api: TestApi;
  let viewer: Account;
  let treasurer: Account;
  beforeAll(async () => {
    api = await startApi();
    [viewer, treasurer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    await api.db.db.update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  }, 180_000);
  afterAll(async () => {
    await api?.stop();
  });

  test("Stripe with shares.cardPayments off (the seed) still answers manual_shares", async () => {
    Object.assign(api.deps.env, { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_int" });
    try {
      const r = await viewer.client.call<Err>("POST", "/api/coop/shares", { returnPath: "/coop/membership" });
      expect(r.status).toBe(412);
      expect(r.body.data).toEqual({ requirement: "manual_shares" });
      const rows = await api.db.db
        .select()
        .from(schema.membershipShares)
        .where(eq(schema.membershipShares.userId, viewer.userId));
      expect(rows).toHaveLength(0);
    } finally {
      Object.assign(api.deps.env, { PAYMENTS_PROVIDER: "manual" });
    }
  });

  test("the manual path is unchanged: instructions, then a treasurer confirms and the member is active", async () => {
    const r = await viewer.client.call<Checkout>("POST", "/api/coop/shares", { returnPath: "/coop/membership" });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("instructions");
    if (r.body.kind !== "instructions") return;
    expect(r.body.reference).toMatch(/^CA-/);
    const ok = await treasurer.client.call("POST", `/api/treasurer/payments/${r.body.paymentId}/confirm`, {
      receivedAt: new Date().toISOString(),
    });
    expect(ok.status).toBe(200);
    const [share] = await api.db.db
      .select()
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.paymentId, r.body.paymentId));
    expect(share?.status).toBe("held");
    const view = await viewer.client.call<{ memberships: { class: string; status: string; basis: string }[] }>(
      "GET",
      "/api/coop/membership",
    );
    expect(view.body.memberships).toContainEqual(
      expect.objectContaining({ class: "viewer", status: "active", basis: "share" }),
    );
    const [posted] = await api.db.db
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `share-purchase:${share?.id ?? ""}`));
    expect(posted?.kind).toBe("share_purchase");
  });
});

describe("shares by card", () => {
  let api: TestApi;
  let fake: ReturnType<typeof Bun.serve>;
  const stripeCalls: { path: string; body: URLSearchParams; key: string | null }[] = [];
  const sessions: { paymentId: string; reference: string }[] = [];
  let viewer: Account;
  let leaver: Account;
  let racer: Account;
  let treasurer: Account;
  let purchase: { paymentId: string; shareId: string; pi: string };

  const db = () => api.db.db;
  async function deliver(evt: unknown) {
    const { signStripePayload } = await loadStripeSignature();
    const body = JSON.stringify(evt);
    const res = await fetch(`${api.url}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": await signStripePayload(SECRET, body, nowS()),
      },
      body,
    });
    return { status: res.status, body: (await res.json()) as { outcome?: string; duplicate?: boolean } };
  }
  const completed = (paymentId: string, pi: string, amount: number) =>
    event("checkout.session.completed", {
      id: `cs_test_${rand()}`,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      status: "complete",
      client_reference_id: paymentId,
      metadata: { payment_id: paymentId },
      payment_intent: pi,
      subscription: null,
      amount_total: amount,
      currency: "usd",
      total_details: { amount_tax: 0 },
    });
  const shareOf = async (paymentId: string) => {
    const [s] = await db()
      .select()
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.paymentId, paymentId));
    if (!s) throw new Error("no share");
    return s;
  };
  const paymentOf = async (id: string) => {
    const [p] = await db().select().from(schema.payments).where(eq(schema.payments.id, id));
    if (!p) throw new Error("no payment");
    return p;
  };
  const buy = (as: Account) => as.client.call<Checkout>("POST", "/api/coop/shares", { returnPath: "/coop/membership" });
  async function expectLedgerBalanced() {
    const off = await db().execute<{ transaction_id: string }>(sql`
      select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
    expect([...off]).toEqual([]);
  }
  const memberShareOwed = async (userId: string) => 0 - (await rawBalance(db(), accounts.memberShare(userId), "usd"));

  beforeAll(async () => {
    fake = startFakeStripe(stripeCalls);
    api = await startApi({ governance: SHARE_ON });
    Object.assign(api.deps.env, {
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_int",
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${fake.port}`,
    });
    setShareAdapter(api.deps, checkoutAdapter(createAdapter(api.deps.env), sessions));
    [viewer, leaver, racer, treasurer] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  }, 180_000);
  afterAll(async () => {
    await api?.stop();
    await fake?.stop(true);
  });

  test("buyShare starts a Stripe Checkout; the payment and share wait, pending", async () => {
    const r = await buy(viewer);
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("redirect");
    const p = await paymentOf(r.body.paymentId);
    expect(p).toMatchObject({ provider: "stripe", kind: "membership_share", status: "pending", channelId: null });
    const s = await shareOf(p.id);
    expect(s.status).toBe("pending");
    expect(s.amountCents).toBe(p.amountCents);
    purchase = { paymentId: p.id, shareId: s.id, pi: `pi_${rand()}` };
    const view = await viewer.client.call<{ share: { status: string; reference: string | null } }>(
      "GET",
      "/api/coop/membership",
    );
    // A card share carries no bank-transfer instructions.
    expect(view.body.share).toMatchObject({ status: "pending", reference: null });
  });

  test("asking again while the checkout is open returns the same payment and session", async () => {
    const r = await buy(viewer);
    expect(r.status).toBe(200);
    expect(r.body.paymentId).toBe(purchase.paymentId);
    const two = sessions.filter((x) => x.paymentId === purchase.paymentId);
    expect(two).toHaveLength(2);
    expect(two[1]?.reference).toBe(two[0]?.reference);
  });

  test("two purchases racing make one pending share", async () => {
    const [a, b] = await Promise.all([buy(racer), buy(racer)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.paymentId).toBe(b.body.paymentId);
    const rows = await db()
      .select()
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.userId, racer.userId));
    expect(rows).toHaveLength(1);
  });

  test("a signed checkout.completed books the share and activates the membership in one transaction", async () => {
    const p = await paymentOf(purchase.paymentId);
    const r = await deliver(completed(p.id, purchase.pi, p.amountCents));
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("share_confirmed");
    const paid = await paymentOf(p.id);
    expect(paid).toMatchObject({ status: "succeeded", providerRef: purchase.pi });
    const s = await shareOf(p.id);
    expect(s.status).toBe("held");
    expect(s.purchasedAt).not.toBeNull();
    const [m] = await db()
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, viewer.userId), eq(schema.memberships.class, "viewer")));
    expect(m).toMatchObject({ status: "active", basis: "share" });
    const [posting] = await db()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `share-purchase:${s.id}`));
    expect(posting?.kind).toBe("share_purchase");
    // The share is the co-op's liability to the member, in Stripe cash; no name in the metadata.
    expect(await memberShareOwed(viewer.userId)).toBe(p.amountCents);
    expect(posting?.metadata).toEqual({ userId: viewer.userId });
    // One top-level transaction: the ledger records it (`txid_current()`), and the payment row carries
    // it; the share and membership rows, written after the posting's savepoint, carry one subtransaction
    // id of it (always above the top-level id).
    const [tx] = await db().execute<{ ledger: string; payment: string; share: string; membership: string }>(sql`
      select (select txid::text from ledger_transactions where idempotency_key = ${`share-purchase:${s.id}`}) as ledger,
             (select xmin::text from payments where id = ${p.id}) as payment,
             (select xmin::text from membership_shares where id = ${s.id}) as share,
             (select xmin::text from memberships where id = ${m?.id ?? null}) as membership`);
    expect(tx?.ledger).toBe(tx?.payment);
    expect(tx?.share).toBe(tx?.membership);
    expect(Number(tx?.share)).toBeGreaterThanOrEqual(Number(tx?.ledger));
    const events = await db().select().from(schema.events).where(eq(schema.events.type, "coop.membership.update"));
    expect(events.some((e) => (e.payload as Record<string, unknown>).membership_id === m?.id)).toBe(true);
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "payment.confirm"), eq(schema.auditLog.subjectId, p.id)));
    expect(audits).toHaveLength(1);
    await expectLedgerBalanced();
  });

  test("a redelivered checkout.completed changes nothing", async () => {
    const p = await paymentOf(purchase.paymentId);
    const r = await deliver(completed(p.id, purchase.pi, p.amountCents));
    expect(r.status).toBe(200);
    expect(["already_processed", undefined]).toContain(r.body.outcome);
    expect(await memberShareOwed(viewer.userId)).toBe(p.amountCents);
  });

  test("a share paid after the member left during checkout is booked, then refund_pending, never activated", async () => {
    // The leaver is a viewer member by subscription, starts buying a share, then leaves the co-op.
    await db()
      .insert(schema.memberships)
      .values({
        id: uuidv7(),
        userId: leaver.userId,
        class: "viewer",
        basis: "subscription",
        joinedAt: new Date(Date.now() - 60_000),
        lastEligibilityCheckAt: new Date(),
      });
    const r = await buy(leaver);
    expect(r.status).toBe(200);
    const left = await leaver.client.call("POST", "/api/coop/membership/viewer/exit");
    expect(left.status).toBe(200);
    const p = await paymentOf(r.body.paymentId);
    const done = await deliver(completed(p.id, `pi_${rand()}`, p.amountCents));
    expect(done.body.outcome).toBe("share_refund_pending");
    const s = await shareOf(p.id);
    expect(s.status).toBe("refund_pending");
    const active = await db()
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, leaver.userId), eq(schema.memberships.status, "active")));
    expect(active).toHaveLength(0);
    expect(await memberShareOwed(leaver.userId)).toBe(p.amountCents);
    await expectLedgerBalanced();
  });

  test("a failed checkout releases the share; buying again starts afresh", async () => {
    const someone = await signUpAndSignIn(api);
    const r = await buy(someone);
    const p = await paymentOf(r.body.paymentId);
    const out = await api.db.app.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(schema.payments).where(eq(schema.payments.id, p.id)).for("update");
      if (!locked) throw new Error("no payment");
      return shareCheckoutFailed(tx, locked, new Date());
    });
    expect(out.outcome).toBe("checkout_failed");
    expect((await shareOf(p.id)).status).toBe("cancelled");
    expect((await paymentOf(p.id)).status).toBe("failed");
    // A share whose payment failed without anything releasing it (the dispatch is a contract
    // request until it lands) is released by the next purchase.
    const again = await buy(someone);
    expect(again.status).toBe(200);
    expect(again.body.paymentId).not.toBe(p.id);
    await db().update(schema.payments).set({ status: "failed" }).where(eq(schema.payments.id, again.body.paymentId));
    const third = await buy(someone);
    expect(third.status).toBe(200);
    expect((await shareOf(again.body.paymentId)).status).toBe("cancelled");
    expect((await shareOf(third.body.paymentId)).status).toBe("pending");
  });

  test("leaving never refunds by itself: the share waits refund_pending for the treasurer", async () => {
    const left = await viewer.client.call("POST", "/api/coop/membership/viewer/exit");
    expect(left.status).toBe(200);
    const s = await shareOf(purchase.paymentId);
    expect(s.status).toBe("refund_pending");
    expect(stripeCalls.filter((c) => c.path === "/v1/refunds")).toHaveLength(0);
  });

  let refundRef = "";
  test("the treasurer's refund asks Stripe through the shared guard; a second request is refused", async () => {
    const r = await treasurer.client.call<{ status: string }>("POST", `/api/coop/shares/${purchase.shareId}/refund`, {
      sentAt: new Date().toISOString(),
      note: "bylaws exit",
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("refund_pending");
    const calls = stripeCalls.filter((c) => c.path === "/v1/refunds");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.get("payment_intent")).toBe(purchase.pi);
    const p = await paymentOf(purchase.paymentId);
    expect(calls[0]?.body.get("amount")).toBe(String(p.amountCents));
    const again = await treasurer.client.call("POST", `/api/coop/shares/${purchase.shareId}/refund`, {
      sentAt: new Date().toISOString(),
    });
    expect(again.status).toBe(409);
    expect(stripeCalls.filter((c) => c.path === "/v1/refunds")).toHaveLength(1);
    const marks = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, p.id), eq(schema.auditLog.action, "payment.refund_submitted")));
    expect(marks).toHaveLength(1);
    const details = (marks[0]?.details ?? {}) as Record<string, unknown>;
    refundRef = String(details.refundRef);
    // Nothing is posted until Stripe says the money went back.
    expect(await memberShareOwed(viewer.userId)).toBe(p.amountCents);
    // A member cannot refund their own share.
    expect(
      (
        await viewer.client.call("POST", `/api/coop/shares/${purchase.shareId}/refund`, {
          sentAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(403);
  });

  const refunded = (amount: number, total: number): Extract<StripeAction, { type: "charge.refunded" }> => ({
    type: "charge.refunded",
    chargeId: `ch_${rand()}`,
    paymentIntent: purchase.pi,
    paymentId: purchase.paymentId,
    amountRefunded: total,
    currency: "usd",
    refunds: [{ id: refundRef, amountCents: amount }],
  });
  const applyRefund = (a: Extract<StripeAction, { type: "charge.refunded" }>) =>
    api.db.app.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, purchase.paymentId))
        .for("update");
      if (!locked) throw new Error("no payment");
      return shareChargeRefundedAction(tx, locked, a, new Date());
    });

  test("charge.refunded posts shareRefund, settles the request and refunds the share", async () => {
    const p = await paymentOf(purchase.paymentId);
    const out = await applyRefund(refunded(p.amountCents, p.amountCents));
    expect(out.outcome).toBe("share_refunded");
    const s = await shareOf(p.id);
    expect(s.status).toBe("refunded");
    expect(s.refundedAt).not.toBeNull();
    expect(await paymentOf(p.id)).toMatchObject({ status: "refunded", refundedCents: p.amountCents });
    expect(await memberShareOwed(viewer.userId)).toBe(0);
    const [posting] = await db()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `share-refund:${s.id}`));
    expect(posting?.kind).toBe("share_refund");
    // The request no longer blocks: the refund is recorded by its id.
    const [d] = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, p.id));
    expect(d).toMatchObject({ kind: "refund", providerRef: refundRef, amountCents: p.amountCents });
    await expectLedgerBalanced();
  });

  test("a redelivered charge.refunded changes nothing", async () => {
    const p = await paymentOf(purchase.paymentId);
    const out = await applyRefund(refunded(p.amountCents, p.amountCents));
    expect(out.outcome).toBe("no_new_refund");
    expect(await memberShareOwed(viewer.userId)).toBe(0);
  });

  test("a partial or unexpected refund books nothing and is recorded once for the treasurer", async () => {
    // The leaver's share is refund_pending; a dashboard refund of part of it.
    const [s] = await db()
      .select()
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.userId, leaver.userId));
    if (!s?.paymentId) throw new Error("no leaver share");
    const p = await paymentOf(s.paymentId);
    const a: Extract<StripeAction, { type: "charge.refunded" }> = {
      type: "charge.refunded",
      chargeId: `ch_${rand()}`,
      paymentIntent: p.providerRef,
      paymentId: p.id,
      amountRefunded: 100,
      currency: "usd",
      refunds: [{ id: `re_${rand()}`, amountCents: 100 }],
    };
    const run = () =>
      api.db.app.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(schema.payments).where(eq(schema.payments.id, p.id)).for("update");
        if (!locked) throw new Error("no payment");
        return shareChargeRefundedAction(tx, locked, a, new Date());
      });
    expect((await run()).outcome).toBe("share_refund_unmatched");
    expect((await run()).outcome).toBe("no_new_refund");
    const marks = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, p.id), eq(schema.auditLog.action, "coop.share.refund_unmatched")));
    expect(marks).toHaveLength(1);
    expect((await shareOf(p.id)).status).toBe("refund_pending");
    expect(await memberShareOwed(leaver.userId)).toBe(p.amountCents);
    await expectLedgerBalanced();
  });
});
