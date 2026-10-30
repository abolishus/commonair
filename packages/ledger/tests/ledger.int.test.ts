// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ledger against a real database, through the least-privilege application role
 * (`t.app.db`) that services use in production.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { createDb, schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  DEFAULT_PLATFORM_CUT,
  IdempotencyConflictError,
  PAYOUT_ACCOUNT_NOT_READY,
  PaymentNotFoundError,
  PayoutStateError,
  PeriodCloseError,
  ReversalExceedsPaymentError,
  accountBalance,
  accounts,
  cancelPayout,
  closePeriod,
  creatorBalances,
  ensureAccounts,
  getOrCreateAccount,
  holdLots,
  infrastructureCost,
  loadMoneySettings,
  monthlyAggregates,
  patronageAllocation,
  paymentHoldRemaining,
  paymentSucceeded,
  post,
  postChargebackReversal,
  postPayout,
  postReversal,
  rawBalance,
  releaseDueHolds,
  retainedSurplus,
  runPayoutBatch,
  statement,
  storedCode,
} from "../src/index.ts";

// Suites run in parallel with every other workspace: generous deadlines for tests, and for teardown,
// since Postgres runs DROP DATABASE one at a time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let db: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function makeUser(): Promise<string> {
  const name = `ledger${++seq}`;
  const [u] = await db
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

function payment(creator: string, gross: number, at: Date, opts: { tax?: number; fee?: number } = {}) {
  return paymentSucceeded({
    paymentId: uuidv7(),
    paymentKind: "subscription",
    provider: "stripe",
    creatorUserId: creator,
    grossCents: gross,
    taxCents: opts.tax ?? 0,
    feeCents: opts.fee ?? 0,
    currency: "usd",
    cut: DEFAULT_PLATFORM_CUT,
    cutHistoryId: null,
    occurredAt: at,
  });
}

async function txSum(transactionId: string): Promise<number> {
  const rows = await db.execute<{ total: string }>(
    sql`select coalesce(sum(amount_cents), 0)::text as total from ledger_entries where transaction_id = ${transactionId}`,
  );
  return Number(rows[0]!.total);
}

/** Drizzle wraps driver errors; assert on the database's own message. */
async function expectDbError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(`${e.message} ${e.cause?.message ?? ""}`).toMatch(pattern);
}

describe("accounts", () => {
  test("get-or-create is idempotent and concurrency-safe", async () => {
    const user = await makeUser();
    const code = accounts.creator(user);
    const ids = await Promise.all(Array.from({ length: 8 }, () => getOrCreateAccount(db, code, "usd")));
    expect(new Set(ids).size).toBe(1);
    const [row] = await db.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.id, ids[0]!));
    expect(row).toMatchObject({ code: storedCode(code, "usd"), type: "liability", ownerUserId: user, currency: "usd" });
    // Another currency is another account.
    const eur = await getOrCreateAccount(db, code, "eur");
    expect(eur).not.toBe(ids[0]);
    const map = await ensureAccounts(db, [code, code, accounts.platformCut()], "usd");
    expect(map.get(code)).toBe(ids[0]);
    expect(map.size).toBe(2);
  });
});

