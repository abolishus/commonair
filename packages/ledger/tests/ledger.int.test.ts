// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ledger against a real database, through the least-privilege application role
 * (`t.app.db`) that services use in production.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  DEFAULT_PLATFORM_CUT,
  IdempotencyConflictError,
  InsufficientBalanceError,
  PAYOUT_ACCOUNT_NOT_READY,
  accountBalance,
  accounts,
  chargeback,
  creatorBalances,
  ensureAccounts,
  getOrCreateAccount,
  infrastructureCost,
  loadMoneySettings,
  monthlyAggregates,
  patronageAllocation,
  paymentHoldRemaining,
  paymentSucceeded,
  post,
  postPayout,
  rawBalance,
  refund,
  releaseDueHolds,
  runPayoutBatch,
  statement,
  storedCode,
} from "../src/index.ts";

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
    expect(b).toEqual({ liabilityCents: 0, holdCents: 900, receivableCents: 0, availableCents: 0 });
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

describe("refunds, chargebacks and holds", () => {
  test("partial then full refund reverses exactly the original split", async () => {
    const creator = await makeUser();
    const p = payment(creator, 1099, new Date(), { tax: 99 });
    const orig = await post(db, p);
    let already = 0;
    for (const amount of [333, 766]) {
      const balances = await creatorBalances(db, creator, "usd");
      const own = await paymentHoldRemaining(db, p.refId!, creator, "usd");
      await post(
        db,
        refund({
          disputeId: uuidv7(),
          paymentId: p.refId!,
          originalTransactionId: orig.transactionId,
          provider: "stripe",
          creatorUserId: creator,
          currency: "usd",
          occurredAt: new Date(),
          original: { grossCents: 1099, taxCents: 99 },
          cut: DEFAULT_PLATFORM_CUT,
          alreadyReversedCents: already,
          amountCents: amount,
          balances: { liabilityCents: balances.liabilityCents, holdCents: balances.holdCents, paymentHoldCents: own },
        }),
      );
      already += amount;
    }
    expect(await creatorBalances(db, creator, "usd")).toEqual({
      liabilityCents: 0,
      holdCents: 0,
      receivableCents: 0,
      availableCents: 0,
    });
    expect(await paymentHoldRemaining(db, p.refId!, creator, "usd")).toBe(0);
  });

  test("hold release, then a chargeback with insufficient balance books a receivable", async () => {
    const creator = await makeUser();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    const p = payment(creator, 10_000, tenDaysAgo);
    await post(db, p);

    const released = await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" });
    expect(released.released).toBeGreaterThanOrEqual(1);
    expect(await creatorBalances(db, creator, "usd")).toMatchObject({ liabilityCents: 9000, holdCents: 0 });
    // Re-running releases nothing more for this payment.
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" });
    expect((await creatorBalances(db, creator, "usd")).liabilityCents).toBe(9000);

    // Pay most of it out, then the payment is charged back in full.
    await post(db, {
      ...p,
      kind: "payout",
      description: "Creator payout",
      refType: "payout",
      refId: uuidv7(),
      idempotencyKey: `payout:${uuidv7()}`,
      metadata: {},
      entries: [
        { code: accounts.creator(creator), amountCents: 8000 },
        { code: accounts.cash("stripe"), amountCents: -8000 },
      ],
    });
    const b = await creatorBalances(db, creator, "usd");
    await post(
      db,
      chargeback({
        disputeId: uuidv7(),
        paymentId: p.refId!,
        provider: "stripe",
        creatorUserId: creator,
        currency: "usd",
        occurredAt: new Date(),
        original: { grossCents: 10_000, taxCents: 0 },
        cut: DEFAULT_PLATFORM_CUT,
        alreadyReversedCents: 0,
        amountCents: 10_000,
        balances: { liabilityCents: b.liabilityCents, holdCents: b.holdCents, paymentHoldCents: 0 },
        disputeFeeCents: 1500,
      }),
    );
    expect(await creatorBalances(db, creator, "usd")).toEqual({
      liabilityCents: 0,
      holdCents: 0,
      receivableCents: 8000,
      availableCents: -8000,
    });
  });
});

