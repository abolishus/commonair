// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E4b reports: revenue dashboard, revenue ledger, payouts, costs and transparency, against
 * fixtures posted with the ledger's own rules (independent of the checkout handlers).
 * The API clock is pinned so hold windows and payout months are deterministic.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { creatorBalances, paymentSucceeded, post, postReversal, releaseDueHolds } from "@commonair/ledger";
import { client, signUpAndSignIn, startApi, uniqueName, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
const CUT = { streamerShare: 0.9, coopShare: 0.1 };
const at = (s: string) => new Date(s);
const AUG = { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" };

let api: TestApi;
let now = at("2026-08-20T00:00:00Z");
let owner: Person;
let small: Person;
let netted: Person;
let treasurer: Person;
const channelOf = new Map<string, string>();
let payerA: string;
let payerB: string;
const recipients: string[] = [];
const P: Record<string, string> = {};

const db = () => api.db.db;
const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const reference = () =>
  `CA-${Array.from({ length: 8 }, () => REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)]).join("")}`;

async function insertUser(): Promise<string> {
  const username = uniqueName("p");
  const [u] = await db()
    .insert(schema.users)
    .values({ name: `Payer ${username}`, email: `${username}@test.invalid`, username, emailVerified: true })
    .returning({ id: schema.users.id });
  if (!u) throw new Error("no user");
  return u.id;
}

interface PayInput {
  creator: Person;
  payer: string;
  kind: "subscription" | "tip";
  cents: number;
  at: string;
  tier?: 1 | 2 | 3;
  /** Gift recipients (one subscription each); the payment's quantity is their number. */
  gift?: string[];
  /** Status of the payer's own subscription (self subscriptions). */
  subStatus?: "active" | "past_due" | "canceled" | "expired";
  anonymous?: boolean;
}

/** A succeeded payment with its subscription or tip row, posted with `paymentSucceeded`. */
async function pay(i: PayInput): Promise<string> {
  const channelId = channelOf.get(i.creator.userId);
  if (!channelId) throw new Error("no channel");
  const occurredAt = at(i.at);
  const paymentId = uuidv7(occurredAt.getTime());
  let tipId: string | null = null;
  if (i.kind === "tip") {
    const [tip] = await db()
      .insert(schema.tips)
      .values({
        fromUserId: i.payer,
        channelId,
        amountCents: i.cents,
        currency: "usd",
        message: "thanks",
        anonymous: i.anonymous ?? false,
        paymentId,
        status: "succeeded",
      })
      .returning({ id: schema.tips.id });
    tipId = tip?.id ?? null;
  }
  await db()
    .insert(schema.payments)
    .values({
      id: paymentId,
      provider: "manual",
      providerRef: reference(),
      kind: i.kind,
      status: "succeeded",
      userId: i.payer,
      channelId,
      tipId,
      amountCents: i.cents,
      currency: "usd",
      tier: i.tier ?? null,
      quantity: i.gift?.length ?? 1,
      succeededAt: occurredAt,
    });
  if (i.kind === "subscription") {
    const subscribers = i.gift ?? [i.payer];
    const price = i.cents / subscribers.length;
    for (const s of subscribers) {
      await db()
        .insert(schema.subscriptions)
        .values({
          subscriberId: s,
          channelId,
          tier: i.tier ?? 1,
          status: i.gift ? "active" : (i.subStatus ?? "active"),
          provider: "manual",
          priceCents: price,
          currency: "usd",
          currentPeriodStart: occurredAt,
          currentPeriodEnd: new Date(occurredAt.getTime() + 30 * 86_400_000),
          giftedById: i.gift ? i.payer : null,
          giftPaymentId: i.gift ? paymentId : null,
        });
    }
  }
  await post(
    db(),
    paymentSucceeded({
      paymentId,
      paymentKind: i.kind,
      provider: "manual",
      settlement: "cash",
      creatorUserId: i.creator.userId,
      grossCents: i.cents,
      taxCents: 0,
      feeCents: 0,
      currency: "usd",
      cut: CUT,
      occurredAt,
    }),
  );
  return paymentId;
}

async function reverse(kind: "refund" | "chargeback", paymentId: string, cents: number, when: string) {
  const [d] = await db()
    .insert(schema.disputes)
    .values({
      paymentId,
      kind,
      status: kind === "refund" ? "closed" : "lost",
      amountCents: cents,
      reason: "fixture",
      resolvedAt: at(when),
    })
    .returning({ id: schema.disputes.id });
  if (!d) throw new Error("no dispute");
  await postReversal(db(), { kind, disputeId: d.id, paymentId, amountCents: cents, occurredAt: at(when) });
}

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

interface Money {
  cents: number;
  currency: string;
}
interface Summary {
  periodStart: string;
  periodEnd: string;
  gross: Money;
  coopCut: Money;
  refundsAndChargebacks: Money;
  net: Money;
  pendingPayout: Money;
  activeSubscriptions: { tier1: number; tier2: number; tier3: number };
  tips: number;
  split: { streamerShare: number; coopShare: number };
  daily: { date: string; gross: number; net: number }[];
  balance: { available: Money; held: Money; owed: Money; minimumPayout: Money; holdDays: number };
  bySource: { subscriptions: number; gifts: number; tips: number };
  tiers: { tier: number; active: number; monthlyShare: Money }[];
  previousNet: Money;
}
interface Line {
  id: string;
  type: string;
  tier: number | null;
  quantity: number;
  from: { id: string; username: string } | null;
  reference: string | null;
  gross: Money | null;
  deductions: Money | null;
  net: Money;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const revenue = (who: Person, slug: string, q: Record<string, string | undefined> = {}) =>
  who.client.call<Summary>("GET", `/api/channels/${slug}/revenue?${qs(q)}`);
const ledgerPage = (who: Person, slug: string, q: Record<string, string | number | undefined>) =>
  who.client.call<Page<Line>>("GET", `/api/channels/${slug}/revenue/ledger?${qs(q)}`);
const runPayouts = (periodEnd: string) =>
  treasurer.client.call<{ created: number; held: number; total: Money }>("POST", "/api/treasurer/payouts/run", {
    periodEnd,
  });

beforeAll(async () => {
  api = await startApi();
  owner = await signUpAndSignIn(api);
  small = await signUpAndSignIn(api);
  netted = await signUpAndSignIn(api);
  treasurer = await signUpAndSignIn(api);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  const chans = await db()
    .select({ id: schema.channels.id, ownerId: schema.channels.ownerId })
    .from(schema.channels)
    .where(inArray(schema.channels.ownerId, [owner.userId, small.userId, netted.userId]));
  for (const c of chans) channelOf.set(c.ownerId, c.id);
  api.deps.now = () => now;

  payerA = await insertUser();
  payerB = await insertUser();
  for (let i = 0; i < 3; i++) recipients.push(await insertUser());

  // July: the previous period.
  P.july = await pay({
    creator: owner,
    payer: payerB,
    kind: "subscription",
    tier: 2,
    cents: 1000,
    at: "2026-07-10T10:00:00Z",
    subStatus: "past_due",
  });
  // August.
  P.sub = await pay({
    creator: owner,
    payer: payerA,
    kind: "subscription",
    tier: 2,
    cents: 1000,
    at: "2026-08-02T10:00:00Z",
    subStatus: "canceled",
  });
  P.gift = await pay({
    creator: owner,
    payer: payerA,
    kind: "subscription",
    tier: 1,
    cents: 1500,
    at: "2026-08-03T10:00:00Z",
    gift: recipients,
  });
  P.tip = await pay({ creator: owner, payer: payerB, kind: "tip", cents: 700, at: "2026-08-04T10:00:00Z" });
  P.anon = await pay({
    creator: owner,
    payer: payerA,
    kind: "tip",
    cents: 333,
    at: "2026-08-05T10:00:00Z",
    anonymous: true,
  });
  P.netted1 = await pay({ creator: netted, payer: payerB, kind: "tip", cents: 5000, at: "2026-08-03T11:00:00Z" });
  P.small = await pay({ creator: small, payer: payerB, kind: "tip", cents: 1000, at: "2026-08-04T11:00:00Z" });
  await releaseDueHolds(db(), { asOf: at("2026-08-15T00:00:00Z"), holdDays: 7, currency: "usd" });
  // After the release: a partial refund and a chargeback.
  await reverse("refund", P.tip, 200, "2026-08-16T10:00:00Z");
  await reverse("chargeback", P.sub, 1000, "2026-08-17T10:00:00Z");
  // The netted creator has a payout account, enabled by the treasurer.
  await db().insert(schema.payoutAccounts).values({
    userId: netted.userId,
    provider: "manual",
    providerAccountId: "arranged",
    payoutsEnabled: true,
  });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("revenue", () => {
  test("August figures are exact to the cent", async () => {
    const r = await revenue(owner, owner.username, AUG);
    expect(r.status).toBe(200);
    const s = r.body;
    expect([s.periodStart, s.periodEnd]).toEqual([AUG.from, AUG.to]);
    // 1000 + 1500 + 700 + 333.
    expect(s.gross).toEqual({ cents: 3533, currency: "usd" });
    // Creator shares 900 + 1350 + 630 + 299, less the refund's 180 and the chargeback's 900.
    expect(s.net.cents).toBe(2099);
    // Co-op 100 + 150 + 70 + 34 − 20 − 100.
    expect(s.coopCut.cents).toBe(234);
    expect(s.refundsAndChargebacks.cents).toBe(1200);
    expect(s.tips).toBe(2);
    expect(s.split).toEqual(CUT);
    expect(s.bySource).toEqual({ subscriptions: 0, gifts: 1350, tips: 749 });
    expect(s.bySource.subscriptions + s.bySource.gifts + s.bySource.tips).toBe(s.net.cents);
    expect(s.previousNet.cents).toBe(900);
    // Three active gift subs at tier 1 and the past-due July sub at tier 2.
    expect(s.activeSubscriptions).toEqual({ tier1: 3, tier2: 1, tier3: 0 });
    expect(s.tiers).toEqual([
      { tier: 1, active: 3, monthlyShare: { cents: 1350, currency: "usd" } },
      { tier: 2, active: 1, monthlyShare: { cents: 900, currency: "usd" } },
      { tier: 3, active: 0, monthlyShare: { cents: 0, currency: "usd" } },
    ]);
    expect(s.daily).toHaveLength(31);
    const day = (d: string) => s.daily.find((x) => x.date === d);
    expect(day("2026-08-02")).toEqual({ date: "2026-08-02", gross: 1000, net: 900 });
    expect(day("2026-08-03")).toEqual({ date: "2026-08-03", gross: 1500, net: 1350 });
    expect(day("2026-08-15")).toEqual({ date: "2026-08-15", gross: 0, net: 0 });
    expect(day("2026-08-16")).toEqual({ date: "2026-08-16", gross: -200, net: -180 });
    expect(day("2026-08-17")).toEqual({ date: "2026-08-17", gross: -1000, net: -900 });
    expect(s.daily.reduce((sum, x) => sum + x.net, 0)).toBe(s.net.cents);

    const b = await creatorBalances(db(), owner.userId, "usd");
    expect(s.balance.available.cents).toBe(b.availableCents);
    expect(s.balance.available.cents).toBe(2999);
    expect(s.balance.held.cents).toBe(b.holdCents);
    expect(s.balance.held.cents).toBe(0);
    expect(s.balance.owed.cents).toBe(b.receivableCents);
    expect(s.balance.minimumPayout).toEqual({ cents: 2500, currency: "usd" });
    expect(s.balance.holdDays).toBe(7);
    expect(s.pendingPayout.cents).toBe(0);
  });

  test("defaults to the current UTC month and refuses bad periods", async () => {
    const r = await revenue(owner, owner.username);
    expect(r.status).toBe(200);
    expect([r.body.periodStart, r.body.periodEnd]).toEqual([AUG.from, AUG.to]);
    expect(r.body.net.cents).toBe(2099);
    expect((await revenue(owner, owner.username, { from: AUG.to, to: AUG.from })).status).toBe(400);
  });

  test("a creator with only July activity shows it as previousNet next month", async () => {
    const r = await revenue(owner, owner.username, { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" });
    expect(r.body.net.cents).toBe(900);
    expect(r.body.bySource).toEqual({ subscriptions: 900, gifts: 0, tips: 0 });
    expect(r.body.previousNet.cents).toBe(0);
  });

  test("non-owners get FORBIDDEN", async () => {
    expect((await revenue(small, owner.username, AUG)).status).toBe(403);
    expect((await ledgerPage(small, owner.username, AUG)).status).toBe(403);
    expect((await client(api).call("GET", `/api/channels/${owner.username}/revenue`)).status).toBe(401);
  });
});

describe("revenue ledger", () => {
  test("one row per payment and reversal, newest first, paged, no hold releases", async () => {
    const first = await ledgerPage(owner, owner.username, { ...AUG, limit: 4 });
    expect(first.status).toBe(200);
    expect(first.body.items.map((l) => l.type)).toEqual(["chargeback", "refund", "tip", "tip"]);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await ledgerPage(owner, owner.username, {
      ...AUG,
      limit: 4,
      cursor: first.body.nextCursor ?? undefined,
    });
    expect(second.body.items.map((l) => l.type)).toEqual(["gift", "subscription"]);
    expect(second.body.nextCursor).toBeNull();

    const lines = [...first.body.items, ...second.body.items];
    expect(new Set(lines.map((l) => l.id)).size).toBe(6);
    expect(lines.reduce((s, l) => s + l.net.cents, 0)).toBe(2099);
    // Payment rows: gross + deductions = net, and the reference is the payment's CA-… token.
    expect(lines.map((l) => (l.gross?.cents ?? 0) + (l.deductions?.cents ?? 0))).toEqual(lines.map((l) => l.net.cents));
    for (const l of lines) expect(l.reference).toMatch(/^CA-[0-9A-Z]{8}$/);

    const [chargeback, refund, anon, tip] = first.body.items;
    expect(chargeback).toMatchObject({ tier: 2, quantity: 1, gross: { cents: -1000 }, deductions: { cents: 100 } });
    expect(chargeback?.net.cents).toBe(-900);
    expect(chargeback?.from?.id).toBe(payerA);
    expect(refund).toMatchObject({ gross: { cents: -200 }, deductions: { cents: 20 }, net: { cents: -180 } });
    expect(refund?.from?.id).toBe(payerB);
    expect(anon).toMatchObject({ from: null, gross: { cents: 333 }, net: { cents: 299 }, deductions: { cents: -34 } });
    expect(tip).toMatchObject({ gross: { cents: 700 }, net: { cents: 630 } });
    expect(tip?.from?.id).toBe(payerB);
    const [gift, sub] = second.body.items;
    expect(gift).toMatchObject({ tier: 1, quantity: 3, gross: { cents: 1500 }, net: { cents: 1350 } });
    expect(gift?.from?.id).toBe(payerA);
    expect(sub).toMatchObject({ tier: 2, quantity: 1, net: { cents: 900 } });

    // The references are the payments' own.
    const [row] = await db()
      .select({ ref: schema.payments.providerRef })
      .from(schema.payments)
      .where(eq(schema.payments.id, P.gift ?? ""));
    expect(gift?.reference).toBe(row?.ref);
  });

  test("without a period it lists everything; a bad cursor is a client error", async () => {
    const all = await ledgerPage(owner, owner.username, { limit: 100 });
    expect(all.body.items).toHaveLength(7);
    expect(all.body.items.at(-1)?.net.cents).toBe(900);
    expect((await ledgerPage(owner, owner.username, { cursor: "nope" })).status).toBe(400);
  });
});

describe("payouts", () => {
  test("a future periodEnd is refused", async () => {
    expect((await runPayouts("2026-08-25T00:00:00Z")).status).toBe(400);
  });

  test("non-treasurers get FORBIDDEN", async () => {
    const r = await owner.client.call("POST", "/api/treasurer/payouts/run", { periodEnd: "2026-08-19T00:00:00Z" });
    expect(r.status).toBe(403);
    expect((await small.client.call("GET", "/api/treasurer/payouts")).status).toBe(403);
  });

  test("below the minimum nothing is created; above it, held without an account and pending with one", async () => {
    const before = await creatorBalances(db(), small.userId, "usd");
    const r = await runPayouts("2026-08-20T00:00:00Z");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ created: 1, held: 1, total: { cents: 2999 + 4500, currency: "usd" } });

    const rows = await db().select().from(schema.payouts);
    expect(rows.filter((p) => p.userId === small.userId)).toHaveLength(0);
    expect(await creatorBalances(db(), small.userId, "usd")).toEqual(before);
    const ownerPayout = rows.find((p) => p.userId === owner.userId);
    expect(ownerPayout).toMatchObject({ status: "held", holdReason: "payout_account_not_ready", amountCents: 2999 });
    expect(ownerPayout?.periodStart.toISOString()).toBe(AUG.from);
    const nettedPayout = rows.find((p) => p.userId === netted.userId);
    expect(nettedPayout).toMatchObject({ status: "pending", amountCents: 4500 });

    // The reserved money is pending payout, no longer available.
    const s = (await revenue(owner, owner.username, AUG)).body;
    expect(s.pendingPayout.cents).toBe(2999);
    expect(s.balance.available.cents).toBe(0);

    const held = await treasurer.client.call<Page<{ id: string; status: string; user: { username: string } }>>(
      "GET",
      "/api/treasurer/payouts?status=held",
    );
    expect(held.body.items.map((p) => p.user.username)).toEqual([owner.username]);
    const all = await treasurer.client.call<Page<{ id: string }>>("GET", "/api/treasurer/payouts?limit=1");
    expect(all.body.items).toHaveLength(1);
    expect(all.body.nextCursor).not.toBeNull();
  });

  test("a second run in the same month is idempotent", async () => {
    const count = async () => (await db().select().from(schema.payouts)).length;
    const n = await count();
    const r = await runPayouts("2026-08-20T00:00:00Z");
    expect(r.body).toEqual({ created: 0, held: 0, total: { cents: 0, currency: "usd" } });
    expect(await count()).toBe(n);
  });

  test("markPaid posts once; a chargeback after the batch becomes a receivable the next payout nets", async () => {
    // Charged back after the batch reserved the payout: nothing left to draw on, so it is owed.
    now = at("2026-08-21T12:00:00Z");
    await reverse("chargeback", P.netted1 ?? "", 5000, "2026-08-21T10:00:00Z");
    let b = await creatorBalances(db(), netted.userId, "usd");
    expect(b).toMatchObject({ liabilityCents: 0, receivableCents: 4500, reservedCents: 4500 });

    const [aug] = await db().select().from(schema.payouts).where(eq(schema.payouts.userId, netted.userId));
    now = at("2026-08-22T09:00:00Z");
    const paid = await treasurer.client.call("POST", `/api/treasurer/payouts/${aug?.id}/paid`, {
      reference: "BANK-0822",
    });
    expect(paid.status).toBe(200);
    const again = await treasurer.client.call("POST", `/api/treasurer/payouts/${aug?.id}/paid`, {
      reference: "BANK-0822",
    });
    expect(again.status).toBe(409);
    const sent = await db()
      .select()
      .from(schema.ledgerTransactions)
      .where(and(eq(schema.ledgerTransactions.kind, "payout"), eq(schema.ledgerTransactions.refId, aug?.id ?? "")));
    expect(sent).toHaveLength(1);
    const [row] = await db()
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, aug?.id ?? ""));
    expect(row).toMatchObject({ status: "paid", providerRef: "BANK-0822" });
    expect(row?.paidAt?.toISOString()).toBe("2026-08-22T09:00:00.000Z");

    // A held payout cannot be marked paid; an unknown one is not found.
    const [held] = await db().select().from(schema.payouts).where(eq(schema.payouts.userId, owner.userId));
    expect(
      (await treasurer.client.call("POST", `/api/treasurer/payouts/${held?.id}/paid`, { reference: "x" })).status,
    ).toBe(409);
    expect(
      (await treasurer.client.call("POST", `/api/treasurer/payouts/${uuidv7()}/paid`, { reference: "x" })).status,
    ).toBe(404);

    // September: new earnings, released by the run itself, net the receivable.
    P.netted2 = await pay({ creator: netted, payer: payerB, kind: "tip", cents: 10_000, at: "2026-09-03T10:00:00Z" });
    now = at("2026-10-02T08:00:00Z");
    const r = await runPayouts("2026-10-01T00:00:00Z");
    expect(r.body).toEqual({ created: 1, held: 0, total: { cents: 4500, currency: "usd" } });
    b = await creatorBalances(db(), netted.userId, "usd");
    expect(b).toMatchObject({ liabilityCents: 0, receivableCents: 0, reservedCents: 4500, holdCents: 0 });
    const s = (await revenue(netted, netted.username, { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" }))
      .body;
    expect(s.balance).toMatchObject({ available: { cents: 0 }, owed: { cents: 0 }, held: { cents: 0 } });
    expect(s.pendingPayout.cents).toBe(4500);
    expect(s.net.cents).toBe(9000);

    const mine = await netted.client.call<{ id: string; status: string; periodStart: string }[]>(
      "GET",
      "/api/me/payouts",
    );
    expect(mine.body.map((p) => p.periodStart)).toEqual(["2026-09-01T00:00:00.000Z", AUG.from]);
    const sep = mine.body[0];
    expect(sep?.status).toBe("pending");
    expect(
      (await treasurer.client.call("POST", `/api/treasurer/payouts/${sep?.id}/paid`, { reference: "BANK-1002" }))
        .status,
    ).toBe(200);
    b = await creatorBalances(db(), netted.userId, "usd");
    expect(b).toMatchObject({ liabilityCents: 0, receivableCents: 0, reservedCents: 0 });

    // The payout rows on the revenue ledger: reserved (negative), with a CSV-safe reference.
    const lines = (await ledgerPage(netted, netted.username, { limit: 100 })).body.items;
    const payouts = lines.filter((l) => l.type === "payout");
    expect(payouts.map((l) => [l.net.cents, l.gross, l.deductions, l.reference])).toEqual([
      [-4500, null, null, "BANK-1002"],
      [-4500, null, null, "BANK-0822"],
    ]);

    const audits = await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.action, ["payout.run", "payout.paid"]));
    expect(audits.filter((a) => a.action === "payout.run")).toHaveLength(3);
    expect(audits.filter((a) => a.action === "payout.paid")).toHaveLength(2);
  });

  test("payout account and statement are the caller's own", async () => {
    const mine = await owner.client.call<{
      provider: string;
      payoutsEnabled: boolean;
      onboardingUrl: string | null;
      instructions: string | null;
    }>("GET", "/api/me/payout-account");
    expect(mine.body).toEqual({
      provider: "manual",
      payoutsEnabled: false,
      onboardingUrl: null,
      instructions: api.deps.env.MANUAL_PAYOUT_INSTRUCTIONS,
    });
    const ready = await netted.client.call<{ payoutsEnabled: boolean; instructions: string | null }>(
      "GET",
      "/api/me/payout-account",
    );
    expect(ready.body).toMatchObject({ payoutsEnabled: true, instructions: null });

    const page = await netted.client.call<
      Page<{ transactionId: string; kind: string; account: string; amount: Money }>
    >("GET", "/api/me/ledger?limit=3");
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(3);
    expect(page.body.items[0]?.kind).toBe("payout");
    expect(page.body.nextCursor).not.toBeNull();
    expect((await netted.client.call("GET", "/api/me/ledger?cursor=bad")).status).toBe(400);
    const other = await small.client.call<Page<{ account: string }>>("GET", "/api/me/ledger?limit=100");
    for (const l of other.body.items) expect(l.account).toContain(small.userId);
    expect((await small.client.call<unknown[]>("GET", "/api/me/payouts")).body).toEqual([]);
  });
});

describe("costs and transparency", () => {
  test("recordCost books the cost in its period; the description stays out of the ledger", async () => {
    const body = {
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-09-01T00:00:00Z",
      category: "hosting",
      description: "VPS for ops@example.org",
      amountCents: 1234,
    };
    expect((await owner.client.call("POST", "/api/treasurer/costs", body)).status).toBe(403);
    expect(
      (await treasurer.client.call("POST", "/api/treasurer/costs", { ...body, category: "Web Hosting" })).status,
    ).toBe(400);
    expect(
      (
        await treasurer.client.call("POST", "/api/treasurer/costs", {
          ...body,
          periodStart: "2026-12-01T00:00:00Z",
          periodEnd: "2027-01-01T00:00:00Z",
        })
      ).status,
    ).toBe(400);
    expect((await treasurer.client.call("POST", "/api/treasurer/costs", body)).status).toBe(200);

    const [cost] = await db().select().from(schema.infraCosts);
    expect(cost).toMatchObject({ category: "hosting", description: body.description, amountCents: 1234 });
    const [tx] = await db()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.id, cost?.ledgerTransactionId ?? ""));
    expect(tx?.occurredAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(JSON.stringify(tx)).not.toContain("example.org");
    const [audited] = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "cost.record"));
    expect(audited?.subjectId).toBe(cost?.id);
    expect(JSON.stringify(audited?.details)).not.toContain("example.org");
  });

  test("transparency is public, newest first, and omits months without ledger activity", async () => {
    type Month = {
      month: string;
      revenue: Money;
      streamerPayouts: Money;
      coopRetained: Money;
      costs: { category: string; amount: Money }[];
      surplus: Money;
      patronageDistributed: Money;
      egressBySource: Record<string, number>;
      governance: unknown[];
      members: Record<string, number>;
    };
    const r = await client(api).call<Month[]>("GET", "/api/transparency?months=12");
    expect(r.status).toBe(200);
    expect(r.body.map((m) => m.month)).toEqual(["2026-10", "2026-09", "2026-08", "2026-07"]);
    const aug = r.body.find((m) => m.month === "2026-08");
    // Owner 3533 − 1200, the netted creator's 5000 charged back in full, the small creator's 1000.
    expect(aug?.revenue.cents).toBe(3333);
    expect(aug?.coopRetained.cents).toBe(334);
    expect(aug?.costs).toEqual([{ category: "hosting", amount: { cents: 1234, currency: "usd" } }]);
    expect(aug?.surplus.cents).toBe(334 - 1234);
    expect(aug?.streamerPayouts.cents).toBe(4500);
    expect(aug?.patronageDistributed.cents).toBe(0);
    expect(aug?.egressBySource).toEqual({ origin: 0, relay: 0, p2p: 0, cdn: 0 });
    expect(aug?.governance).toEqual([]);
    expect(aug?.members).toEqual({ streamer: 0, viewer: 0, worker: 0 });
    expect(r.body.find((m) => m.month === "2026-10")?.streamerPayouts.cents).toBe(4500);
    expect(r.body.find((m) => m.month === "2026-07")?.revenue.cents).toBe(1000);

    const short = await client(api).call<Month[]>("GET", "/api/transparency?months=2");
    expect(short.body.map((m) => m.month)).toEqual(["2026-10", "2026-09"]);
  });
});