describe("poster", () => {
  test("posts a payment and balances follow", async () => {
    const creator = await makeUser();
    const p = payment(creator, 1099, new Date(), { tax: 99, fee: 62 });
    const r = await post(db, p);
    expect(r.created).toBe(true);
    expect(await txSum(r.transactionId)).toBe(0);
    const b = await creatorBalances(db, creator, "usd");
    expect(b).toEqual({ liabilityCents: 0, holdCents: 900, receivableCents: 0, reservedCents: 0, availableCents: 0 });
    expect(await paymentHoldRemaining(db, p.refId!, creator, "usd")).toBe(900);
    expect(await accountBalance(db, accounts.paymentFees(), "usd", "expense")).toBeGreaterThanOrEqual(62);
  });

  test("is idempotent: a repeat returns the same transaction and posts nothing", async () => {
    const creator = await makeUser();
    const p = payment(creator, 5000, new Date());
    const [a, b] = await Promise.all([post(db, p), post(db, p)]);
    expect(a!.transactionId).toBe(b!.transactionId);
    expect([a!.created, b!.created].filter(Boolean)).toHaveLength(1);
    const again = await post(db, p);
    expect(again).toEqual({ transactionId: a!.transactionId, created: false });
    const entries = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.transactionId, a!.transactionId));
    expect(entries).toHaveLength(3);
    expect((await creatorBalances(db, creator, "usd")).holdCents).toBe(4500);
  });

  test("reusing a key for a different event is refused", async () => {
    const creator = await makeUser();
    const p = payment(creator, 1000, new Date());
    await post(db, p);
    await expect(post(db, { ...p, refId: uuidv7() })).rejects.toThrow(IdempotencyConflictError);
  });

  test("posts atomically inside a caller's transaction and rolls back with it", async () => {
    const creator = await makeUser();
    const p = payment(creator, 1000, new Date());
    await expect(
      db.transaction(async (tx) => {
        await post(tx, p);
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    const rows = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, p.idempotencyKey));
    expect(rows).toHaveLength(0);
  });

  test("the database rejects an unbalanced posting that bypasses the poster", async () => {
    const cash = await getOrCreateAccount(db, accounts.cash("stripe"), "usd");
    const rev = await getOrCreateAccount(db, accounts.platformCut(), "usd");
    await expectDbError(
      db.transaction(async (tx) => {
        const [x] = await tx
          .insert(s.ledgerTransactions)
          .values({ kind: "payment", description: "raw", occurredAt: new Date(), idempotencyKey: uuidv7() })
          .returning();
        await tx.insert(s.ledgerEntries).values([
          { transactionId: x!.id, accountId: cash, amountCents: 100, currency: "usd" },
          { transactionId: x!.id, accountId: rev, amountCents: -99, currency: "usd" },
        ]);
      }),
      /unbalanced/,
    );
  });

  test("the application role cannot rewrite or delete ledger rows", async () => {
    const creator = await makeUser();
    const r = await post(db, payment(creator, 1000, new Date()));
    await expectDbError(
      db.update(s.ledgerTransactions).set({ description: "x" }).where(eq(s.ledgerTransactions.id, r.transactionId)),
      /permission denied|append-only/,
    );
    await expectDbError(
      db.delete(s.ledgerEntries).where(eq(s.ledgerEntries.transactionId, r.transactionId)),
      /permission denied|append-only/,
    );
  });
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function reverse(kind: "refund" | "chargeback", paymentId: string, amountCents: number, disputeFeeCents = 0) {
  return { kind, disputeId: uuidv7(), paymentId, amountCents, occurredAt: new Date(), disputeFeeCents };
}

describe("reversals", () => {
  test("partial then full refund reverses exactly the original split", async () => {
    const creator = await makeUser();
    const p = payment(creator, 1099, new Date(), { tax: 99 });
    await post(db, p);
    await postReversal(db, reverse("refund", p.refId!, 333));
    await postReversal(db, reverse("refund", p.refId!, 766));
    expect(await creatorBalances(db, creator, "usd")).toEqual({
      liabilityCents: 0,
      holdCents: 0,
      receivableCents: 0,
      reservedCents: 0,
      availableCents: 0,
    });
    expect(await paymentHoldRemaining(db, p.refId!, creator, "usd")).toBe(0);
    await expect(postReversal(db, reverse("refund", p.refId!, 1))).rejects.toThrow(ReversalExceedsPaymentError);
  });

  test("is idempotent per dispute and refuses unknown payments", async () => {
    const creator = await makeUser();
    const p = payment(creator, 1000, new Date());
    await post(db, p);
    const r = reverse("refund", p.refId!, 400);
    const a = await postReversal(db, r);
    const b = await postReversal(db, r);
    expect(b).toEqual({ transactionId: a.transactionId, created: false });
    expect(await paymentHoldRemaining(db, p.refId!, creator, "usd")).toBe(900 - 360);
    await expect(postReversal(db, reverse("refund", uuidv7(), 1))).rejects.toThrow(PaymentNotFoundError);
  });

  test("concurrent disputes on two connections cannot over-reverse a payment", async () => {
    const other = createDb({ url: t.appUrl, max: 2 });
    try {
      const creator = await makeUser();
      const p = payment(creator, 1000, new Date());
      await post(db, p);
      const results = await Promise.allSettled([
        postReversal(db, reverse("chargeback", p.refId!, 600)),
        postReversal(other.db, reverse("refund", p.refId!, 600)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(ReversalExceedsPaymentError);
      expect(await rawBalance(db, accounts.cash("stripe"), "usd")).toBeGreaterThanOrEqual(0);
      const reversed = await db.execute<{ total: string }>(sql`
        select coalesce(sum((metadata->>'revenueGrossCents')::bigint), 0)::text as total
        from ledger_transactions where ref_id = ${p.refId!} and kind in ('refund', 'chargeback')`);
      expect(Number(reversed[0]!.total)).toBe(-600);
    } finally {
      await other.close();
    }
  });

  test("a won chargeback restores the payment and cancels the clawback receivable", async () => {
    const creator = await makeUser();
    const p = payment(creator, 10_000, new Date());
    await post(db, p);
    const cb = reverse("chargeback", p.refId!, 10_000, 1500);
    await postReversal(db, cb);
    // Hold covered all of it: nothing owed.
    expect(await creatorBalances(db, creator, "usd")).toMatchObject({ holdCents: 0, receivableCents: 0 });
    const won = await postChargebackReversal(db, {
      disputeId: cb.disputeId,
      occurredAt: new Date(),
      feeRefundCents: 1500,
    });
    expect(won.created).toBe(true);
    // Restored as released earnings; the hold lot stays closed.
    expect(await creatorBalances(db, creator, "usd")).toMatchObject({ liabilityCents: 9000, holdCents: 0 });
    expect(await paymentHoldRemaining(db, p.refId!, creator, "usd")).toBe(0);
    expect(await postChargebackReversal(db, { disputeId: cb.disputeId, occurredAt: new Date() })).toEqual({
      transactionId: won.transactionId,
      created: false,
    });
    // After the win the payment can be reversed again (e.g. a later refund).
    await postReversal(db, reverse("refund", p.refId!, 1000));
    expect((await creatorBalances(db, creator, "usd")).liabilityCents).toBe(8100);
    await expect(postChargebackReversal(db, { disputeId: uuidv7(), occurredAt: new Date() })).rejects.toThrow(
      PaymentNotFoundError,
    );
  });

  test("a won chargeback after a clawback cancels the receivable first", async () => {
    const creator = await makeUser();
    const p = payment(creator, 10_000, daysAgo(30));
    await post(db, p);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" });
    // Spend the earnings so the chargeback has to book a receivable.
    await post(db, {
      ...p,
      kind: "infrastructure_cost",
      description: "test drain",
      refType: null,
      refId: null,
      idempotencyKey: `drain:${uuidv7()}`,
      metadata: {},
      entries: [
        { code: accounts.creator(creator), amountCents: 9000 },
        { code: accounts.cash("stripe"), amountCents: -9000 },
      ],
    });
    const cb = reverse("chargeback", p.refId!, 10_000);
    await postReversal(db, cb);
    expect((await creatorBalances(db, creator, "usd")).receivableCents).toBe(9000);
    await postChargebackReversal(db, { disputeId: cb.disputeId, occurredAt: new Date() });
    expect(await creatorBalances(db, creator, "usd")).toMatchObject({ liabilityCents: 0, receivableCents: 0 });
  });
});

describe("hold lots", () => {
  test("a clawback drawing on another payment's hold is attributed to that payment", async () => {
    const creator = await makeUser();
    const old = payment(creator, 10_000, daysAgo(10));
    const fresh = payment(creator, 5000, daysAgo(1));
    await post(db, old);
    await post(db, fresh);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" });
    expect(await creatorBalances(db, creator, "usd")).toMatchObject({ liabilityCents: 9000, holdCents: 4500 });

    // Released earnings are reserved for a payout; then the old payment is charged back.
    await post(db, {
      ...old,
      kind: "infrastructure_cost",
      description: "test drain",
      refType: null,
      refId: null,
      idempotencyKey: `drain:${uuidv7()}`,
      metadata: {},
      entries: [
        { code: accounts.creator(creator), amountCents: 7000 },
        { code: accounts.cash("stripe"), amountCents: -7000 },
      ],
    });
    await postReversal(db, reverse("chargeback", old.refId!, 10_000));
    // 9000 = 2000 released + 4500 from the fresh payment's lot + 2500 receivable.
    expect(await creatorBalances(db, creator, "usd")).toMatchObject({
      liabilityCents: 0,
      holdCents: 0,
      receivableCents: 2500,
    });
    expect(await paymentHoldRemaining(db, fresh.refId!, creator, "usd")).toBe(0);
    expect(await holdLots(db, creator, "usd")).toEqual([]);

    // Later, the fresh payment's release has nothing left to release: no early release.
    const r = await releaseDueHolds(db, { asOf: new Date(), holdDays: 0, currency: "usd" });
    expect(await creatorBalances(db, creator, "usd")).toMatchObject({ liabilityCents: 0, holdCents: 0 });
    expect(r.totalCents).toBeGreaterThanOrEqual(0);
  });

  test("drained lots never clog the release batch", async () => {
    const cur = "sek";
    const creator = await makeUser();
    const mk = (gross: number, at: Date) =>
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "tip",
        provider: "stripe",
        creatorUserId: creator,
        grossCents: gross,
        taxCents: 0,
        feeCents: 0,
        currency: cur,
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: at,
      });
    const drained = [mk(1000, daysAgo(20)), mk(1000, daysAgo(19))];
    const live = mk(2000, daysAgo(18));
    for (const p of [...drained, live]) await post(db, p);
    for (const p of drained) await postReversal(db, reverse("refund", p.refId!, 1000));
    // With a batch size of one, the drained (older) payments must not block the live one.
    const r = await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, limit: 1 });
    expect(r).toEqual({ released: 1, totalCents: 1800 });
    expect((await creatorBalances(db, creator, cur)).liabilityCents).toBe(1800);
  });
});

