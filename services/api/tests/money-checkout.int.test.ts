// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checkout end to end over REST: tiers, self and gift subscriptions, tips, the treasurer's
 * confirm / refund / chargeback and payout accounts, against a real database and ledger.
 * The tests share state and run in order.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { MANUAL_REFERENCE_PATTERN, minorUnits } from "@commonair/contracts/currency";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { creatorBalances, loadMoneySettings, postPayout, releaseDueHolds, runPayoutBatch } from "@commonair/ledger";
import { addOneMonthUtc } from "../src/money/checkout-rules.ts";
import { violatesConstraint } from "../src/money/checkout-shared.ts";
import { signUpAndSignIn, startApi, subscriber, uniqueName, waitFor, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Instructions {
  kind: "instructions";
  paymentId: string;
  reference: string;
  instructions: string;
  amount: { cents: number; currency: string };
}
interface Sub {
  id: string;
  channelSlug: string;
  subscriber: { id: string; username: string };
  tier: number;
  status: string;
  gifted: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
}
interface TPayment {
  paymentId: string;
  reference: string;
  status: string;
  kind: string;
  amount: { cents: number };
  refunded: { cents: number };
  user: { username: string } | null;
  channelSlug: string | null;
}
type Page<T> = { items: T[]; nextCursor: string | null };

let api: TestApi;
let streamer: Account; // channel S: self subs, tips, refunds, chargebacks, payouts
let gifts: Account; // channel G: gift subs
let treasurer: Account;
let alice: Account; // the paying viewer
let bob: Account; // a viewer who is not a treasurer

const db = () => api.db.db;
const DAY = 86_400_000;
const TIERS = [
  { tier: 1, name: "Fan", price: { cents: 499, currency: "usd" }, benefits: "Badge" },
  { tier: 2, name: "Super fan", price: { cents: 999, currency: "usd" }, benefits: "Badge and emotes" },
  { tier: 3, name: "Patron", price: { cents: 2499, currency: "usd" }, benefits: "Everything" },
];

beforeAll(async () => {
  api = await startApi();
  [streamer, gifts, treasurer, alice, bob] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const channelOf = async (slug: string) => {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
};
const eventsOf = async (channelId: string, type: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)))
    .orderBy(schema.events.id);
const paymentRow = async (id: string) => {
  const [p] = await db().select().from(schema.payments).where(eq(schema.payments.id, id));
  if (!p) throw new Error(`no payment ${id}`);
  return p;
};
const ledgerTxFor = (paymentId: string) =>
  db()
    .select()
    .from(schema.ledgerTransactions)
    .where(and(eq(schema.ledgerTransactions.refType, "payment"), eq(schema.ledgerTransactions.refId, paymentId)));
const confirm = (paymentId: string, as: Account = treasurer, receivedAt = new Date()) =>
  as.client.call("POST", `/api/treasurer/payments/${paymentId}/confirm`, { receivedAt: receivedAt.toISOString() });
const subscribe = (as: Account, channel: string, body: Record<string, unknown>) =>
  as.client.call<Instructions & { message?: string }>("POST", `/api/channels/${channel}/subscriptions`, {
    returnPath: `/${channel}`,
    ...body,
  });
const tip = (as: Account, channel: string, body: Record<string, unknown>) =>
  as.client.call<Instructions>("POST", `/api/channels/${channel}/tips`, { returnPath: `/${channel}`, ...body });

/** The creator's share of a gross amount under the seeded cut, in integer millionths (no float rounding). */
async function creatorShare(grossCents: number): Promise<number> {
  const { cut } = await loadMoneySettings(db());
  const millionths = BigInt(Math.round(cut.streamerShare * 1_000_000));
  return Number((BigInt(grossCents) * millionths) / 1_000_000n);
}

async function expectLedgerBalanced() {
  const off = await db().execute<{ transaction_id: string }>(sql`
    select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
  expect([...off]).toEqual([]);
}

/** A user row with no session (gift recipients never need to sign in here). */
async function plainUser(extra: Partial<typeof schema.users.$inferInsert> = {}) {
  const username = uniqueName("p");
  const [u] = await db()
    .insert(schema.users)
    .values({ name: username, username, email: `${username}@test.invalid`, emailVerified: true, ...extra })
    .returning();
  if (!u) throw new Error("insert user failed");
  return u;
}

let selfPayment: Instructions; // alice's tier-2 subscription on S
let tipPayment: Instructions; // alice's anonymous tip on S

describe("tiers and support info", () => {
  test("without tiers the channel takes tips but no subscriptions", async () => {
    const info = await alice.client.call<{
      tiers: unknown[];
      provider: string;
      feeEstimate: unknown;
      viewer: { isOwner: boolean };
    }>("GET", `/api/channels/${streamer.username}/support`);
    expect(info.status).toBe(200);
    expect(info.body.tiers).toEqual([]);
    expect(info.body.provider).toBe("manual");
    // The manual adapter charges no processor fee, so the dialog shows no estimate (W1 §3.2).
    expect(info.body.feeEstimate).toBeNull();
    expect(info.body.viewer).toEqual({ subscription: null, isOwner: false });
    const sub = await subscribe(alice, streamer.username, { tier: 1 });
    expect(sub.status).toBe(412);
  });

  test("setTiers validates and only the owner may call it", async () => {
    const path = `/api/channels/${streamer.username}/subscription-tiers`;
    const flat = TIERS.map((t) => ({ ...t, price: { ...t.price, cents: 999 } }));
    expect((await streamer.client.call("PUT", path, { tiers: flat })).status).toBe(400);
    const eur = TIERS.map((t) => ({ ...t, price: { ...t.price, currency: "eur" } }));
    expect((await streamer.client.call("PUT", path, { tiers: eur })).status).toBe(400);
    const dup = [TIERS[0], TIERS[0], TIERS[2]];
    expect((await streamer.client.call("PUT", path, { tiers: dup })).status).toBe(400);
    expect((await alice.client.call("PUT", path, { tiers: TIERS })).status).toBe(403);

    const set = await streamer.client.call<{ tier: number; price: { cents: number } }[]>("PUT", path, { tiers: TIERS });
    expect(set.status).toBe(200);
    expect(set.body.map((t) => [t.tier, t.price.cents])).toEqual([
      [1, 499],
      [2, 999],
      [3, 2499],
    ]);
    const g = await gifts.client.call("PUT", `/api/channels/${gifts.username}/subscription-tiers`, { tiers: TIERS });
    expect(g.status).toBe(200);

    const pub = await bob.client.call<{ tier: number }[]>("GET", path);
    expect(pub.body).toHaveLength(3);
    const info = await streamer.client.call<{ split: { streamerShare: number }; viewer: { isOwner: boolean } }>(
      "GET",
      `/api/channels/${streamer.username}/support`,
    );
    expect(info.body.split.streamerShare).toBe((await loadMoneySettings(db())).cut.streamerShare);
    expect(info.body.viewer.isOwner).toBe(true);
  });

  test("an editor manages the channel but cannot set its prices", async () => {
    const c = await channelOf(streamer.username);
    await db()
      .insert(schema.channelRoles)
      .values({ channelId: c.id, userId: bob.userId, role: "editor", grantedBy: streamer.userId });
    try {
      const path = `/api/channels/${streamer.username}/subscription-tiers`;
      const cheap = TIERS.map((t) => ({ ...t, price: { ...t.price, cents: t.price.cents - 100 } }));
      expect((await bob.client.call("PUT", path, { tiers: cheap })).status).toBe(403);
      const tiers = await bob.client.call<{ price: { cents: number } }[]>("GET", path);
      expect(tiers.body.map((t) => t.price.cents)).toEqual([499, 999, 2499]);
    } finally {
      await db()
        .delete(schema.channelRoles)
        .where(and(eq(schema.channelRoles.channelId, c.id), eq(schema.channelRoles.userId, bob.userId)));
    }
  });

  test("the owner cannot subscribe to or tip their own channel", async () => {
    expect((await subscribe(streamer, streamer.username, { tier: 1 })).status).toBe(403);
    expect((await tip(streamer, streamer.username, { amountCents: 500 })).status).toBe(403);
  });
});

describe("self subscription", () => {
  test("checkout returns instructions and posts nothing", async () => {
    const r = await subscribe(alice, streamer.username, { tier: 2, returnPath: `/${streamer.username}` });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("instructions");
    expect(r.body.reference).toMatch(MANUAL_REFERENCE_PATTERN);
    expect(r.body.instructions).toContain(r.body.reference);
    expect(r.body.instructions).toContain("9.99 USD");
    expect(r.body.amount).toEqual({ cents: 999, currency: "usd" });
    selfPayment = r.body;

    const p = await paymentRow(r.body.paymentId);
    expect(p).toMatchObject({ status: "pending", kind: "subscription", tier: 2, quantity: 1, amountCents: 999 });
    expect(p.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(await ledgerTxFor(p.id)).toHaveLength(0);
    const [s] = await db()
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.id, p.subscriptionId ?? ""));
    expect(s).toMatchObject({ status: "incomplete", tier: 2, priceCents: 999, subscriberId: alice.userId });
  });

  test("subscribing again while incomplete returns the same pending checkout", async () => {
    const again = await subscribe(alice, streamer.username, { tier: 2 });
    expect(again.status).toBe(200);
    expect(again.body.paymentId).toBe(selfPayment.paymentId);
    expect(again.body.reference).toBe(selfPayment.reference);
    expect(again.body.instructions).toBe(selfPayment.instructions);
    const info = await alice.client.call<{ viewer: { subscription: Sub } }>(
      "GET",
      `/api/channels/${streamer.username}/support`,
    );
    expect(info.body.viewer.subscription).toMatchObject({ status: "incomplete", tier: 2, gifted: false });
  });

  test("only a treasurer can confirm", async () => {
    expect((await confirm(selfPayment.paymentId, bob)).status).toBe(403);
    expect((await confirm(selfPayment.paymentId, alice)).status).toBe(403);
    const future = new Date(Date.now() + 3_600_000);
    expect((await confirm(selfPayment.paymentId, treasurer, future)).status).toBe(400);
    // Backdating before the checkout existed would skip the creator hold.
    const created = (await paymentRow(selfPayment.paymentId)).createdAt;
    expect((await confirm(selfPayment.paymentId, treasurer, new Date(created.getTime() - DAY))).status).toBe(400);
    expect((await paymentRow(selfPayment.paymentId)).status).toBe("pending");
    expect(await ledgerTxFor(selfPayment.paymentId)).toHaveLength(0);
  });

  test("confirm activates the subscription, posts the split, writes events, audit and a chat invalidate", async () => {
    const c = await channelOf(streamer.username);
    const sub = subscriber();
    const frames: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.chatControl(c.id));
    sub.on("message", (_ch, msg) => frames.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      const receivedAt = new Date(Date.now() - 1_000);
      const r = await confirm(selfPayment.paymentId, treasurer, receivedAt);
      expect(r.status).toBe(200);

      const p = await paymentRow(selfPayment.paymentId);
      expect(p.status).toBe("succeeded");
      expect(p.succeededAt?.toISOString()).toBe(receivedAt.toISOString());
      const [s] = await db()
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.id, p.subscriptionId ?? ""));
      expect(s?.status).toBe("active");
      expect(s?.currentPeriodStart?.toISOString()).toBe(receivedAt.toISOString());
      expect(s?.currentPeriodEnd?.toISOString()).toBe(addOneMonthUtc(receivedAt).toISOString());

      const txs = await ledgerTxFor(p.id);
      expect(txs).toHaveLength(1);
      const b = await creatorBalances(db(), streamer.userId, "usd");
      expect(b.holdCents).toBe(await creatorShare(999));
      expect(b.liabilityCents).toBe(0);
      await expectLedgerBalanced();

      const evs = await eventsOf(c.id, "channel.subscribe");
      expect(evs).toHaveLength(1);
      expect(evs[0]?.payload).toMatchObject({
        broadcaster_user_login: streamer.username,
        user_login: alice.username,
        tier: "2000",
        is_gift: false,
      });
      const [a] = await db()
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "payment.confirm"), eq(schema.auditLog.subjectId, p.id)));
      expect(a).toMatchObject({ actorId: treasurer.userId, subjectType: "payment", channelId: c.id });

      await waitFor(async () => frames.find((f) => f.op === "invalidate" && f.userId === alice.userId));
    } finally {
      sub.disconnect();
    }
  });

  test("a second confirm is a conflict and posts nothing more", async () => {
    expect((await confirm(selfPayment.paymentId)).status).toBe(409);
    expect(await ledgerTxFor(selfPayment.paymentId)).toHaveLength(1);
  });

  test("subscribing while active is a conflict", async () => {
    expect((await subscribe(alice, streamer.username, { tier: 1 })).status).toBe(409);
  });
});

describe("tips", () => {
  test("an anonymous tip hides the tipper from the channel but keeps them for refunds", async () => {
    const r = await tip(alice, streamer.username, { amountCents: 500, message: "  great stream  ", anonymous: true });
    expect(r.status).toBe(200);
    expect(r.body.amount.cents).toBe(500);
    tipPayment = r.body;
    const p = await paymentRow(r.body.paymentId);
    expect(p.kind).toBe("tip");
    const [t] = await db()
      .select()
      .from(schema.tips)
      .where(eq(schema.tips.id, p.tipId ?? ""));
    expect(t).toMatchObject({ fromUserId: alice.userId, anonymous: true, message: "great stream", status: "pending" });
    expect(t?.paymentId).toBe(p.id);
  });

  test("concurrent confirms apply exactly once", async () => {
    const results = await Promise.all([confirm(tipPayment.paymentId), confirm(tipPayment.paymentId)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await ledgerTxFor(tipPayment.paymentId)).toHaveLength(1);
    const c = await channelOf(streamer.username);
    const evs = await eventsOf(c.id, "channel.tip");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.payload).toMatchObject({
      user_id: null,
      user_login: null,
      user_name: null,
      is_anonymous: true,
      amount: { value: 500, decimal_places: minorUnits("usd"), currency: "usd" },
      message: "great stream",
    });
    expect(JSON.stringify(evs[0]?.payload)).not.toContain(alice.userId);
  });

  test("the owner's tip list hides anonymous tippers", async () => {
    const list = await streamer.client.call<
      Page<{ id: string; from: unknown; status: string; amount: { cents: number } }>
    >("GET", `/api/channels/${streamer.username}/tips`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ from: null, status: "succeeded", amount: { cents: 500 } });
    expect((await alice.client.call("GET", `/api/channels/${streamer.username}/tips`)).status).toBe(403);
  });

  test("a named tip shows the tipper", async () => {
    const r = await tip(bob, streamer.username, { amountCents: 300 });
    expect((await confirm(r.body.paymentId)).status).toBe(200);
    const list = await streamer.client.call<Page<{ from: { username: string } | null }>>(
      "GET",
      `/api/channels/${streamer.username}/tips?limit=1`,
    );
    expect(list.body.items[0]?.from?.username).toBe(bob.username);
    expect(list.body.nextCursor).not.toBeNull();
    const next = await streamer.client.call<Page<{ from: unknown }>>(
      "GET",
      `/api/channels/${streamer.username}/tips?limit=1&cursor=${list.body.nextCursor}`,
    );
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0]?.from).toBeNull();
    expect(next.body.nextCursor).toBeNull();
  });
});

describe("treasurer.payments", () => {
  test("finds a payment by reference in any status, as typed", async () => {
    const typed = tipPayment.reference.replace("CA-", "ca ").toLowerCase();
    const r = await treasurer.client.call<Page<TPayment>>(
      "GET",
      `/api/treasurer/payments?reference=${encodeURIComponent(typed)}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({
      paymentId: tipPayment.paymentId,
      reference: tipPayment.reference,
      status: "succeeded",
      kind: "tip",
      channelSlug: streamer.username,
      user: { username: alice.username },
    });
    expect((await bob.client.call("GET", "/api/treasurer/payments")).status).toBe(403);
  });

  test("lists by status newest first with paging", async () => {
    const a = await tip(bob, gifts.username, { amountCents: 100 });
    const b = await tip(bob, gifts.username, { amountCents: 200 });
    const first = await treasurer.client.call<Page<TPayment>>("GET", "/api/treasurer/payments?status=pending&limit=1");
    expect(first.body.items[0]?.paymentId).toBe(b.body.paymentId);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await treasurer.client.call<Page<TPayment>>(
      "GET",
      `/api/treasurer/payments?status=pending&limit=1&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items[0]?.paymentId).toBe(a.body.paymentId);
    const succeeded = await treasurer.client.call<Page<TPayment>>("GET", "/api/treasurer/payments?status=succeeded");
    expect(succeeded.body.items.map((p) => p.paymentId)).toContain(selfPayment.paymentId);
    expect(succeeded.body.items.every((p) => p.status === "succeeded")).toBe(true);
  });
});

describe("refunds", () => {
  test("partial then the rest: exact sums, and a full refund cancels the subscription", async () => {
    const c = await channelOf(streamer.username);
    const before = await creatorBalances(db(), streamer.userId, "usd");
    const path = `/api/treasurer/payments/${selfPayment.paymentId}/refund`;
    expect((await bob.client.call("POST", path, { amountCents: 1, reason: "x" })).status).toBe(403);

    expect((await treasurer.client.call("POST", path, { amountCents: 333, reason: "Asked nicely" })).status).toBe(200);
    let p = await paymentRow(selfPayment.paymentId);
    expect(p).toMatchObject({ status: "partially_refunded", refundedCents: 333 });
    expect((await treasurer.client.call("POST", path, { amountCents: 667, reason: "too much" })).status).toBe(400);

    expect((await treasurer.client.call("POST", path, { amountCents: 666, reason: "The rest" })).status).toBe(200);
    p = await paymentRow(selfPayment.paymentId);
    expect(p).toMatchObject({ status: "refunded", refundedCents: 999 });
    expect((await treasurer.client.call("POST", path, { amountCents: 1, reason: "again" })).status).toBe(409);

    const after = await creatorBalances(db(), streamer.userId, "usd");
    expect(before.holdCents - after.holdCents).toBe(await creatorShare(999));
    const reversals = (await ledgerTxFor(selfPayment.paymentId)).filter((t) => t.kind === "refund");
    expect(reversals).toHaveLength(2);
    const sum = reversals.reduce(
      (s, t) => s + Number((t.metadata as { revenueGrossCents: number }).revenueGrossCents),
      0,
    );
    expect(sum).toBe(-999);
    await expectLedgerBalanced();

    const [s] = await db()
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.id, p.subscriptionId ?? ""));
    expect(s?.status).toBe("canceled");
    const ends = await eventsOf(c.id, "channel.subscription.end");
    expect(ends.map((e) => (e.payload as { user_login: string }).user_login)).toEqual([alice.username]);

    const ds = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, p.id));
    expect(ds.map((d) => [d.kind, d.status, d.amountCents]).sort((a, b) => Number(a[2]) - Number(b[2]))).toEqual([
      ["refund", "closed", 333],
      ["refund", "closed", 666],
    ]);
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "payment.refund"), eq(schema.auditLog.subjectId, p.id)));
    expect(audits.map((a) => a.reason).sort()).toEqual(["Asked nicely", "The rest"]);
  });

  test("a pending payment cannot be refunded", async () => {
    const pending = await tip(alice, streamer.username, { amountCents: 100 });
    const r = await treasurer.client.call("POST", `/api/treasurer/payments/${pending.body.paymentId}/refund`, {
      amountCents: 100,
      reason: "",
    });
    expect(r.status).toBe(409);
  });
});

describe("payout accounts and chargebacks", () => {
  test("setPayoutAccount re-pends held payouts; a chargeback after payout leaves a receivable", async () => {
    // Release every hold, then run a batch with no payout account: the creator's payout is held.
    await releaseDueHolds(db(), { asOf: new Date(), holdDays: 0, currency: "usd" });
    const mid = await creatorBalances(db(), streamer.userId, "usd");
    expect(mid.holdCents).toBe(0);
    expect(mid.liabilityCents).toBe((await creatorShare(500)) + (await creatorShare(300)));
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    await runPayoutBatch(db(), { periodStart, periodEnd: now, currency: "usd", minimumCents: 0 });
    const [held] = await db().select().from(schema.payouts).where(eq(schema.payouts.userId, streamer.userId));
    expect(held).toMatchObject({ status: "held", holdReason: "payout_account_not_ready" });

    const path = `/api/treasurer/payout-accounts/${streamer.username}`;
    expect((await bob.client.call("PUT", path, { payoutsEnabled: true, reference: "x" })).status).toBe(403);
    expect(
      (
        await treasurer.client.call("PUT", `/api/treasurer/payout-accounts/${uniqueName("nobody")}`, {
          payoutsEnabled: true,
          reference: "x",
        })
      ).status,
    ).toBe(404);
    const disabled = await treasurer.client.call("PUT", path, { payoutsEnabled: false, reference: "Bank transfer A" });
    expect(disabled.status).toBe(200);
    let [row] = await db()
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, held?.id ?? ""));
    expect(row?.status).toBe("held");
    expect((await treasurer.client.call("PUT", path, { payoutsEnabled: true, reference: "   " })).status).toBe(400);
    const enabled = await treasurer.client.call("PUT", path, { payoutsEnabled: true, reference: "Bank transfer A" });
    expect(enabled.status).toBe(200);
    [row] = await db()
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, held?.id ?? ""));
    expect(row).toMatchObject({ status: "pending", holdReason: null });
    const [acct] = await db()
      .select()
      .from(schema.payoutAccounts)
      .where(eq(schema.payoutAccounts.userId, streamer.userId));
    expect(acct).toMatchObject({ provider: "manual", providerAccountId: "Bank transfer A", payoutsEnabled: true });
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "payout_account.set"), eq(schema.auditLog.subjectId, streamer.userId)));
    expect(audits).toHaveLength(2);

    // The money leaves; then the anonymous tip is charged back: the creator now owes its share.
    await postPayout(db(), { payoutId: held?.id ?? "", paidAt: new Date() });
    const cb = `/api/treasurer/payments/${tipPayment.paymentId}/chargeback`;
    expect((await treasurer.client.call("POST", cb, { amountCents: 501, reason: "bank" })).status).toBe(400);
    expect((await treasurer.client.call("POST", cb, { amountCents: 500, reason: "Bank chargeback" })).status).toBe(200);
    const p = await paymentRow(tipPayment.paymentId);
    expect(p).toMatchObject({ status: "charged_back", refundedCents: 500 });
    const [t] = await db()
      .select()
      .from(schema.tips)
      .where(eq(schema.tips.id, p.tipId ?? ""));
    expect(t?.status).toBe("charged_back");
    const end = await creatorBalances(db(), streamer.userId, "usd");
    expect(end.receivableCents).toBe(await creatorShare(500));
    await expectLedgerBalanced();
    const [d] = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, p.id));
    expect(d).toMatchObject({ kind: "chargeback", status: "lost", reason: "Bank chargeback" });
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "payment.chargeback"), eq(schema.auditLog.subjectId, p.id)));
    expect(a?.reason).toBe("Bank chargeback");
    expect((await treasurer.client.call("POST", cb, { amountCents: 1, reason: "again" })).status).toBe(409);
  });

  test("a provider-managed payout account is not overwritten by hand", async () => {
    const u = await plainUser();
    await db()
      .insert(schema.payoutAccounts)
      .values({ userId: u.id, provider: "stripe", providerAccountId: "acct_test", payoutsEnabled: true });
    const path = `/api/treasurer/payout-accounts/${u.username}`;
    const r = await treasurer.client.call("PUT", path, { payoutsEnabled: true, reference: "Bank transfer B" });
    expect(r.status).toBe(409);
    const [acct] = await db().select().from(schema.payoutAccounts).where(eq(schema.payoutAccounts.userId, u.id));
    expect(acct).toMatchObject({ provider: "stripe", providerAccountId: "acct_test", payoutsEnabled: true });
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "payout_account.set"), eq(schema.auditLog.subjectId, u.id)));
    expect(audits).toHaveLength(0);
  });
});

describe("gift subscriptions", () => {
  let eligible: string[];
  let giftPaymentId: string;

  test("draws only eligible community members, and refuses a pool that is too small", async () => {
    const c = await channelOf(gifts.username);
    const now = Date.now();
    const chat = (userId: string, ageDays = 1) =>
      db()
        .insert(schema.chatMessages)
        .values({ channelId: c.id, userId, body: "hi", createdAt: new Date(now - ageDays * DAY) });
    const follow = (userId: string) => db().insert(schema.follows).values({ followerId: userId, channelId: c.id });

    const [p1, p2, p3, banned, subbed, suspended, bot, stale, excludedFollow] = await Promise.all([
      plainUser(),
      plainUser(),
      plainUser(),
      plainUser(),
      plainUser(),
      plainUser({ banned: true }),
      plainUser({ accountType: "bot" }),
      plainUser(),
      plainUser(),
    ]);
    if (!p1 || !p2 || !p3 || !banned || !subbed || !suspended || !bot || !stale || !excludedFollow)
      throw new Error("users");
    eligible = [p1.id, p2.id, p3.id];
    await chat(p1.id);
    await follow(p2.id);
    await chat(p3.id);
    await follow(p3.id);
    await follow(banned.id);
    await db().insert(schema.chatBans).values({ channelId: c.id, userId: banned.id, reason: "" });
    await follow(subbed.id);
    await db().insert(schema.subscriptions).values({
      subscriberId: subbed.id,
      channelId: c.id,
      tier: 1,
      status: "active",
      provider: "manual",
      priceCents: 499,
      currency: "usd",
    });
    await follow(suspended.id);
    await follow(bot.id);
    await chat(stale.id, 40);
    await db()
      .insert(schema.follows)
      .values({ followerId: excludedFollow.id, channelId: c.id, excludedAt: new Date() });
    // The owner and the gifter are in the community too, and never drawn.
    await chat(gifts.userId);
    await chat(alice.userId);
    await follow(alice.userId);

    const tooMany = await subscribe(alice, gifts.username, { tier: 1, gift: { count: 4 } });
    expect(tooMany.status).toBe(412);
    expect(tooMany.body.message).toContain("Only 3 viewers");

    for (let round = 0; round < 3; round++) {
      // Each draw is random; repeat a few times and roll back by expiring the attempt.
      const r = await subscribe(alice, gifts.username, { tier: 1, gift: { count: 2 } });
      expect(r.status).toBe(200);
      const drawn = await db()
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.giftPaymentId, r.body.paymentId));
      expect(drawn).toHaveLength(2);
      for (const s of drawn) {
        expect(eligible).toContain(s.subscriberId);
        expect(s).toMatchObject({ status: "incomplete", giftedById: alice.userId, tier: 1, priceCents: 499 });
      }
      expect(r.body.amount.cents).toBe(998);
      const p = await paymentRow(r.body.paymentId);
      expect(p).toMatchObject({ quantity: 2, tier: 1, subscriptionId: null, amountCents: 998 });
      if (round < 2) {
        await db().update(schema.payments).set({ status: "failed" }).where(eq(schema.payments.id, p.id));
        await db()
          .update(schema.subscriptions)
          .set({ status: "expired" })
          .where(eq(schema.subscriptions.giftPaymentId, p.id));
      } else giftPaymentId = p.id;
    }
  });

  test("confirming a gift activates every recipient with one gift event", async () => {
    const c = await channelOf(gifts.username);
    expect((await confirm(giftPaymentId)).status).toBe(200);
    const subs = await db()
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.giftPaymentId, giftPaymentId));
    expect(subs.map((s) => s.status)).toEqual(["active", "active"]);
    const giftEvents = await eventsOf(c.id, "channel.subscription.gift");
    expect(giftEvents).toHaveLength(1);
    expect(giftEvents[0]?.payload).toMatchObject({
      user_login: alice.username,
      total: 2,
      tier: "1000",
      is_anonymous: false,
    });
    const subEvents = await eventsOf(c.id, "channel.subscribe");
    expect(subEvents).toHaveLength(2);
    expect(subEvents.every((e) => (e.payload as { is_gift: boolean }).is_gift)).toBe(true);
    const b = await creatorBalances(db(), gifts.userId, "usd");
    expect(b.holdCents).toBe(await creatorShare(998));
    // Each gift keeps the tier price it was bought at; the payment is never divided in floats.
    expect(subs.map((s) => s.priceCents)).toEqual([499, 499]);
    await expectLedgerBalanced();
  });

  test("named gifts: eligible only, never yourself", async () => {
    const recipients = (
      await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.giftPaymentId, giftPaymentId))
    ).map((s) => s.subscriberId);
    const left = eligible.find((id) => !recipients.includes(id));
    const [leftUser] = await db()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, left ?? ""));
    if (!leftUser) throw new Error("no remaining eligible user");

    const small = await subscribe(alice, gifts.username, { tier: 1, gift: { count: 2 } });
    expect(small.status).toBe(412);
    expect(small.body.message).toContain("Only 1 viewer");

    expect((await subscribe(alice, gifts.username, { tier: 1, gift: { count: 1, to: alice.username } })).status).toBe(
      400,
    );
    expect(
      (await subscribe(alice, gifts.username, { tier: 1, gift: { count: 2, to: leftUser.username } })).status,
    ).toBe(400);
    expect((await subscribe(alice, gifts.username, { tier: 1, gift: { count: 1, to: uniqueName("zz") } })).status).toBe(
      404,
    );
    const [recipient] = await db()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, recipients[0] ?? ""));
    expect(
      (await subscribe(alice, gifts.username, { tier: 1, gift: { count: 1, to: recipient?.username ?? "" } })).status,
    ).toBe(412);
    expect((await subscribe(alice, gifts.username, { tier: 1, gift: { count: 1, to: gifts.username } })).status).toBe(
      412,
    );

    const named = await subscribe(alice, gifts.username, { tier: 3, gift: { count: 1, to: leftUser.username } });
    expect(named.status).toBe(200);
    expect(named.body.amount.cents).toBe(2499);
    const [s] = await db()
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.giftPaymentId, named.body.paymentId));
    expect(s).toMatchObject({ subscriberId: leftUser.id, tier: 3, status: "incomplete" });
  });

  test("a gift recipient cannot cancel it", async () => {
    // bob receives a named gift and confirms through the treasurer.
    const r = await subscribe(alice, gifts.username, { tier: 1, gift: { count: 1, to: bob.username } });
    expect(r.status).toBe(200);
    expect((await confirm(r.body.paymentId)).status).toBe(200);
    const mine = await bob.client.call<Sub[]>("GET", "/api/me/subscriptions");
    const gift = mine.body.find((s) => s.channelSlug === gifts.username);
    expect(gift).toMatchObject({ gifted: true, status: "active", tier: 1 });
    const cancel = await bob.client.call("POST", `/api/me/subscriptions/${gift?.id}/cancel`, {});
    expect(cancel.status).toBe(412);
  });
});

describe("my subscriptions", () => {
  test("cancel at period end: own only, idempotent", async () => {
    const r = await subscribe(alice, gifts.username, { tier: 2 });
    expect(r.status).toBe(200);
    expect((await confirm(r.body.paymentId)).status).toBe(200);
    const mine = await alice.client.call<Sub[]>("GET", "/api/me/subscriptions");
    expect(mine.status).toBe(200);
    const sub = mine.body.find((s) => s.channelSlug === gifts.username && s.status === "active");
    expect(sub).toMatchObject({ tier: 2, gifted: false, cancelAtPeriodEnd: false });
    expect(mine.body.find((s) => s.channelSlug === streamer.username)?.status).toBe("canceled");

    expect((await bob.client.call("POST", `/api/me/subscriptions/${sub?.id}/cancel`, {})).status).toBe(404);
    const once = await alice.client.call<Sub>("POST", `/api/me/subscriptions/${sub?.id}/cancel`, {});
    expect(once.status).toBe(200);
    expect(once.body).toMatchObject({ id: sub?.id, status: "active", cancelAtPeriodEnd: true });
    const twice = await alice.client.call<Sub>("POST", `/api/me/subscriptions/${sub?.id}/cancel`, {});
    expect(twice.body.cancelAtPeriodEnd).toBe(true);

    const canceled = mine.body.find((s) => s.channelSlug === streamer.username);
    expect((await alice.client.call("POST", `/api/me/subscriptions/${canceled?.id}/cancel`, {})).status).toBe(409);
  });

  test("the owner's subscriber list pages newest first", async () => {
    const path = `/api/channels/${gifts.username}/subscriptions`;
    expect((await alice.client.call("GET", path)).status).toBe(403);
    const all = await gifts.client.call<Page<Sub>>("GET", path);
    expect(all.status).toBe(200);
    // Two random gifts, bob's gift, alice's own, and the seeded active subscriber.
    expect(all.body.items).toHaveLength(5);
    expect(all.body.items[0]?.subscriber.username).toBe(alice.username);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const pageRes: { body: Page<Sub> } = await gifts.client.call<Page<Sub>>(
        "GET",
        `${path}?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      ids.push(...pageRes.body.items.map((s) => s.id));
      cursor = pageRes.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual(all.body.items.map((s) => s.id));
  });
});

