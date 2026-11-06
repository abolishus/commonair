// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Card share chargebacks (follow-ups, unit money; ADR 0020, ADR 0007), through signed webhooks:
 * a dispute claws the share capital back when it opens (`share_chargeback`), freezing the share;
 * lost ends the share and the membership resting on it; won restores the money
 * (`share_chargeback_reversal`). Redeliveries change nothing, and the ledger balances throughout.
 *
 * Stripe is a local `Bun.serve` fake for the processor fee lookup; the share Checkout Session comes
 * from an injected adapter, as in `coop-shares.int.test.ts`.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { accounts, rawBalance } from "@commonair/ledger";
import { type PaymentAdapter, createAdapter, loadStripeSignature } from "@commonair/payments";
import { setShareAdapter } from "../src/coop/shares.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Checkout = { kind: "redirect"; url: string; paymentId: string };

const SECRET = "whsec_int_share_disputes";
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 14);
const nowS = () => Math.floor(Date.now() / 1000);

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

describe("card share chargebacks", () => {
  let api: TestApi;
  let fake: ReturnType<typeof Bun.serve>;

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
    return { status: res.status, body: (await res.json()) as { outcome?: string } };
  }
  const dispute = (type: string, o: { id: string; pi: string; amount: number; status: string; fees?: number[] }) =>
    event(type, {
      id: o.id,
      object: "dispute",
      charge: `ch_${rand()}`,
      payment_intent: o.pi,
      amount: o.amount,
      currency: "usd",
      status: o.status,
      balance_transactions: (o.fees ?? []).map((fee) => ({ fee })),
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
  const viewerMembership = async (userId: string) =>
    db()
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.class, "viewer")));
  const owed = async (userId: string) => 0 - (await rawBalance(db(), accounts.memberShare(userId), "usd"));
  const postings = async (shareId: string) =>
    (
      await db()
        .select({ kind: schema.ledgerTransactions.kind })
        .from(schema.ledgerTransactions)
        .where(
          and(eq(schema.ledgerTransactions.refType, "membership_share"), eq(schema.ledgerTransactions.refId, shareId)),
        )
    )
      .map((r) => r.kind)
      .sort();
  const audits = async (action: string, subjectId: string) =>
    db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));
  async function expectLedgerBalanced() {
    const off = await db().execute<{ transaction_id: string }>(sql`
      select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
    expect([...off]).toEqual([]);
  }

  /** A viewer who bought a share by card: booked, membership active. */
  async function cardMember(): Promise<{
    who: Account;
    paymentId: string;
    shareId: string;
    pi: string;
    amount: number;
  }> {
    const who = await signUpAndSignIn(api);
    const r = await who.client.call<Checkout>("POST", "/api/coop/shares", { returnPath: "/coop/membership" });
    expect(r.status).toBe(200);
    const p = await paymentOf(r.body.paymentId);
    const pi = `pi_${rand()}`;
    const done = await deliver(
      event("checkout.session.completed", {
        id: `cs_test_${rand()}`,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        status: "complete",
        client_reference_id: p.id,
        metadata: { payment_id: p.id },
        payment_intent: pi,
        subscription: null,
        amount_total: p.amountCents,
        currency: "usd",
        total_details: { amount_tax: 0 },
      }),
    );
    expect(done.body.outcome).toBe("share_confirmed");
    return { who, paymentId: p.id, shareId: (await shareOf(p.id)).id, pi, amount: p.amountCents };
  }

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/v1/payment_intents/"))
          return Response.json({ latest_charge: { balance_transaction: { fee: 59, currency: "usd" } } });
        return Response.json({ error: { message: "not faked" } }, { status: 404 });
      },
    });
    api = await startApi({ governance: { "shares.cardPayments": { enabled: true } } });
    Object.assign(api.deps.env, {
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_int",
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${fake.port}`,
    });
    const base = createAdapter(api.deps.env);
    const adapter: PaymentAdapter = {
      ...base,
      provider: "stripe",
      async startCheckout(r) {
        return {
          kind: "redirect",
          url: `https://checkout.stripe.test/c/pay/cs_${r.paymentId}`,
          providerRef: `CA-${rand().slice(0, 6).toUpperCase()}`,
        };
      },
    };
    setShareAdapter(api.deps, adapter);
  }, 180_000);
  afterAll(async () => {
    await api?.stop();
    await fake?.stop(true);
  });

  test("an inquiry claws nothing back", async () => {
    const m = await cardMember();
    const r = await deliver(
      dispute("charge.dispute.created", {
        id: `dp_${rand()}`,
        pi: m.pi,
        amount: m.amount,
        status: "warning_needs_response",
      }),
    );
    expect(r.body.outcome).toBe("inquiry");
    expect(await postings(m.shareId)).toEqual(["share_purchase"]);
    expect(await owed(m.who.userId)).toBe(m.amount);
  });

  test("an open dispute claws the share back and freezes it; lost ends the share and the membership", async () => {
    const m = await cardMember();
    const id = `dp_${rand()}`;
    const opened = await deliver(
      dispute("charge.dispute.created", { id, pi: m.pi, amount: m.amount, status: "needs_response", fees: [1500] }),
    );
    expect(opened.status).toBe(200);
    expect(opened.body.outcome).toBe("share_charged_back");
    expect(await postings(m.shareId)).toEqual(["share_chargeback", "share_purchase"]);
    expect(await owed(m.who.userId)).toBe(0);
    expect(await paymentOf(m.paymentId)).toMatchObject({ status: "charged_back", refundedCents: m.amount });
    // Frozen, not ended: the share and membership wait for the outcome.
    expect((await shareOf(m.paymentId)).status).toBe("held");
    expect((await viewerMembership(m.who.userId))[0]?.status).toBe("active");
    expect(await audits("coop.share.dispute", m.shareId)).toHaveLength(1);
    const [d] = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, m.paymentId));
    expect(d).toMatchObject({ kind: "chargeback", status: "open", providerRef: id, amountCents: m.amount });
    // Redelivered: nothing new.
    const again = await deliver(
      dispute("charge.dispute.created", { id, pi: m.pi, amount: m.amount, status: "needs_response", fees: [1500] }),
    );
    expect(again.body.outcome ?? "already_processed").toBe("already_processed");
    expect(await postings(m.shareId)).toEqual(["share_chargeback", "share_purchase"]);
    // A refund of a charged-back share books nothing (and the database would refuse it).
    const refunded = await deliver(
      event("charge.refunded", {
        id: `ch_${rand()}`,
        object: "charge",
        payment_intent: m.pi,
        amount_refunded: m.amount,
        currency: "usd",
        refunds: { data: [{ id: `re_${rand()}`, amount: m.amount, status: "succeeded" }] },
      }),
    );
    expect(refunded.body.outcome).toBe("share_refund_unmatched");

    const lost = await deliver(dispute("charge.dispute.closed", { id, pi: m.pi, amount: m.amount, status: "lost" }));
    expect(lost.body.outcome).toBe("share_dispute_lost");
    expect((await shareOf(m.paymentId)).status).toBe("cancelled");
    const [membership] = await viewerMembership(m.who.userId);
    expect(membership).toMatchObject({ status: "exited", basis: "share" });
    expect(await audits("coop.share.dispute_lost", m.shareId)).toHaveLength(1);
    expect(await audits("membership.exit", membership?.id ?? "")).toHaveLength(1);
    const events = await db().select().from(schema.events).where(eq(schema.events.type, "coop.membership.update"));
    expect(events.some((e) => (e.payload as Record<string, unknown>).membership_id === membership?.id)).toBe(true);
    expect(
      (await deliver(dispute("charge.dispute.closed", { id, pi: m.pi, amount: m.amount, status: "lost" }))).body
        .outcome ?? "already_processed",
    ).toBe("already_processed");
    // The share no longer counts as open: the member may buy one again.
    const rebuy = await m.who.client.call<Checkout>("POST", "/api/coop/shares", { returnPath: "/coop/membership" });
    expect(rebuy.status).toBe(200);
    expect(rebuy.body.paymentId).not.toBe(m.paymentId);
    await expectLedgerBalanced();
  });

  test("won: the money and the member's share capital come back; nothing else moved", async () => {
    const m = await cardMember();
    const id = `dp_${rand()}`;
    await deliver(
      dispute("charge.dispute.created", { id, pi: m.pi, amount: m.amount, status: "needs_response", fees: [1500] }),
    );
    const fees = async () => rawBalance(db(), accounts.paymentFees(), "usd");
    const feesBefore = await fees();
    const won = await deliver(
      dispute("charge.dispute.closed", { id, pi: m.pi, amount: m.amount, status: "won", fees: [1500, -1500] }),
    );
    expect(won.body.outcome).toBe("share_dispute_won");
    expect(await postings(m.shareId)).toEqual(["share_chargeback", "share_chargeback_reversal", "share_purchase"]);
    expect(await owed(m.who.userId)).toBe(m.amount);
    expect(await fees()).toBe(feesBefore - 1500);
    expect(await paymentOf(m.paymentId)).toMatchObject({ status: "succeeded", refundedCents: 0 });
    expect((await shareOf(m.paymentId)).status).toBe("held");
    expect((await viewerMembership(m.who.userId))[0]?.status).toBe("active");
    expect(await audits("coop.share.dispute_won", m.shareId)).toHaveLength(1);
    const twice = await deliver(dispute("charge.dispute.closed", { id, pi: m.pi, amount: m.amount, status: "won" }));
    expect(twice.body.outcome ?? "already_processed").toBe("already_processed");
    await expectLedgerBalanced();
  });

  test("a dispute first seen lost is clawed back and ended at once; its late created event changes nothing", async () => {
    const m = await cardMember();
    const id = `dp_${rand()}`;
    const lost = await deliver(dispute("charge.dispute.closed", { id, pi: m.pi, amount: m.amount, status: "lost" }));
    expect(lost.body.outcome).toBe("share_charged_back_lost");
    expect((await shareOf(m.paymentId)).status).toBe("cancelled");
    expect(await owed(m.who.userId)).toBe(0);
    const late = await deliver(
      dispute("charge.dispute.created", { id, pi: m.pi, amount: m.amount, status: "needs_response" }),
    );
    expect(late.body.outcome ?? "already_processed").toBe("already_processed");
    expect(await postings(m.shareId)).toEqual(["share_chargeback", "share_purchase"]);
    await expectLedgerBalanced();
  });

  test("a dispute first seen won never claws back", async () => {
    const m = await cardMember();
    const id = `dp_${rand()}`;
    const won = await deliver(dispute("charge.dispute.closed", { id, pi: m.pi, amount: m.amount, status: "won" }));
    expect(won.body.outcome).toBe("won_without_clawback");
    const late = await deliver(
      dispute("charge.dispute.created", { id, pi: m.pi, amount: m.amount, status: "needs_response" }),
    );
    expect(late.body.outcome ?? "already_processed").toBe("already_processed");
    expect(await postings(m.shareId)).toEqual(["share_purchase"]);
    expect(await owed(m.who.userId)).toBe(m.amount);
  });

  test("a member who left keeps the refund owed until the dispute is decided; lost cancels it", async () => {
    const m = await cardMember();
    const left = await m.who.client.call("POST", "/api/coop/membership/viewer/exit");
    expect(left.status).toBe(200);
    expect((await shareOf(m.paymentId)).status).toBe("refund_pending");
    const id = `dp_${rand()}`;
    await deliver(dispute("charge.dispute.created", { id, pi: m.pi, amount: m.amount, status: "needs_response" }));
    expect((await shareOf(m.paymentId)).status).toBe("refund_pending");
    expect(await owed(m.who.userId)).toBe(0);
    await deliver(dispute("charge.dispute.closed", { id, pi: m.pi, amount: m.amount, status: "lost" }));
    // Nothing is owed back: Stripe already returned the money to the payer.
    expect((await shareOf(m.paymentId)).status).toBe("cancelled");
    await expectLedgerBalanced();
  });
});