describe("payouts", () => {
  async function earn(creator: string, gross: number, cur: string) {
    await post(
      db,
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "subscription",
        provider: "stripe",
        creatorUserId: creator,
        grossCents: gross,
        taxCents: 0,
        feeCents: 0,
        currency: cur,
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: daysAgo(30),
      }),
    );
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur });
  }
  // Periods after every posting below, so all of it counts as of their end.
  const jan = { periodStart: new Date("2099-01-01T00:00:00Z"), periodEnd: new Date("2099-02-01T00:00:00Z") };
  const feb = { periodStart: new Date("2099-02-01T00:00:00Z"), periodEnd: new Date("2099-03-01T00:00:00Z") };

  test("batch reserves money for creators above the minimum, holds unready accounts, and is idempotent", async () => {
    const cur = "aud";
    const minimumCents = 2500;
    const ready = await makeUser();
    const unready = await makeUser();
    const small = await makeUser();
    await db.insert(s.payoutAccounts).values({ userId: ready, provider: "stripe", payoutsEnabled: true });
    await earn(ready, 5000, cur);
    await earn(unready, 4000, cur);
    await earn(small, 1000, cur);

    const r1 = await runPayoutBatch(db, { ...jan, currency: cur, minimumCents });
    expect(r1).toMatchObject({ created: 1, held: 1, totalCents: 4500 + 3600 });
    const rows = await db.select().from(s.payouts).where(eq(s.payouts.currency, cur));
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(ready)).toMatchObject({ amountCents: 4500, status: "pending", provider: "stripe" });
    expect(byUser.get(unready)).toMatchObject({
      amountCents: 3600,
      status: "held",
      holdReason: PAYOUT_ACCOUNT_NOT_READY,
    });
    expect(byUser.has(small)).toBe(false);
    expect(r1.carriedOver).toContainEqual({ userId: small, availableCents: 900 });
    expect(await creatorBalances(db, ready, cur)).toMatchObject({ liabilityCents: 0, reservedCents: 4500 });

    expect(await runPayoutBatch(db, { ...jan, currency: cur, minimumCents })).toMatchObject({ created: 0, held: 0 });
    // A later period does not pay reserved money twice.
    expect(await runPayoutBatch(db, { ...feb, currency: cur, minimumCents })).toMatchObject({ created: 0, held: 0 });

    const row = byUser.get(ready)!;
    const paid = await postPayout(db, { payoutId: row.id, paidAt: new Date(), providerRef: "po_1" });
    expect(paid.created).toBe(true);
    expect(await postPayout(db, { payoutId: row.id, paidAt: new Date() })).toEqual({
      transactionId: paid.transactionId,
      created: false,
    });
    const [after] = await db.select().from(s.payouts).where(eq(s.payouts.id, row.id));
    expect(after).toMatchObject({ status: "paid", ledgerTransactionId: paid.transactionId, providerRef: "po_1" });
    expect(await creatorBalances(db, ready, cur)).toMatchObject({ liabilityCents: 0, reservedCents: 0 });
    await expect(postPayout(db, { payoutId: byUser.get(unready)!.id, paidAt: new Date() })).rejects.toThrow(
      PayoutStateError,
    );
    await expect(cancelPayout(db, { payoutId: row.id, at: new Date() })).rejects.toThrow(PayoutStateError);
  });

  test("a chargeback after batching cannot touch reserved money; the payout still goes through", async () => {
    const cur = "nzd";
    const creator = await makeUser();
    await db.insert(s.payoutAccounts).values({ userId: creator, provider: "stripe", payoutsEnabled: true });
    const p = paymentSucceeded({
      paymentId: uuidv7(),
      paymentKind: "tip",
      provider: "stripe",
      creatorUserId: creator,
      grossCents: 5000,
      taxCents: 0,
      feeCents: 0,
      currency: cur,
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: daysAgo(30),
    });
    await post(db, p);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur });
    await runPayoutBatch(db, { ...jan, currency: cur, minimumCents: 100 });
    await postReversal(db, reverse("chargeback", p.refId!, 2000));
    expect(await creatorBalances(db, creator, cur)).toMatchObject({
      liabilityCents: 0,
      receivableCents: 1800,
      reservedCents: 4500,
    });
    const [row] = await db.select().from(s.payouts).where(eq(s.payouts.userId, creator));
    const r = await postPayout(db, { payoutId: row!.id, paidAt: new Date() });
    expect(r.created).toBe(true);
    // The receivable is netted against the next earnings.
    await earn(creator, 5000, cur);
    const next = await runPayoutBatch(db, { ...feb, currency: cur, minimumCents: 100 });
    expect(next.totalCents).toBe(4500 - 1800);
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ receivableCents: 0, liabilityCents: 0 });
  });

  test("cancelling a payout releases the reservation and restores a netted receivable", async () => {
    const cur = "chf";
    const creator = await makeUser();
    await earn(creator, 5000, cur);
    // A receivable of 300 exists before the batch.
    await post(db, {
      kind: "infrastructure_cost",
      description: "test receivable",
      refType: null,
      refId: null,
      idempotencyKey: `recv:${uuidv7()}`,
      currency: cur,
      occurredAt: new Date(),
      metadata: {},
      entries: [
        { code: accounts.creatorReceivable(creator), amountCents: 300 },
        { code: accounts.cash("stripe"), amountCents: -300 },
      ],
    });
    await runPayoutBatch(db, { ...jan, currency: cur, minimumCents: 100 });
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ reservedCents: 4200, receivableCents: 0 });
    const [row] = await db.select().from(s.payouts).where(eq(s.payouts.userId, creator));
    await cancelPayout(db, { payoutId: row!.id, at: new Date(), reason: "provider_rejected" });
    expect(await creatorBalances(db, creator, cur)).toEqual({
      liabilityCents: 4500,
      holdCents: 0,
      receivableCents: 300,
      reservedCents: 0,
      availableCents: 4200,
    });
    const [after] = await db.select().from(s.payouts).where(eq(s.payouts.id, row!.id));
    expect(after).toMatchObject({ status: "failed", holdReason: "provider_rejected" });
    expect(await cancelPayout(db, { payoutId: row!.id, at: new Date() })).toMatchObject({ created: false });
    await expect(postPayout(db, { payoutId: row!.id, paidAt: new Date() })).rejects.toThrow(PayoutStateError);
  });

  test("a batch racing a payout send on another connection never pays the same money twice", async () => {
    const cur = "dkk";
    const other = createDb({ url: t.appUrl, max: 2 });
    try {
      const creator = await makeUser();
      await db.insert(s.payoutAccounts).values({ userId: creator, provider: "stripe", payoutsEnabled: true });
      await earn(creator, 5000, cur);
      await runPayoutBatch(db, { ...jan, currency: cur, minimumCents: 100 });
      const [row] = await db.select().from(s.payouts).where(eq(s.payouts.userId, creator));
      await Promise.all([
        postPayout(other.db, { payoutId: row!.id, paidAt: new Date() }),
        runPayoutBatch(db, { ...feb, currency: cur, minimumCents: 100 }),
      ]);
      const all = await db.select().from(s.payouts).where(eq(s.payouts.userId, creator));
      expect(all.reduce((sum, p) => sum + p.amountCents, 0)).toBe(4500);
      expect(await creatorBalances(db, creator, cur)).toMatchObject({ liabilityCents: 0, reservedCents: 0 });
    } finally {
      await other.close();
    }
  });

  test("concurrent batches for the same period on two connections reserve once", async () => {
    const cur = "nok";
    const other = createDb({ url: t.appUrl, max: 2 });
    try {
      const creator = await makeUser();
      await earn(creator, 5000, cur);
      const [a, b] = await Promise.all([
        runPayoutBatch(db, { ...jan, currency: cur, minimumCents: 100 }),
        runPayoutBatch(other.db, { ...jan, currency: cur, minimumCents: 100 }),
      ]);
      expect(a.held + b.held).toBe(1);
      expect(await creatorBalances(db, creator, cur)).toMatchObject({ liabilityCents: 0, reservedCents: 4500 });
    } finally {
      await other.close();
    }
  });
});