describe("renewal confirm", () => {
  test("a past-due renewal continues from the previous period end at the payment's price", async () => {
    const c = await channelOf(gifts.username);
    const [s] = await db()
      .select()
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.subscriberId, alice.userId),
          eq(schema.subscriptions.channelId, c.id),
          inArray(schema.subscriptions.status, ["active"]),
        ),
      );
    if (!s) throw new Error("no subscription");
    const prevEnd = new Date(Date.UTC(2026, 0, 31, 12));
    await db()
      .update(schema.subscriptions)
      .set({ status: "past_due", currentPeriodEnd: prevEnd })
      .where(eq(schema.subscriptions.id, s.id));
    const paymentId = uuidv7();
    await db().insert(schema.payments).values({
      id: paymentId,
      provider: "manual",
      providerRef: "CA-RENEW001",
      kind: "subscription",
      status: "pending",
      userId: alice.userId,
      channelId: c.id,
      subscriptionId: s.id,
      amountCents: 1099,
      currency: "usd",
      tier: 2,
      quantity: 1,
    });
    const before = (await eventsOf(c.id, "channel.subscribe")).length;
    expect((await confirm(paymentId)).status).toBe(200);
    const [after] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, s.id));
    expect(after?.status).toBe("active");
    expect(after?.currentPeriodStart?.toISOString()).toBe(prevEnd.toISOString());
    expect(after?.currentPeriodEnd?.toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(after?.priceCents).toBe(1099);
    expect((await eventsOf(c.id, "channel.subscribe")).length).toBe(before);
    await expectLedgerBalanced();
  });

  test("cancelling while past due ends it now and fails the open renewal", async () => {
    const c = await channelOf(gifts.username);
    const [s] = await db()
      .select()
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.subscriberId, alice.userId),
          eq(schema.subscriptions.channelId, c.id),
          eq(schema.subscriptions.status, "active"),
        ),
      );
    if (!s) throw new Error("no subscription");
    await db()
      .update(schema.subscriptions)
      .set({ status: "past_due", cancelAtPeriodEnd: false })
      .where(eq(schema.subscriptions.id, s.id));
    const paymentId = uuidv7();
    await db().insert(schema.payments).values({
      id: paymentId,
      provider: "manual",
      providerRef: "CA-RENEW002",
      kind: "subscription",
      status: "pending",
      userId: alice.userId,
      channelId: c.id,
      subscriptionId: s.id,
      amountCents: 999,
      currency: "usd",
      tier: 2,
      quantity: 1,
    });
    const endsBefore = (await eventsOf(c.id, "channel.subscription.end")).length;
    const r = await alice.client.call<Sub>("POST", `/api/me/subscriptions/${s.id}/cancel`, {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("canceled");
    expect((await paymentRow(paymentId)).status).toBe("failed");
    expect((await eventsOf(c.id, "channel.subscription.end")).length).toBe(endsBefore + 1);
    expect((await confirm(paymentId)).status).toBe(409);
    const [after] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, s.id));
    expect(after?.status).toBe("canceled");
  });
});