describe("payout batch", () => {
  test("creates rows for creators above the minimum, holds unready accounts, and is idempotent", async () => {
    const minimumCents = 2500;
    const ready = await makeUser();
    const unready = await makeUser();
    const small = await makeUser();
    await db.insert(s.payoutAccounts).values({ userId: ready, provider: "stripe", payoutsEnabled: true });
    const old = new Date(Date.now() - 30 * 86_400_000);
    for (const [u, gross] of [
      [ready, 5000],
      [unready, 4000],
      [small, 1000],
    ] as const) {
      await post(db, payment(u, gross, old));
    }
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" });

    const periodStart = new Date("2026-01-01T00:00:00Z");
    const periodEnd = new Date("2026-02-01T00:00:00Z");
    const r1 = await runPayoutBatch(db, { periodStart, periodEnd, currency: "usd", minimumCents });
    const rows = await db.select().from(s.payouts).where(eq(s.payouts.periodStart, periodStart));
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(ready)).toMatchObject({ amountCents: 4500, status: "pending", provider: "stripe" });
    expect(byUser.get(unready)).toMatchObject({
      amountCents: 3600,
      status: "held",
      holdReason: PAYOUT_ACCOUNT_NOT_READY,
    });
    expect(byUser.has(small)).toBe(false);
    expect(r1.carriedOver.some((c) => c.userId === small && c.availableCents === 900)).toBe(true);

    const r2 = await runPayoutBatch(db, { periodStart, periodEnd, currency: "usd", minimumCents });
    expect(r2.created + r2.held).toBe(0);
    // A later period does not pay the scheduled-but-unposted amount twice.
    const r3 = await runPayoutBatch(db, {
      periodStart: periodEnd,
      periodEnd: new Date("2026-03-01T00:00:00Z"),
      currency: "usd",
      minimumCents,
    });
    const later = await db.select().from(s.payouts).where(eq(s.payouts.periodStart, periodEnd));
    expect(later.some((p) => p.userId === ready || p.userId === unready)).toBe(false);
    expect(r3.carriedOver.find((c) => c.userId === ready)?.availableCents).toBe(0);

    // Paying it posts the ledger and is idempotent.
    const row = byUser.get(ready)!;
    const paid = await postPayout(db, { payoutId: row.id, paidAt: new Date(), minimumCents, providerRef: "po_1" });
    expect(paid.created).toBe(true);
    const again = await postPayout(db, { payoutId: row.id, paidAt: new Date(), minimumCents });
    expect(again).toEqual({ transactionId: paid.transactionId, created: false });
    const [after] = await db.select().from(s.payouts).where(eq(s.payouts.id, row.id));
    expect(after).toMatchObject({ status: "paid", ledgerTransactionId: paid.transactionId, providerRef: "po_1" });
    expect((await creatorBalances(db, ready, "usd")).liabilityCents).toBe(0);
  });

  test("posting a payout fails if a clawback since the batch left too little", async () => {
    const creator = await makeUser();
    await db.insert(s.payoutAccounts).values({ userId: creator, provider: "stripe", payoutsEnabled: true });
    const p = payment(creator, 5000, new Date(Date.now() - 30 * 86_400_000));
    await post(db, p);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" });
    const periodStart = new Date("2025-06-01T00:00:00Z");
    await runPayoutBatch(db, {
      periodStart,
      periodEnd: new Date("2025-07-01T00:00:00Z"),
      currency: "usd",
      minimumCents: 100,
    });
    const [row] = await db.select().from(s.payouts).where(eq(s.payouts.userId, creator));
    const b = await creatorBalances(db, creator, "usd");
    await post(
      db,
      chargeback({
        disputeId: uuidv7(),
        paymentId: p.refId!,
        provider: "stripe",
        creatorUserId: creator,
        currency: "usd",
        occurredAt: new Date(),
        original: { grossCents: 5000, taxCents: 0 },
        cut: DEFAULT_PLATFORM_CUT,
        alreadyReversedCents: 0,
        amountCents: 2000,
        balances: { liabilityCents: b.liabilityCents, holdCents: b.holdCents, paymentHoldCents: 0 },
        disputeFeeCents: 0,
      }),
    );
    await expect(postPayout(db, { payoutId: row!.id, paidAt: new Date(), minimumCents: 100 })).rejects.toThrow(
      InsufficientBalanceError,
    );
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
    await post(
      db,
      refund({
        disputeId: uuidv7(),
        paymentId: p1.refId!,
        provider: "stripe",
        creatorUserId: creator,
        currency: cur,
        occurredAt: feb,
        original: { grossCents: 10_100, taxCents: 100 },
        cut: DEFAULT_PLATFORM_CUT,
        alreadyReversedCents: 0,
        amountCents: 10_100,
        balances: { liabilityCents: 0, holdCents: 9000, paymentHoldCents: 9000 },
      }),
    );
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

describe("settings", () => {
  test("reads the seeded money settings", async () => {
    const m = await loadMoneySettings(db);
    expect(m.cut).toEqual({ streamerShare: 0.9, coopShare: 0.1 });
    expect(m.payoutRules).toMatchObject({ minimumCents: 2500, holdDays: 7, currency: "usd" });
  });
});