describe("payouts count only what was available at period end", () => {
  const at = (iso: string) => new Date(iso);
  const JAN = { periodStart: at("2026-01-01T00:00:00Z"), periodEnd: at("2026-02-01T00:00:00Z") };
  const FEB = { periodStart: at("2026-02-01T00:00:00Z"), periodEnd: at("2026-03-01T00:00:00Z") };
  const HOLD = 7;

  async function earnAt(creator: string, gross: number, cur: string, when: string): Promise<string> {
    const p = paymentSucceeded({
      paymentId: uuidv7(),
      paymentKind: "tip",
      provider: "stripe",
      creatorUserId: creator,
      grossCents: gross,
      taxCents: 0,
      feeCents: 0,
      currency: cur,
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: at(when),
    });
    await post(db, p);
    return p.refId!;
  }
  const release = (cur: string, asOf: string) => releaseDueHolds(db, { asOf: at(asOf), holdDays: HOLD, currency: cur });

  /** The creator's liability (owed, natural terms) counting postings dated at or before `asOf`. */
  async function owedAsOf(creator: string, cur: string, asOf: Date): Promise<number> {
    const rows = await db.execute<{ total: string }>(sql`
      select coalesce(sum(e.amount_cents), 0)::text as total
      from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      join ledger_transactions t on t.id = e.transaction_id
      where a.code = ${storedCode(accounts.creator(creator), cur)} and t.occurred_at <= ${asOf.toISOString()}::timestamptz`);
    return 0 - Number(rows[0]!.total);
  }
  async function payoutsOf(creator: string) {
    return (await db.select().from(s.payouts).where(eq(s.payouts.userId, creator))).sort(
      (a, b) => a.periodStart.getTime() - b.periodStart.getTime(),
    );
  }

  test("a run on the 5th leaves holds released on the 3rd for the next month, and reruns are idempotent", async () => {
    const cur = "sgd";
    const creator = await makeUser();
    await earnAt(creator, 5000, cur, "2026-01-10T12:00:00Z"); // due Jan 17
    await earnAt(creator, 2000, cur, "2026-01-27T12:00:00Z"); // due Feb 3
    await release(cur, "2026-01-20T00:00:00Z");
    await release(cur, "2026-02-03T12:00:00Z");
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ liabilityCents: 4500 + 1800, holdCents: 0 });

    // On Feb 5 the treasurer runs January.
    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r).toMatchObject({ held: 1, totalCents: 4500 });
    const [janPayout] = await payoutsOf(creator);
    expect(janPayout).toMatchObject({ amountCents: 4500, status: "held" });
    const [reserve] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `payout-reserve:${janPayout!.id}`));
    expect(reserve?.occurredAt.toISOString()).toBe(JAN.periodEnd.toISOString());
    // January closes with nothing owed and never overdrawn; Feb 3's release is still available.
    expect(await owedAsOf(creator, cur, JAN.periodEnd)).toBe(0);
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ liabilityCents: 1800, reservedCents: 4500 });

    // Rerunning January (even after more releases) reserves nothing more.
    await earnAt(creator, 1000, cur, "2026-01-30T00:00:00Z"); // due Feb 6
    await release(cur, "2026-02-06T00:00:00Z");
    expect(await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 })).toMatchObject({
      created: 0,
      held: 0,
      totalCents: 0,
    });
    expect(await payoutsOf(creator)).toHaveLength(1);

    // February's run picks up everything released in February.
    const next = await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 });
    expect(next.totalCents).toBe(1800 + 900);
    expect((await payoutsOf(creator)).map((p) => p.amountCents)).toEqual([4500, 2700]);
    expect(await owedAsOf(creator, cur, FEB.periodEnd)).toBe(0);
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ liabilityCents: 0, reservedCents: 7200 });
  });

  test("a release is dated when it fell due, so a late release job still counts for the month", async () => {
    const cur = "pln";
    const creator = await makeUser();
    const late = await earnAt(creator, 3000, cur, "2026-01-20T00:00:00Z"); // due Jan 27
    // The release job did not run until Feb 4.
    await release(cur, "2026-02-04T00:00:00Z");
    const [rel] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `hold-release:${late}`));
    expect(rel?.occurredAt.toISOString()).toBe("2026-01-27T00:00:00.000Z");
    expect(await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 })).toMatchObject({
      totalCents: 2700,
    });
  });

  test("a hold due exactly at periodEnd counts; one due a millisecond later does not", async () => {
    const cur = "czk";
    const creator = await makeUser();
    await earnAt(creator, 1000, cur, "2026-01-25T00:00:00Z"); // due Feb 1 00:00:00.000
    await earnAt(creator, 2000, cur, "2026-01-25T00:00:00.001Z"); // due Feb 1 00:00:00.001
    await release(cur, "2026-02-02T00:00:00Z");
    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r.totalCents).toBe(900);
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ liabilityCents: 1800, reservedCents: 900 });
    expect((await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 })).totalCents).toBe(1800);
  });

  test("a receivable owed after periodEnd is not netted into that month; the next run nets it", async () => {
    const cur = "hkd";
    const creator = await makeUser();
    await earnAt(creator, 5000, cur, "2026-01-10T00:00:00Z");
    await release(cur, "2026-01-20T00:00:00Z");
    // A clawback shortfall booked on Feb 3.
    await post(db, {
      kind: "infrastructure_cost",
      description: "test receivable",
      refType: null,
      refId: null,
      idempotencyKey: `recv:${uuidv7()}`,
      currency: cur,
      occurredAt: at("2026-02-03T00:00:00Z"),
      metadata: {},
      entries: [
        { code: accounts.creatorReceivable(creator), amountCents: 300 },
        { code: accounts.cash("stripe"), amountCents: -300 },
      ],
    });

    await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    const [janPayout] = await payoutsOf(creator);
    // Never more than is available today, but January's books do not net February's receivable.
    expect(janPayout?.amountCents).toBe(4200);
    const [reserve] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `payout-reserve:${janPayout!.id}`));
    expect(reserve?.metadata).toMatchObject({ amountCents: 4200, receivableNettedCents: 0 });
    expect(await creatorBalances(db, creator, cur)).toMatchObject({
      liabilityCents: 300,
      receivableCents: 300,
      reservedCents: 4200,
      availableCents: 0,
    });
    expect(await owedAsOf(creator, cur, JAN.periodEnd)).toBe(300);

    // February's earnings net the receivable.
    await earnAt(creator, 1000, cur, "2026-02-05T00:00:00Z");
    await release(cur, "2026-02-20T00:00:00Z");
    const next = await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 });
    expect(next.totalCents).toBe(900);
    expect(await creatorBalances(db, creator, cur)).toMatchObject({
      liabilityCents: 0,
      receivableCents: 0,
      reservedCents: 4200 + 900,
    });
  });

  /** The creator's running available balance (liability − receivable) at every posting date. */
  async function runningAvailable(creator: string, cur: string): Promise<{ at: string; cents: number }[]> {
    const rows = await db.execute<{ at: Date | string; running: string }>(sql`
      with d as (
        select t.occurred_at as at, -sum(e.amount_cents) as delta
        from ledger_entries e
        join ledger_accounts a on a.id = e.account_id
        join ledger_transactions t on t.id = e.transaction_id
        where a.code in (${storedCode(accounts.creator(creator), cur)}, ${storedCode(accounts.creatorReceivable(creator), cur)})
        group by t.occurred_at
      )
      select at, (sum(delta) over (order by at))::text as running from d order by at`);
    return [...rows].map((r) => ({ at: new Date(r.at).toISOString(), cents: Number(r.running) }));
  }
  async function expectNeverOverdrawn(creator: string, cur: string) {
    const points = await runningAvailable(creator, cur);
    expect(points.length).toBeGreaterThan(0);
    expect(points.filter((p) => p.cents < 0)).toEqual([]);
  }

  test("a late run for January after February's run reserves only what stayed available since", async () => {
    const cur = "ron";
    const creator = await makeUser();
    await earnAt(creator, 5000, cur, "2026-01-10T00:00:00Z"); // 4500, due Jan 17
    await release(cur, "2026-01-20T00:00:00Z");
    expect((await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 })).totalCents).toBe(4500);
    // Another lot released after February's end (due Mar 5).
    await earnAt(creator, 1000, cur, "2026-02-26T00:00:00Z");
    await release(cur, "2026-03-06T00:00:00Z");
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ availableCents: 900 });

    // January ended with 4500 available, but February took all of it on Mar 1: nothing is left
    // for January, even though 900 is available today.
    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r.totalCents).toBe(0);
    expect(r.carriedOver).toContainEqual({ userId: creator, availableCents: 0 });
    expect(await payoutsOf(creator)).toHaveLength(1);
    await expectNeverOverdrawn(creator, cur);
  });

  test("a chargeback after periodEnd drains the balance before a later release refills it: reserves 0", async () => {
    const cur = "bgn";
    const creator = await makeUser();
    const first = await earnAt(creator, 2000, cur, "2026-01-10T00:00:00Z"); // 1800, due Jan 17
    await earnAt(creator, 2000, cur, "2026-01-30T00:00:00Z"); // 1800, due Feb 6
    await release(cur, "2026-01-20T00:00:00Z");
    // Feb 3: charged back; the 1800 comes out of released earnings.
    await postReversal(db, {
      kind: "chargeback",
      disputeId: uuidv7(),
      paymentId: first,
      amountCents: 2000,
      occurredAt: at("2026-02-03T00:00:00Z"),
      disputeFeeCents: 0,
    });
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ liabilityCents: 0, holdCents: 1800 });
    await release(cur, "2026-02-07T00:00:00Z");
    expect(await creatorBalances(db, creator, cur)).toMatchObject({ availableCents: 1800 });

    // 1800 at Jan's end and 1800 today, but 0 on Feb 3: January reserves nothing.
    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r.totalCents).toBe(0);
    expect(await payoutsOf(creator)).toHaveLength(0);
    await expectNeverOverdrawn(creator, cur);
    // February gets it.
    expect((await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 })).totalCents).toBe(1800);
    await expectNeverOverdrawn(creator, cur);
  });

  test("releaseDueHolds refuses an asOf in the future", async () => {
    await expect(
      releaseDueHolds(db, { asOf: new Date(Date.now() + 2 * 60_000), holdDays: 7, currency: "usd" }),
    ).rejects.toThrow(RangeError);
  });

  test("a later month's reservation caps an earlier month run afterwards", async () => {
    const cur = "isk";
    const creator = await makeUser();
    await earnAt(creator, 5000, cur, "2026-01-10T00:00:00Z");
    await release(cur, "2026-01-20T00:00:00Z");
    expect((await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 })).totalCents).toBe(4500);
    // January's balance at its end was 4500, but February already reserved it.
    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r.totalCents).toBe(0);
    expect(r.carriedOver).toContainEqual({ userId: creator, availableCents: 0 });
    expect(await payoutsOf(creator)).toHaveLength(1);
  });
});