describe("reference collisions", () => {
  test("a real duplicate reference is recognised for the checkout retry", async () => {
    const err = await db()
      .insert(schema.payments)
      .values({ provider: "manual", providerRef: tipPayment.reference, kind: "tip", amountCents: 100, currency: "usd" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(violatesConstraint(err, "payments_provider_ref_uq")).toBe(true);
    expect(violatesConstraint(err, "subscriptions_active_uq")).toBe(false);
  });
});

describe("races", () => {
  test("a refund racing a chargeback never reverses more than was paid", async () => {
    const t = await tip(bob, streamer.username, { amountCents: 1000 });
    expect((await confirm(t.body.paymentId)).status).toBe(200);
    const base = `/api/treasurer/payments/${t.body.paymentId}`;
    const results = await Promise.all([
      treasurer.client.call("POST", `${base}/refund`, { amountCents: 700, reason: "Refund" }),
      treasurer.client.call("POST", `${base}/chargeback`, { amountCents: 700, reason: "Chargeback" }),
    ]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(statuses.filter((x) => x === 400 || x === 409)).toHaveLength(1);
    const p = await paymentRow(t.body.paymentId);
    expect(p.refundedCents).toBe(700);
    const ds = await db().select().from(schema.disputes).where(eq(schema.disputes.paymentId, p.id));
    expect(ds.reduce((sum, d) => sum + Number(d.amountCents), 0)).toBe(700);
    const reversals = (await ledgerTxFor(p.id)).filter((x) => x.kind === "refund" || x.kind === "chargeback");
    expect(reversals).toHaveLength(1);
    await expectLedgerBalanced();
  });

  test("two concurrent self subscribes share one pending checkout", async () => {
    const viewer = await signUpAndSignIn(api);
    const [a, b] = await Promise.all([
      subscribe(viewer, streamer.username, { tier: 1 }),
      subscribe(viewer, streamer.username, { tier: 1 }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.paymentId).toBe(b.body.paymentId);
    expect(a.body.reference).toBe(b.body.reference);
    const ps = await db()
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.userId, viewer.userId), eq(schema.payments.status, "pending")));
    expect(ps).toHaveLength(1);
  });
});
