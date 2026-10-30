// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payout batch's fraud floor (ADR 0036) against a real database, as the application role:
 * flagged payees get held payouts, a first large payout raises `new_payee`, `postPayout` refuses a
 * held payee, and `payouts_fraud_guard` refuses what the application would also refuse.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { type Database, schema as s, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  DEFAULT_PLATFORM_CUT,
  FRAUD_REVIEW_HOLD,
  PAYOUT_ACCOUNT_NOT_READY,
  PayoutStateError,
  fraudFlagHolds,
  fraudHeldPayouts,
  holdPayoutsForFraud,
  insertFraudFlag,
  newPayeeEvidence,
  payeeHasHoldingFlag,
  paymentSucceeded,
  post,
  postPayout,
  raiseFraudFlag,
  releaseDueHolds,
  releaseFraudHolds,
  runPayoutBatch,
} from "../src/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

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

type Role = (typeof s.users.$inferInsert)["role"];
let seq = 0;
async function makeUser(role: Role = "user"): Promise<string> {
  const name = `fraud${++seq}x${uuidv7().slice(-6)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, role })
    .returning({ id: s.users.id });
  return u!.id;
}

const DAY = 86_400_000;
/** Periods after every posting below, so all of it counts as of their end. */
const JAN = { periodStart: new Date("2099-01-01T00:00:00Z"), periodEnd: new Date("2099-02-01T00:00:00Z") };
const FEB = { periodStart: new Date("2099-02-01T00:00:00Z"), periodEnd: new Date("2099-03-01T00:00:00Z") };
const MAR = { periodStart: new Date("2099-03-01T00:00:00Z"), periodEnd: new Date("2099-04-01T00:00:00Z") };

let currencies = 0;
/** A fresh currency per test, so batches see only that test's creators. */
const freshCurrency = () =>
  `f${String.fromCharCode(97 + Math.floor(currencies / 26))}${String.fromCharCode(97 + (currencies++ % 26))}`;

/** Released earnings (gross with no tax or fee; the creator keeps 90 %). */
async function earn(creator: string, gross: number, cur: string) {
  await post(
    db,
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
      occurredAt: new Date(Date.now() - 30 * DAY),
    }),
  );
  await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: cur });
}

const readyAccount = (userId: string) =>
  db.insert(s.payoutAccounts).values({ userId, provider: "manual", providerAccountId: "ref", payoutsEnabled: true });

const payoutsOf = (userId: string) => db.select().from(s.payouts).where(eq(s.payouts.userId, userId));

async function flagOf(payee: string, kind: "manual" | "payer_concentration" = "manual") {
  const f = await insertFraudFlag(db, {
    payeeUserId: payee,
    kind,
    evidence: { payers: 1 },
    raisedById: null,
    at: new Date(),
  });
  return f!.id;
}
const review = (id: string, by: string, recommendation: "clear" | "confirm") =>
  db
    .update(s.paymentFraudFlags)
    .set({ status: "reviewed", reviewedById: by, recommendation, reviewedAt: new Date() })
    .where(eq(s.paymentFraudFlags.id, id));
const decide = (id: string, by: string, decision: "clear" | "confirm") =>
  db
    .update(s.paymentFraudFlags)
    .set({ status: decision === "clear" ? "cleared" : "confirmed", decidedById: by, decision, decidedAt: new Date() })
    .where(eq(s.paymentFraudFlags.id, id));
const release = (id: string, by: string) =>
  db
    .update(s.paymentFraudFlags)
    .set({ releasedById: by, releasedAt: new Date() })
    .where(eq(s.paymentFraudFlags.id, id));

async function decided(payee: string, decision: "clear" | "confirm"): Promise<string> {
  const id = await flagOf(payee);
  await review(id, await makeUser("treasurer"), decision);
  await decide(id, await makeUser("treasurer"), decision);
  return id;
}

/** The SQLSTATE of a rejected query (drizzle wraps the driver error in `cause`). */
async function pgCode(p: PromiseLike<unknown>): Promise<string | undefined> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code;
}

describe("fraudFlagHolds", () => {
  test("open, reviewed and unreleased confirmed flags hold; cleared and released ones do not", () => {
    const at = new Date();
    expect(fraudFlagHolds({ status: "open", releasedAt: null })).toBe(true);
    expect(fraudFlagHolds({ status: "reviewed", releasedAt: null })).toBe(true);
    expect(fraudFlagHolds({ status: "confirmed", releasedAt: null })).toBe(true);
    expect(fraudFlagHolds({ status: "confirmed", releasedAt: at })).toBe(false);
    expect(fraudFlagHolds({ status: "cleared", releasedAt: null })).toBe(false);
  });
  test("newPayeeEvidence at the threshold", () => {
    expect(newPayeeEvidence(49_999)).toBeNull();
    expect(newPayeeEvidence(50_000)).toEqual({ payoutCents: 50_000 });
  });
});

describe("runPayoutBatch with fraud flags", () => {
  test("holds a flagged payee and pays an unflagged one in the same run", async () => {
    const cur = freshCurrency();
    const flagged = await makeUser();
    const clean = await makeUser();
    await readyAccount(flagged);
    await readyAccount(clean);
    await earn(flagged, 5000, cur);
    await earn(clean, 5000, cur);
    await flagOf(flagged);

    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r).toMatchObject({ created: 1, held: 1, totalCents: 9000 });
    expect((await payoutsOf(flagged))[0]).toMatchObject({ status: "held", holdReason: FRAUD_REVIEW_HOLD });
    expect((await payoutsOf(clean))[0]).toMatchObject({ status: "pending", holdReason: null });
  });

  test("fraud wins over account readiness", async () => {
    const cur = freshCurrency();
    const payee = await makeUser();
    await earn(payee, 5000, cur);
    await flagOf(payee);
    await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect((await payoutsOf(payee))[0]).toMatchObject({ status: "held", holdReason: FRAUD_REVIEW_HOLD });
  });

  test("a confirmed flag keeps holding later batches; a released one does not", async () => {
    const cur = freshCurrency();
    const payee = await makeUser();
    await readyAccount(payee);
    const flag = await decided(payee, "confirm");
    await earn(payee, 5000, cur);
    await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    await earn(payee, 3000, cur);
    await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 });
    const rows = await payoutsOf(payee);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ status: "held", holdReason: FRAUD_REVIEW_HOLD });

    await release(flag, await makeUser("admin"));
    expect(await payeeHasHoldingFlag(db, payee)).toBe(false);
    await earn(payee, 2000, cur);
    await runPayoutBatch(db, { ...MAR, currency: cur, minimumCents: 100 });
    const march = (await payoutsOf(payee)).find((p) => p.periodStart.getTime() === MAR.periodStart.getTime());
    expect(march).toMatchObject({ status: "pending", holdReason: null, amountCents: 1800 });
  });

  test("a payee whose only flag was cleared is paid", async () => {
    const cur = freshCurrency();
    const payee = await makeUser();
    await readyAccount(payee);
    await decided(payee, "clear");
    await earn(payee, 5000, cur);
    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r).toMatchObject({ created: 1, held: 0 });
    expect((await payoutsOf(payee))[0]).toMatchObject({ status: "pending" });
  });

  test("a first large payout raises new_payee and is held, with its audit and outbox rows", async () => {
    const cur = freshCurrency();
    const payee = await makeUser();
    await readyAccount(payee);
    // 90 % of 60 000 = 54 000 ≥ 50 000.
    await earn(payee, 60_000, cur);
    const r = await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    expect(r).toMatchObject({ created: 0, held: 1, totalCents: 54_000 });
    expect((await payoutsOf(payee))[0]).toMatchObject({ status: "held", holdReason: FRAUD_REVIEW_HOLD });

    const [flag] = await db.select().from(s.paymentFraudFlags).where(eq(s.paymentFraudFlags.payeeUserId, payee));
    expect(flag).toMatchObject({
      kind: "new_payee",
      status: "open",
      raisedById: null,
      evidence: { payoutCents: 54_000 },
    });
    const audit = await owner
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectType, "payment_fraud_flag"), eq(s.auditLog.subjectId, flag!.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "system",
      actorId: null,
      action: "money.fraud.raise",
      reason: "",
      details: { flagId: flag!.id, kind: "new_payee", status: "open" },
    });
    const events = await owner.select().from(s.events).where(eq(s.events.type, "money.fraud.flag"));
    const mine = events.filter((e) => e.payload.flag_id === flag!.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.payload).toEqual({
      flag_id: flag!.id,
      payee_user_id: payee,
      kind: "new_payee",
      status: "open",
      released: false,
      held_payouts: 1,
    });
  });

  test("a small first payout, or a large second one, raises nothing", async () => {
    const cur = freshCurrency();
    const payee = await makeUser();
    await readyAccount(payee);
    await earn(payee, 1000, cur);
    await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    await earn(payee, 100_000, cur);
    await runPayoutBatch(db, { ...FEB, currency: cur, minimumCents: 100 });
    const rows = await payoutsOf(payee);
    expect(rows.map((p) => p.status).sort()).toEqual(["pending", "pending"]);
    expect(await db.select().from(s.paymentFraudFlags).where(eq(s.paymentFraudFlags.payeeUserId, payee))).toEqual([]);
  });
});

describe("postPayout and the trigger", () => {
  test("postPayout refuses a payee with a holding flag", async () => {
    const cur = freshCurrency();
    const payee = await makeUser();
    await readyAccount(payee);
    await earn(payee, 5000, cur);
    await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    const [p] = await payoutsOf(payee);
    expect(p?.status).toBe("pending");
    // A flag inserted without the re-tag (a bug elsewhere): the application check still refuses.
    await flagOf(payee);
    const err = await postPayout(db, { payoutId: p!.id, paidAt: new Date() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayoutStateError);
    expect((err as Error).message).toMatch(/fraud review/);
    expect((await payoutsOf(payee))[0]?.status).toBe("pending");
  });

  test("the trigger refuses held → pending while a flag holds, including a confirmed one", async () => {
    const cur = freshCurrency();
    const payee = await makeUser();
    await earn(payee, 5000, cur);
    const flag = await flagOf(payee);
    await runPayoutBatch(db, { ...JAN, currency: cur, minimumCents: 100 });
    const [p] = await payoutsOf(payee);
    const toPending = () =>
      db.update(s.payouts).set({ status: "pending", holdReason: null }).where(eq(s.payouts.id, p!.id));
    expect(await pgCode(toPending())).toBe("23514");
    const treasurer = await makeUser("treasurer");
    await review(flag, treasurer, "confirm");
    expect(await pgCode(toPending())).toBe("23514");
    await decide(flag, await makeUser("treasurer"), "confirm");
    expect(await pgCode(toPending())).toBe("23514");
    await release(flag, await makeUser("admin"));
    await toPending();
    expect((await payoutsOf(payee))[0]?.status).toBe("pending");
  });
});

describe("hold and release helpers", () => {
  test("holdPayoutsForFraud re-tags pending and account-not-ready holds, never paid or failed", async () => {
    const payee = await makeUser();
    const base = (n: number) => ({
      userId: payee,
      periodStart: new Date(Date.UTC(2098, n, 1)),
      periodEnd: new Date(Date.UTC(2098, n + 1, 1)),
      amountCents: 1000,
      currency: "usd",
      provider: "manual" as const,
    });
    await db.insert(s.payouts).values([
      { ...base(0), status: "pending" },
      { ...base(1), status: "scheduled" },
      { ...base(2), status: "held", holdReason: PAYOUT_ACCOUNT_NOT_READY },
      { ...base(3), status: "paid", paidAt: new Date() },
      { ...base(4), status: "failed", holdReason: "provider_error" },
      { ...base(5), status: "held", holdReason: "other_hold" },
    ]);
    await flagOf(payee);
    expect(await holdPayoutsForFraud(db, payee)).toBe(3);
    expect(await fraudHeldPayouts(db, payee)).toBe(3);
    const by = new Map((await payoutsOf(payee)).map((p) => [p.periodStart.getUTCMonth(), p]));
    expect(by.get(3)?.status).toBe("paid");
    expect(by.get(4)).toMatchObject({ status: "failed", holdReason: "provider_error" });
    expect(by.get(5)).toMatchObject({ status: "held", holdReason: "other_hold" });
  });

  test("releaseFraudHolds waits for the last holding flag and respects account readiness", async () => {
    const payee = await makeUser();
    const r = await raiseFraudFlag(db, {
      payeeUserId: payee,
      kind: "manual",
      evidence: {},
      raisedById: null,
      actorType: "system",
      at: new Date(),
    });
    expect(r).not.toBeNull();
    // Raising the same undecided kind again adds nothing.
    expect(
      await raiseFraudFlag(db, {
        payeeUserId: payee,
        kind: "manual",
        evidence: {},
        raisedById: null,
        actorType: "system",
        at: new Date(),
      }),
    ).toBeNull();
    const second = await flagOf(payee, "payer_concentration");
    await db.insert(s.payouts).values({
      userId: payee,
      periodStart: new Date(Date.UTC(2097, 0, 1)),
      periodEnd: new Date(Date.UTC(2097, 1, 1)),
      amountCents: 1000,
      currency: "usd",
      provider: "manual",
      status: "held",
      holdReason: FRAUD_REVIEW_HOLD,
    });
    const t1 = await makeUser("treasurer");
    const t2 = await makeUser("treasurer");
    await review(r!.flag.id, t1, "clear");
    await decide(r!.flag.id, t2, "clear");
    // The concentration flag still holds.
    expect(await releaseFraudHolds(db, payee)).toEqual({ released: 0, accountNotReady: 0 });
    await review(second, t1, "clear");
    await decide(second, t2, "clear");
    // No payout account: the payout waits for it instead.
    expect(await releaseFraudHolds(db, payee)).toEqual({ released: 0, accountNotReady: 1 });
    expect((await payoutsOf(payee))[0]).toMatchObject({ status: "held", holdReason: PAYOUT_ACCOUNT_NOT_READY });
  });
});