describe("period close", () => {
  test("closes revenue and expenses into retained surplus, idempotently, refusing overlaps", async () => {
    const cur = "jpy";
    const creator = await makeUser();
    const start = new Date("2025-05-01T00:00:00Z");
    const end = new Date("2025-06-01T00:00:00Z");
    await post(
      db,
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "tip",
        provider: "stripe",
        creatorUserId: creator,
        grossCents: 100_000,
        taxCents: 0,
        feeCents: 2000,
        currency: cur,
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: new Date("2025-05-10T00:00:00Z"),
      }),
    );
    await post(
      db,
      infrastructureCost({
        infraCostId: uuidv7(),
        category: "hosting",
        provider: "stripe",
        amountCents: 3000,
        currency: cur,
        occurredAt: new Date("2025-05-20T00:00:00Z"),
      }),
    );
    const before = await retainedSurplus(db, cur);
    const r = await closePeriod(db, { periodStart: start, periodEnd: end, currency: cur });
    expect(r).toMatchObject({ created: true, surplusCents: 10_000 - 2000 - 3000 });
    expect((await retainedSurplus(db, cur)) - before).toBe(5000);
    expect(await rawBalance(db, accounts.platformCut(), cur)).toBe(0);
    expect(await rawBalance(db, accounts.paymentFees(), cur)).toBe(0);
    expect(await closePeriod(db, { periodStart: start, periodEnd: end, currency: cur })).toEqual({
      transactionId: r.transactionId,
      created: false,
      surplusCents: 5000,
    });
    await expect(
      closePeriod(db, {
        periodStart: new Date("2025-05-15T00:00:00Z"),
        periodEnd: new Date("2025-06-15T00:00:00Z"),
        currency: cur,
      }),
    ).rejects.toThrow(PeriodCloseError);
    // An empty period closes to nothing.
    expect(
      await closePeriod(db, { periodStart: end, periodEnd: new Date("2025-07-01T00:00:00Z"), currency: cur }),
    ).toEqual({ transactionId: null, created: false, surplusCents: 0 });
    // Closing entries are not activity on the transparency page.
    const [may] = await monthlyAggregates(db, { from: start, to: end, currency: cur });
    expect(may).toMatchObject({ platformCutCents: 10_000, totalCostsCents: 5000, surplusCents: 5000 });
  });
});

