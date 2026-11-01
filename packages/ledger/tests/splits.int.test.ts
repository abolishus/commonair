// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ledger splits (ADR 0013) against a real database, as the application role: per-recipient hold
 * release (one key each, idempotent, a ban withholds only that recipient's lot), the new-recipient
 * extra hold, the clawback policy, a won chargeback restoring each slice, split-shortfall netting,
 * the crew `new_payee` check, the 0043 triggers refusing bad rows, and a reversal racing a payout
 * batch without deadlock. Every test ends with the ledger summing to zero.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { type Database, type Executor, schema as s, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  DEFAULT_PLATFORM_CUT,
  type PaymentSplit,
  accounts,
  cancelPayout,
  creatorBalances,
  holdMemo,
  paymentHoldRemaining,
  paymentSucceeded,
  post,
  postChargebackReversal,
  postReversal,
  rawBalance,
  releaseDueHolds,
  runPayoutBatch,
  splitShortfallWriteOff,
  splitSuspenseByOwner,
  splitSuspenseMonthly,
  splitSuspenseRelease,
  storedCode,
} from "../src/index.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDatabase;
let db: Database;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});
afterEach(async () => {
  // Every posting balances: the whole ledger sums to zero in every currency.
  const rows = await db.execute<{ currency: string; total: string }>(
    sql`select currency, sum(amount_cents)::text as total from ledger_entries group by currency`,
  );
  const unbalanced = [...rows].filter((r) => Number(r.total) !== 0);
  if (unbalanced.length > 0) throw new Error(`the ledger does not sum to zero: ${JSON.stringify(unbalanced)}`);
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
type Role = (typeof s.users.$inferInsert)["role"];

async function makeUser(role: Role = "user"): Promise<string> {
  const name = `split${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, role })
    .returning({ id: s.users.id });
  return u!.id;
}

let currencies = 0;
/** A fresh currency per test, so releases and batches see only that test's lots. */
const freshCurrency = () =>
  `s${String.fromCharCode(97 + Math.floor(currencies / 26))}${String.fromCharCode(97 + (currencies++ % 26))}`;

/** A tip from the owner's channel, split with `crew` (bps), posted at `at`. */
async function tip(
  ownerId: string,
  gross: number,
  cur: string,
  at: Date,
  crew: { userId: string; bps: number }[] = [],
  versionId = uuidv7(),
): Promise<string> {
  const paymentId = uuidv7();
  const split: PaymentSplit | null = crew.length ? { versionId, crew } : null;
  await post(
    db,
    paymentSucceeded({
      paymentId,
      paymentKind: "tip",
      provider: "stripe",
      creatorUserId: ownerId,
      grossCents: gross,
      taxCents: 0,
      feeCents: 0,
      currency: cur,
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: at,
      split,
    }),
  );
  return paymentId;
}

const releaseKey = async (paymentId: string, userId: string) => {
  const [row] = await db
    .select({ id: s.ledgerTransactions.id, at: s.ledgerTransactions.occurredAt, meta: s.ledgerTransactions.metadata })
    .from(s.ledgerTransactions)
    .where(eq(s.ledgerTransactions.idempotencyKey, `hold-release:${paymentId}:${userId}`));
  return row ?? null;
};

const dispute = (kind: "refund" | "chargeback", paymentId: string, amountCents: number) => ({
  kind,
  disputeId: uuidv7(),
  paymentId,
  amountCents,
  occurredAt: new Date(),
});

/** Drain released earnings (a payout sent out of band), so a clawback finds nothing there. */
async function drain(userId: string, cents: number, cur: string) {
  await post(db, {
    kind: "payout",
    description: "test drain",
    refType: null,
    refId: null,
    idempotencyKey: `drain:${uuidv7()}`,
    currency: cur,
    occurredAt: new Date(),
    metadata: {},
    entries: [
      { code: accounts.creator(userId), amountCents: cents },
      { code: accounts.cash("stripe"), amountCents: -cents },
    ],
  });
}

describe("per-recipient hold release (ADR 0013 decision 1)", () => {
  test("one release per recipient, keyed by recipient; a rerun releases nothing", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const p = await tip(o, 1000, cur, daysAgo(10), [
      { userId: a, bps: 2000 },
      { userId: b, bps: 1000 },
    ]);
    const r = await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    expect(r).toEqual({ released: 3, totalCents: 900, withheld: 0 });
    for (const [u, cents] of [
      [o, 630],
      [a, 180],
      [b, 90],
    ] as const) {
      expect(await releaseKey(p, u)).not.toBeNull();
      expect((await creatorBalances(db, u, cur)).liabilityCents).toBe(cents);
      expect(await paymentHoldRemaining(db, p, u, cur)).toBe(0);
    }
    expect(
      await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 }),
    ).toEqual({ released: 0, totalCents: 0, withheld: 0 });
  });

  test("one recipient's ban withholds only their lot into split suspense", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const p = await tip(o, 2000, cur, daysAgo(10), [
      { userId: a, bps: 1000 },
      { userId: b, bps: 1000 },
    ]);
    await owner.update(s.users).set({ banned: true }).where(eq(s.users.id, a));
    const r = await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    expect(r).toMatchObject({ released: 3, withheld: 1 });
    expect((await creatorBalances(db, a, cur)).liabilityCents).toBe(0);
    expect(await rawBalance(db, accounts.splitSuspense(a), cur)).toBe(-180);
    expect(await splitSuspenseByOwner(db, a, cur)).toEqual([{ ownerUserId: o, cents: 180 }]);
    expect((await creatorBalances(db, b, cur)).liabilityCents).toBe(180);
    expect((await creatorBalances(db, o, cur)).liabilityCents).toBe(1440);
    expect((await releaseKey(p, a))?.meta).toMatchObject({ withheld: true, role: "crew" });
  });

  test("a legal hold or a deletion withholds too; the owner is never withheld", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    await tip(o, 1000, cur, daysAgo(10), [
      { userId: a, bps: 1000 },
      { userId: b, bps: 1000 },
    ]);
    await owner.insert(s.legalHolds).values({ userId: a, reason: "test" });
    await owner.update(s.users).set({ deletedAt: new Date() }).where(eq(s.users.id, b));
    await owner.update(s.users).set({ banned: true }).where(eq(s.users.id, o));
    const r = await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    expect(r).toMatchObject({ released: 3, withheld: 2 });
    expect((await creatorBalances(db, o, cur)).liabilityCents).toBe(720);
  });

  test("a new crew recipient's first lot waits the extra days; later lots do not", async () => {
    const cur = freshCurrency();
    const [o, a] = [await makeUser(), await makeUser()];
    const crew = [{ userId: a, bps: 1000 }];
    const first = await tip(o, 1000, cur, daysAgo(10), crew);
    const opts = { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 7 };
    expect(await releaseDueHolds(db, opts)).toMatchObject({ released: 1, totalCents: 810 });
    expect(await releaseKey(first, a)).toBeNull();
    // 15 days after the payment the first crew lot is due, dated at payment + 14 days.
    const older = await tip(o, 1000, cur, daysAgo(15), crew);
    expect(await releaseDueHolds(db, opts)).toMatchObject({ released: 2 });
    const rel = await releaseKey(older, a);
    const [paid] = await db
      .select({ at: s.ledgerTransactions.occurredAt })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `payment:${older}`));
    expect(rel?.at.getTime()).toBe(paid!.at.getTime() + 14 * DAY);
    // Now A has a released crew lot: the 10-day-old one needs only the base hold.
    expect(await releaseDueHolds(db, opts)).toMatchObject({ released: 1, totalCents: 90 });
    expect(await releaseKey(first, a)).not.toBeNull();
  });
});

describe("a payout run's release with a live tip still inside the hold", () => {
  test("only the due lots release; the fresh tip's crew lot stays held", async () => {
    // The e4b-money split-release shape: one tip just confirmed, one past hold + extra days.
    const cur = freshCurrency();
    const [o, a] = [await makeUser(), await makeUser()];
    const crew = [{ userId: a, bps: 2000 }];
    const live = await tip(o, 2000, cur, new Date(), crew);
    const old = await tip(o, 2000, cur, daysAgo(15), crew);
    const r = await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 7 });
    expect(r).toMatchObject({ released: 2, totalCents: 1800 });
    expect(await releaseKey(old, a)).not.toBeNull();
    expect(await releaseKey(live, a)).toBeNull();
    expect(await paymentHoldRemaining(db, old, a, cur)).toBe(0);
    expect(await paymentHoldRemaining(db, live, a, cur)).toBe(360);
    expect(await creatorBalances(db, a, cur)).toMatchObject({ liabilityCents: 360, holdCents: 360 });
    expect(await creatorBalances(db, o, cur)).toMatchObject({ liabilityCents: 1440, holdCents: 1440 });
  });
});

describe("clawback (ADR 0013 decision 5)", () => {
  const crewOf = (a: string, b: string) => [
    { userId: a, bps: 2000 },
    { userId: b, bps: 1000 },
  ];

  test("inside the hold every slice comes from its own lot", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const p = await tip(o, 1000, cur, new Date(), crewOf(a, b));
    await postReversal(db, dispute("refund", p, 1000));
    for (const u of [o, a, b]) {
      expect(await creatorBalances(db, u, cur)).toMatchObject({ holdCents: 0, liabilityCents: 0, receivableCents: 0 });
    }
  });

  test("after release the owner absorbs the crew slices; a crew receivable is never created", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const p = await tip(o, 1000, cur, daysAgo(10), crewOf(a, b));
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    await drain(o, 400, cur);
    await postReversal(db, { ...dispute("chargeback", p, 1000), disputeFeeCents: 1500 });
    // Owner: 630 + 270 to cover from 230 released; its own 630 first, so 400 receivable, 270 shortfall.
    expect(await creatorBalances(db, o, cur)).toMatchObject({
      liabilityCents: 0,
      receivableCents: 400,
      splitShortfallCents: 270,
    });
    for (const [u, cents] of [
      [a, 180],
      [b, 90],
    ] as const) {
      expect(await creatorBalances(db, u, cur)).toMatchObject({ liabilityCents: cents, receivableCents: 0 });
      const crewReceivable = await db
        .select({ id: s.ledgerAccounts.id })
        .from(s.ledgerAccounts)
        .where(eq(s.ledgerAccounts.code, storedCode(accounts.creatorReceivable(u), cur)));
      expect(crewReceivable).toEqual([]);
    }

    // A won chargeback cancels the split shortfall first, then the receivable.
    const [cb] = await db
      .select({ ref: s.ledgerTransactions.idempotencyKey })
      .from(s.ledgerTransactions)
      .where(sql`${s.ledgerTransactions.kind} = 'chargeback' and ${s.ledgerTransactions.refId} = ${p}`);
    await postChargebackReversal(db, { disputeId: cb!.ref.slice("chargeback:".length), occurredAt: new Date() });
    expect(await creatorBalances(db, o, cur)).toMatchObject({
      liabilityCents: 230,
      receivableCents: 0,
      splitShortfallCents: 0,
    });
    expect((await creatorBalances(db, a, cur)).liabilityCents).toBe(180);
  });

  test("released and unpaid (below the payout minimum), the owner's released earnings cover its own slice first", async () => {
    // CI run 41295322622 (harness w2 split-clawback): a 2000 tip, crew 20%, both lots released,
    // the payout run reserved nothing (1440 and 360 are under the 2500 minimum).
    const cur = freshCurrency();
    const [o, a] = [await makeUser(), await makeUser()];
    const p = await tip(o, 2000, cur, daysAgo(10), [{ userId: a, bps: 2000 }]);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    const run = await runPayoutBatch(db, {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(),
      currency: cur,
      minimumCents: 2500,
    });
    expect(run.created).toBe(0);
    await postReversal(db, { ...dispute("chargeback", p, 2000), disputeFeeCents: 0 });
    // Owner: 1440 + 360 to cover from 1440 released; its own slice first, so no receivable.
    expect(await creatorBalances(db, o, cur)).toMatchObject({
      liabilityCents: 0,
      holdCents: 0,
      receivableCents: 0,
      splitShortfallCents: 360,
      availableCents: -360,
    });
    expect(await creatorBalances(db, a, cur)).toMatchObject({
      liabilityCents: 360,
      receivableCents: 0,
      splitShortfallCents: 0,
    });

    // The same tip with the owner's released earnings already gone: its own slice is the receivable.
    const o2 = await makeUser();
    const a2 = await makeUser();
    const p2 = await tip(o2, 2000, cur, daysAgo(10), [{ userId: a2, bps: 2000 }]);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    await drain(o2, 1440, cur);
    await postReversal(db, { ...dispute("chargeback", p2, 2000), disputeFeeCents: 0 });
    expect(await creatorBalances(db, o2, cur)).toMatchObject({
      liabilityCents: 0,
      receivableCents: 1440,
      splitShortfallCents: 360,
    });
    expect((await creatorBalances(db, a2, cur)).liabilityCents).toBe(360);
  });

  test("a won chargeback restores each own-lot slice to its recipient's released earnings", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const p = await tip(o, 1000, cur, new Date(), crewOf(a, b));
    const d = dispute("chargeback", p, 1000);
    await postReversal(db, { ...d, disputeFeeCents: 0 });
    for (const u of [o, a, b]) expect((await creatorBalances(db, u, cur)).holdCents).toBe(0);
    await postChargebackReversal(db, { disputeId: d.disputeId, occurredAt: new Date() });
    expect((await creatorBalances(db, o, cur)).liabilityCents).toBe(630);
    expect((await creatorBalances(db, a, cur)).liabilityCents).toBe(180);
    expect((await creatorBalances(db, b, cur)).liabilityCents).toBe(90);
    // The recipients' lots stay closed: nothing is re-held or released twice.
    expect(
      await releaseDueHolds(db, { asOf: new Date(), holdDays: 0, currency: cur, newRecipientHoldDays: 0 }),
    ).toMatchObject({ released: 0 });
  });

  test("a won chargeback sends a withheld crew member's own-lot part to split suspense", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const p = await tip(o, 1000, cur, new Date(), crewOf(a, b));
    const d = dispute("chargeback", p, 1000);
    await postReversal(db, { ...d, disputeFeeCents: 0 });
    await owner.update(s.users).set({ banned: true }).where(eq(s.users.id, a));
    await postChargebackReversal(db, { disputeId: d.disputeId, occurredAt: new Date() });
    expect((await creatorBalances(db, a, cur)).liabilityCents).toBe(0);
    expect(await rawBalance(db, accounts.splitSuspense(a), cur)).toBe(-180);
    expect(await splitSuspenseByOwner(db, a, cur)).toEqual([{ ownerUserId: o, cents: 180 }]);
    expect((await creatorBalances(db, b, cur)).liabilityCents).toBe(90);
    expect((await creatorBalances(db, o, cur)).liabilityCents).toBe(630);
  });

  test("partial refunds, sliced any way, reverse each recipient exactly", async () => {
    const cur = freshCurrency();
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const p = await tip(o, 1003, cur, new Date(), crewOf(a, b));
    for (const amount of [1, 333, 7, 662]) await postReversal(db, dispute("refund", p, amount));
    for (const u of [o, a, b]) expect((await creatorBalances(db, u, cur)).holdCents).toBe(0);
  });
});

describe("split shortfall netting and the crew new_payee check", () => {
  const JAN = { periodStart: new Date("2099-01-01T00:00:00Z"), periodEnd: new Date("2099-02-01T00:00:00Z") };

  test("the owner's next payout nets the split shortfall; a cancel restores it", async () => {
    const cur = freshCurrency();
    const [o, a] = [await makeUser(), await makeUser()];
    const p = await tip(o, 1000, cur, daysAgo(10), [{ userId: a, bps: 5000 }]);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    await drain(o, 450, cur);
    // Owner drained, crew share released: its own 450 is a receivable, the crew's 450 split shortfall.
    await postReversal(db, dispute("refund", p, 1000));
    expect(await creatorBalances(db, o, cur)).toMatchObject({
      receivableCents: 450,
      splitShortfallCents: 450,
      availableCents: -900,
    });
    expect((await creatorBalances(db, a, cur)).liabilityCents).toBe(450);
    // The owner earns again: the payout nets both, the creator receivable first.
    await tip(o, 2000, cur, daysAgo(9));
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    const run = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(run.created + run.held).toBe(2);
    expect(await creatorBalances(db, o, cur)).toMatchObject({
      liabilityCents: 0,
      receivableCents: 0,
      splitShortfallCents: 0,
      reservedCents: 900,
    });
    const [payout] = await db.select().from(s.payouts).where(eq(s.payouts.userId, o));
    const [reserve] = await db
      .select({ meta: s.ledgerTransactions.metadata })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `payout-reserve:${payout!.id}`));
    expect(reserve?.meta).toMatchObject({
      amountCents: 900,
      receivableNettedCents: 450,
      splitShortfallNettedCents: 450,
    });
    await cancelPayout(db, { payoutId: payout!.id, at: new Date() });
    expect(await creatorBalances(db, o, cur)).toMatchObject({
      liabilityCents: 1800,
      receivableCents: 450,
      splitShortfallCents: 450,
      reservedCents: 0,
    });
  });

  test("a crew member's first payout raises new_payee whatever its size", async () => {
    const cur = freshCurrency();
    const [o, a] = [await makeUser(), await makeUser()];
    await tip(o, 300, cur, daysAgo(10), [{ userId: a, bps: 1000 }]);
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 1 });
    const flags = await db.select().from(s.paymentFraudFlags).where(eq(s.paymentFraudFlags.payeeUserId, a));
    expect(flags.map((f) => [f.kind, f.status])).toEqual([["new_payee", "open"]]);
    const [payout] = await db.select().from(s.payouts).where(eq(s.payouts.userId, a));
    expect(payout).toMatchObject({ status: "held", holdReason: "fraud_review", amountCents: 27 });
    // The owner, below the threshold and never crew, is not flagged.
    expect(await db.select().from(s.paymentFraudFlags).where(eq(s.paymentFraudFlags.payeeUserId, o))).toEqual([]);
  });
});

describe("0043 triggers refuse bad rows", () => {
  async function refusedCode(p: PromiseLike<unknown>): Promise<string | undefined> {
    const err = await Promise.resolve(p).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, "expected the database to refuse").toBeInstanceOf(Error);
    const e = err as Error & { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }

  async function acceptedVersion(ownerId: string, crew: string, bps: number) {
    const [c] = await db
      .insert(s.channels)
      .values({ ownerId, slug: `sp${ownerId.slice(-10)}`, displayName: "Split" })
      .returning({ id: s.channels.id });
    const [v] = await db.insert(s.revenueSplits).values({ channelId: c!.id, version: 1, basis: "all" }).returning();
    await db.insert(s.revenueSplitShares).values({ splitId: v!.id, recipientUserId: crew, bps });
    await db.insert(s.revenueSplitAcceptances).values({ splitId: v!.id, recipientUserId: crew, decision: "accepted" });
    await db
      .update(s.revenueSplits)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(s.revenueSplits.id, v!.id));
    return { channelId: c!.id, versionId: v!.id };
  }

  const paymentTx = async (paymentId: string) => {
    const [row] = await db
      .select({ id: s.ledgerTransactions.id })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `payment:${paymentId}`));
    return row!.id;
  };

  test("a link names a payment whose splitVersionId is the version; links are append-only", async () => {
    const cur = freshCurrency();
    const [o, a] = [await makeUser(), await makeUser()];
    const { versionId } = await acceptedVersion(o, a, 1000);
    const linked = await tip(o, 1000, cur, new Date(), [{ userId: a, bps: 1000 }], versionId);
    await db
      .insert(s.revenueSplitPostings)
      .values({ splitId: versionId, ledgerTransactionId: await paymentTx(linked) });
    const plain = await tip(o, 1000, cur, new Date());
    expect(
      await refusedCode(
        db.insert(s.revenueSplitPostings).values({ splitId: versionId, ledgerTransactionId: await paymentTx(plain) }),
      ),
    ).toBe("23514");
    expect(
      await refusedCode(db.delete(s.revenueSplitPostings).where(eq(s.revenueSplitPostings.splitId, versionId))),
    ).toBe("42501");
    // Once linked, the version only ever changes by its end.
    expect(
      await refusedCode(
        db
          .update(s.revenueSplits)
          .set({ acceptedAt: new Date(0) })
          .where(eq(s.revenueSplits.id, versionId)),
      ),
    ).toBe("23514");
  });

  test("accepted shares freeze and the owner is never crew", async () => {
    const [o, a, b] = [await makeUser(), await makeUser(), await makeUser()];
    const { versionId, channelId } = await acceptedVersion(o, a, 1000);
    expect(
      await refusedCode(db.insert(s.revenueSplitShares).values({ splitId: versionId, recipientUserId: b, bps: 10 })),
    ).toBe("42501");
    const [v2] = await db.insert(s.revenueSplits).values({ channelId, version: 2, basis: "tips" }).returning();
    expect(
      await refusedCode(db.insert(s.revenueSplitShares).values({ splitId: v2!.id, recipientUserId: o, bps: 10 })),
    ).toBe("23514");
  });

  test("split suspense is debited only by a release with a finance audit row; a write-off only when approved", async () => {
    const cur = freshCurrency();
    const [o, a, treasurer] = [await makeUser(), await makeUser(), await makeUser("treasurer")];
    await tip(o, 1000, cur, daysAgo(10), [{ userId: a, bps: 1000 }]);
    await owner.update(s.users).set({ banned: true }).where(eq(s.users.id, a));
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    const byOwner = await splitSuspenseByOwner(db, a, cur);
    const release = () =>
      splitSuspenseRelease({ actionId: uuidv7(), recipientUserId: a, byOwner, currency: cur, occurredAt: new Date() });
    expect(await refusedCode(post(db, release()))).toBe("23514");
    await db.transaction(async (tx: Executor) => {
      const r = await post(tx, release());
      await tx.insert(s.auditLog).values({
        actorType: "admin",
        actorId: treasurer,
        action: "money.split.suspense.release",
        subjectType: "ledger_transaction",
        subjectId: r.transactionId,
      });
    });
    expect(await rawBalance(db, accounts.splitSuspense(a), cur)).toBe(0);
    expect((await creatorBalances(db, a, cur)).liabilityCents).toBe(90);
    const months = await splitSuspenseMonthly(db, { from: daysAgo(40), to: new Date(Date.now() + DAY), currency: cur });
    expect(months.reduce((n, m) => n + m.released, 0)).toBe(1);
    expect(months.at(-1)?.heldAtMonthEndCents).toBe(0);

    expect(
      await refusedCode(
        post(
          db,
          splitShortfallWriteOff({
            proposalId: uuidv7(),
            ownerUserId: o,
            amountCents: 10,
            currency: cur,
            occurredAt: new Date(),
          }),
        ),
      ),
    ).toBe("23514");
    expect(holdMemo(uuidv7(), a)).toMatch(/^hold:/);
  });
});

describe("lock ordering (ADR 0013 decision 4)", () => {
  test("reversals racing payout batches finish without deadlock", async () => {
    const cur = freshCurrency();
    const users = await Promise.all(Array.from({ length: 4 }, () => makeUser()));
    const [o1, o2, x, y] = users as [string, string, string, string];
    // Two channels whose crews overlap, in opposite id orders, with released and held lots.
    const payments: string[] = [];
    for (let k = 0; k < 4; k++) {
      payments.push(
        await tip(o1, 2000, cur, daysAgo(10), [
          { userId: x, bps: 2000 },
          { userId: y, bps: 1000 },
        ]),
      );
      payments.push(
        await tip(o2, 2000, cur, daysAgo(10), [
          { userId: y, bps: 2000 },
          { userId: o1, bps: 1000 },
        ]),
      );
    }
    await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur, newRecipientHoldDays: 0 });
    for (let k = 0; k < 4; k++) {
      payments.push(await tip(o2, 1000, cur, new Date(), [{ userId: x, bps: 3000 }]));
      payments.push(await tip(x, 1000, cur, new Date(), [{ userId: o2, bps: 3000 }]));
    }
    const months = Array.from({ length: 4 }, (_, k) => ({
      periodStart: new Date(Date.UTC(2099, k, 1)),
      periodEnd: new Date(Date.UTC(2099, k + 1, 1)),
    }));
    const results = await Promise.allSettled([
      ...payments.map((p, k) =>
        postReversal(db, { ...dispute(k % 2 ? "chargeback" : "refund", p, 500), disputeFeeCents: 0 }),
      ),
      ...months.map((m) => runPayoutBatch(db, { ...m, currency: cur, minimumCents: 1 })),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed.map((f) => String(f.reason))).toEqual([]);
  });
});