describe("statements and transparency", () => {
  test("statement pages are complete, ordered and stable", async () => {
    const creator = await makeUser();
    const base = Date.parse("2026-04-01T00:00:00Z");
    for (let i = 0; i < 7; i++) await post(db, payment(creator, 1000 + i, new Date(base + i * 3_600_000)));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await statement(db, creator, { cursor, limit: 3 });
      for (const line of page.items) {
        expect(line.account).toBe(accounts.creatorHold(creator));
        expect(line.amount.currency).toBe("usd");
        seen.push(line.entryId);
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const all = await statement(db, creator, { limit: 100 });
    expect(all.items.map((l) => l.entryId)).toEqual(seen);
    expect(all.items[0]!.amount.cents).toBe(-Math.floor(1006 * 0.9));
    const times = all.items.map((l) => l.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    await expect(statement(db, creator, { cursor: "garbage" })).rejects.toThrow(RangeError);
  });

  test("monthly aggregates agree with the postings", async () => {
    // A separate currency isolates this test from the others' postings.
    const creator = await makeUser();
    const cur = "cad";
    const jan = new Date("2025-01-10T00:00:00Z");
    const feb = new Date("2025-02-10T00:00:00Z");
    const mk = (gross: number, at: Date, fee = 0) =>
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "tip",
        provider: "stripe",
        creatorUserId: creator,
        grossCents: gross,
        taxCents: 100,
        feeCents: fee,
        currency: cur,
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: at,
      });
    const p1 = mk(10_100, jan, 300);
    await post(db, p1);
    await post(db, mk(5_100, feb));
    await post(
      db,
      infrastructureCost({
        infraCostId: uuidv7(),
        category: "hosting",
        provider: "stripe",
        amountCents: 400,
        currency: cur,
        occurredAt: jan,
      }),
    );
    await postReversal(db, {
      kind: "refund",
      disputeId: uuidv7(),
      paymentId: p1.refId!,
      amountCents: 10_100,
      occurredAt: feb,
    });
    await post(
      db,
      patronageAllocation({
        periodId: uuidv7(),
        currency: cur,
        occurredAt: feb,
        allocations: [{ userId: creator, amountCents: 50 }],
      }),
    );

    const months = await monthlyAggregates(db, {
      from: new Date("2025-01-01Z"),
      to: new Date("2025-03-01Z"),
      currency: cur,
    });
    expect(months).toEqual([
      {
        month: "2025-01",
        currency: cur,
        revenueCents: 10_000,
        platformCutCents: 1000,
        streamerPayoutsCents: 0,
        costs: [
          { category: "infrastructure:hosting", cents: 400 },
          { category: "payment-fees", cents: 300 },
        ],
        totalCostsCents: 700,
        surplusCents: 300,
        patronageDistributedCents: 0,
      },
      {
        month: "2025-02",
        currency: cur,
        revenueCents: 5000 - 10_000,
        platformCutCents: 500 - 1000,
        streamerPayoutsCents: 0,
        costs: [],
        totalCostsCents: 0,
        surplusCents: -500,
        patronageDistributedCents: 50,
      },
    ]);
    expect(await rawBalance(db, accounts.taxPayable(), cur)).toBe(-100);
  });
});

describe("account creation under concurrency", () => {
  test("parallel postings over overlapping account sets in different orders do not deadlock", async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const cur = "huf";
    const postings = Array.from({ length: 12 }, (_, i) => {
      const order = i % 2 === 0 ? users : [...users].reverse();
      return {
        kind: "patronage_allocation" as const,
        description: "test",
        refType: null,
        refId: null,
        idempotencyKey: `deadlock:${uuidv7()}`,
        currency: cur,
        occurredAt: new Date(),
        metadata: {},
        entries: [
          { code: accounts.retainedSurplus(), amountCents: order.length },
          ...order.map((u) => ({ code: accounts.patronagePayable(u), amountCents: -1 })),
        ],
      };
    });
    const results = await Promise.all(postings.map((p) => post(db, p)));
    expect(results.every((r) => r.created)).toBe(true);
    expect(await rawBalance(db, accounts.retainedSurplus(), cur)).toBe(72);
  });
});

describe("settings", () => {
  test("reads the seeded money settings", async () => {
    const m = await loadMoneySettings(db);
    expect(m.cut).toEqual({ streamerShare: 0.9, coopShare: 0.1 });
    expect(m.payoutRules).toMatchObject({ minimumCents: 2500, holdDays: 7, currency: "usd" });
  });

  test("cutHistoryId is null on a fresh seed and the newest platform.cut history id after a change", async () => {
    expect((await loadMoneySettings(db)).cutHistoryId).toBeNull();
    // A passed proposal is the only way to change the cut; here the owner skips the guard in a
    // transaction that is rolled back, so the history trigger writes the row as it would.
    const done = new Error("rolled back");
    const run = t.db.transaction(async (tx) => {
      await tx.execute(sql`alter table governance_settings disable trigger governance_settings_guard`);
      const change = async (cut: { streamerShare: number; coopShare: number }) => {
        await tx.update(s.governanceSettings).set({ value: cut }).where(eq(s.governanceSettings.key, "platform.cut"));
        const [h] = await tx
          .select({ id: s.governanceSettingsHistory.id })
          .from(s.governanceSettingsHistory)
          .where(eq(s.governanceSettingsHistory.key, "platform.cut"))
          .orderBy(sql`changed_at desc`)
          .limit(1);
        return h!.id;
      };
      await change({ streamerShare: 0.85, coopShare: 0.15 });
      const newest = await change({ streamerShare: 0.8, coopShare: 0.2 });
      const m = await loadMoneySettings(tx);
      expect(m.cutHistoryId).toBe(newest);
      expect(m.cut).toEqual({ streamerShare: 0.8, coopShare: 0.2 });
      throw done;
    });
    await expect(run).rejects.toBe(done);
    expect((await loadMoneySettings(db)).cutHistoryId).toBeNull();
  });
});
