// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * M1-connect's payout send and cancel paths against the real database, as the application role
 * (ADR 0007 Amendment 1): a Stripe payout is scheduled, gets one pending transfer, and is either
 * paid (`payoutSent`) or cancelled back to the payable (`payoutCancel`); a reversal returns its
 * amount to the payable. Migration 0049's guards back every step.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { type Database, schema as s, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  DEFAULT_PLATFORM_CUT,
  PAYOUT_TRANSFER_CODES,
  PayoutStateError,
  accounts,
  creatorBalances,
  holdPayoutsForFraud,
  insertFraudFlag,
  markPayoutTransferUnsettled,
  markStripeAccountNotReady,
  openPayoutTransfer,
  payoutTransferKey,
  paymentSucceeded,
  post,
  rawBalance,
  recordPayoutTransferCreated,
  recordPayoutTransferFailed,
  recordPayoutTransferReversal,
  releaseDueHolds,
  runPayoutBatch,
  schedulePayoutTransfers,
  findPayoutTransfer,
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

const DAY = 86_400_000;
const PERIOD = { periodStart: new Date("2099-01-01T00:00:00Z"), periodEnd: new Date("2099-02-01T00:00:00Z") };
const AT = new Date("2099-02-02T00:00:00Z");

let seq = 0;
async function makeUser(): Promise<string> {
  const name = `conn${++seq}x${uuidv7().slice(-6)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

let currencies = 0;
/** A fresh currency per test, so each batch sees only its own creators. */
const freshCurrency = () =>
  `c${String.fromCharCode(97 + Math.floor(currencies / 26))}${String.fromCharCode(97 + (currencies++ % 26))}`;

/** Released earnings: gross with no tax or fee; the creator keeps 90 %. */
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

interface Fixture {
  userId: string;
  cur: string;
  payoutId: string;
  amountCents: number;
}

/** A creator with a ready Stripe (or manual) account and one reserved payout for the period. */
async function reservedPayout(opts: { provider?: "stripe" | "manual"; enabled?: boolean } = {}): Promise<Fixture> {
  const userId = await makeUser();
  const cur = freshCurrency();
  const provider = opts.provider ?? "stripe";
  await db.insert(s.payoutAccounts).values({
    userId,
    provider,
    providerAccountId: provider === "stripe" ? `acct_${userId.replace(/-/g, "").slice(-16)}` : "ref",
    payoutsEnabled: opts.enabled ?? true,
  });
  await earn(userId, 10_000, cur);
  await runPayoutBatch(db, { ...PERIOD, currency: cur, minimumCents: 1_000 });
  const [p] = await db.select().from(s.payouts).where(eq(s.payouts.userId, userId));
  return { userId, cur, payoutId: p!.id, amountCents: p!.amountCents };
}

const payoutOf = async (id: string) => (await db.select().from(s.payouts).where(eq(s.payouts.id, id)))[0]!;
const owed = async (f: Fixture) => (await creatorBalances(db, f.userId, f.cur)).availableCents;

async function scheduledTransfer(f: Fixture) {
  const r = await schedulePayoutTransfers(db);
  expect(r.payoutIds).toContain(f.payoutId);
  const opened = await openPayoutTransfer(db, { payoutId: f.payoutId, at: AT });
  if (!opened.transfer) throw new Error(`no transfer: ${opened.reason}`);
  return opened.transfer;
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

describe("scheduling", () => {
  test("a ready Stripe payout is scheduled; manual, not-ready and held payees are not", async () => {
    const ready = await reservedPayout();
    const manual = await reservedPayout({ provider: "manual" });
    const notReady = await reservedPayout({ enabled: false });
    const held = await reservedPayout();
    await insertFraudFlag(db, { payeeUserId: held.userId, kind: "manual", evidence: {}, raisedById: null, at: AT });
    await holdPayoutsForFraud(db, held.userId);

    const r = await schedulePayoutTransfers(db);
    expect(r.payoutIds).toContain(ready.payoutId);
    for (const f of [manual, notReady, held]) expect(r.payoutIds).not.toContain(f.payoutId);
    expect((await payoutOf(ready.payoutId)).status).toBe("scheduled");
    expect((await payoutOf(manual.payoutId)).status).toBe("pending");
    expect((await payoutOf(notReady.payoutId)).status).toBe("held");
    expect((await payoutOf(held.payoutId)).status).toBe("held");
    // A second call schedules nothing new and still lists the unsettled one.
    const again = await schedulePayoutTransfers(db);
    expect(again.payoutIds).toContain(ready.payoutId);
  });

  test("the transfer row is opened once, for the payee's own account, with the payout's key", async () => {
    const f = await reservedPayout();
    await schedulePayoutTransfers(db);
    const [a, b] = await Promise.all([
      openPayoutTransfer(db, { payoutId: f.payoutId, at: AT }),
      openPayoutTransfer(db, { payoutId: f.payoutId, at: AT }),
    ]);
    expect(a.transfer?.id).toBeDefined();
    expect(a.transfer?.id).toBe(b.transfer?.id);
    expect(a.transfer).toMatchObject({
      status: "pending",
      provider: "stripe",
      amountCents: f.amountCents,
      currency: f.cur,
      idempotencyKey: payoutTransferKey(f.payoutId),
      reversedCents: 0,
      providerRef: null,
    });
    expect(a.transfer?.destinationRef).toMatch(/^acct_/);
    const rows = await db.select().from(s.payoutTransfers).where(eq(s.payoutTransfers.payoutId, f.payoutId));
    expect(rows).toHaveLength(1);
  });

  test("no row is opened for a manual or unscheduled payout, and the trigger refuses one", async () => {
    const manual = await reservedPayout({ provider: "manual" });
    expect(await openPayoutTransfer(db, { payoutId: manual.payoutId, at: AT })).toEqual({
      transfer: null,
      reason: "not_scheduled",
    });
    const code = await pgCode(
      db.insert(s.payoutTransfers).values({
        payoutId: manual.payoutId,
        provider: "stripe",
        destinationRef: "acct_x",
        amountCents: manual.amountCents,
        currency: manual.cur,
        idempotencyKey: payoutTransferKey(manual.payoutId),
      }),
    );
    expect(code).toBe("23514");
  });
});

describe("send, cancel and reverse", () => {
  test("reserve → transfer → sent → reversed (partial, then full) returns every cent to the payable", async () => {
    const f = await reservedPayout();
    const before = await owed(f);
    expect(before).toBe(0);
    const tr = await scheduledTransfer(f);
    const cash = await rawBalance(db, accounts.cash("stripe"), f.cur);

    const created = await recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_a1", at: AT });
    expect(created.created).toBe(true);
    expect(created.transfer).toMatchObject({ status: "created", providerRef: "tr_a1", failureCode: null });
    const paid = await payoutOf(f.payoutId);
    expect(paid.status).toBe("paid");
    expect(paid.providerRef).toBe("tr_a1");
    expect(await rawBalance(db, accounts.payoutClearing(f.userId), f.cur)).toBe(0);
    expect(await rawBalance(db, accounts.cash("stripe"), f.cur)).toBe(cash - f.amountCents);
    // A repeat with the same id changes nothing.
    expect((await recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_a1", at: AT })).created).toBe(
      false,
    );
    await expect(
      recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_other", at: AT }),
    ).rejects.toThrow(PayoutStateError);

    const part = await recordPayoutTransferReversal(db, { transferId: tr.id, reversedTotalCents: 1_000, at: AT });
    expect(part.postedCents).toBe(1_000);
    expect(part.transfer).toMatchObject({ status: "created", reversedCents: 1_000 });
    expect(await owed(f)).toBe(1_000);
    // Redelivered: nothing.
    expect(
      (await recordPayoutTransferReversal(db, { transferId: tr.id, reversedTotalCents: 1_000, at: AT })).postedCents,
    ).toBe(0);

    const full = await recordPayoutTransferReversal(db, {
      transferId: tr.id,
      reversedTotalCents: f.amountCents,
      at: AT,
    });
    expect(full.postedCents).toBe(f.amountCents - 1_000);
    expect(full.transfer).toMatchObject({ status: "reversed", reversedCents: f.amountCents });
    // Every cent is owed again; the cash and clearing legs net to zero.
    expect(await owed(f)).toBe(f.amountCents);
    expect(await rawBalance(db, accounts.cash("stripe"), f.cur)).toBe(cash);
    expect(await rawBalance(db, accounts.payoutClearing(f.userId), f.cur)).toBe(0);
    expect((await payoutOf(f.payoutId)).status).toBe("paid");

    const events = await db
      .select({ type: s.events.type, payload: s.events.payload })
      .from(s.events)
      .where(eq(s.events.type, "money.payout_transfer.reversed"));
    const mine = events.filter((e) => (e.payload as { transfer_id?: string }).transfer_id === tr.id);
    expect(mine.map((e) => (e.payload as { amount_cents: number }).amount_cents)).toEqual([
      1_000,
      f.amountCents - 1_000,
    ]);
    const audits = await db
      .select({ action: s.auditLog.action, actorType: s.auditLog.actorType, details: s.auditLog.details })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectType, "payout_transfer"), eq(s.auditLog.subjectId, tr.id)));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "payout_transfer.created",
      "payout_transfer.reversed",
      "payout_transfer.reversed",
    ]);
    expect(audits.every((a) => a.actorType === "system")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("@");
    // Fully reversed: no further posting.
    expect(
      (await recordPayoutTransferReversal(db, { transferId: tr.id, reversedTotalCents: 99_999, at: AT })).postedCents,
    ).toBe(0);
  });

  test("a definite refusal cancels the payout back to the payable through payoutCancel", async () => {
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    const r = await recordPayoutTransferFailed(db, { transferId: tr.id, failureCode: "resource_missing", at: AT });
    expect(r.failed).toBe(true);
    expect(r.transfer).toMatchObject({ status: "failed", failureCode: "resource_missing" });
    expect((await payoutOf(f.payoutId)).status).toBe("failed");
    expect(await owed(f)).toBe(f.amountCents);
    const [cancel] = await db
      .select({ kind: s.ledgerTransactions.kind })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `payout-cancel:${f.payoutId}`));
    expect(cancel?.kind).toBe("payout_cancel");
    expect((await recordPayoutTransferFailed(db, { transferId: tr.id, failureCode: "held", at: AT })).failed).toBe(
      false,
    );
    const [ev] = await db
      .select({ payload: s.events.payload })
      .from(s.events)
      .where(eq(s.events.type, "money.payout_transfer.failed"));
    expect(ev?.payload).toBeDefined();
    // A failed transfer is never created afterwards.
    await expect(
      recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_late", at: AT }),
    ).rejects.toThrow(PayoutStateError);
    await expect(
      recordPayoutTransferFailed(db, { transferId: tr.id, failureCode: "Not a code!", at: AT }),
    ).rejects.toThrow(RangeError);
  });

  test("a payout held after its transfer opened is never paid; Stripe's id is kept, never cancelled", async () => {
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    await insertFraudFlag(db, { payeeUserId: f.userId, kind: "manual", evidence: {}, raisedById: null, at: AT });
    expect(await holdPayoutsForFraud(db, f.userId)).toBe(1);
    await expect(
      recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_held", at: AT }),
    ).rejects.toThrow(PayoutStateError);
    expect(
      await markPayoutTransferUnsettled(db, {
        transferId: tr.id,
        code: PAYOUT_TRANSFER_CODES.sentUnrecorded,
        providerRef: "tr_held",
        at: AT,
      }),
    ).toBe(true);
    const [row] = await db.select().from(s.payoutTransfers).where(eq(s.payoutTransfers.id, tr.id));
    expect(row).toMatchObject({ status: "pending", providerRef: "tr_held", failureCode: "sent_unrecorded" });
    // Money may have left: no cancellation.
    await expect(recordPayoutTransferFailed(db, { transferId: tr.id, failureCode: "held", at: AT })).rejects.toThrow(
      /never cancelled/,
    );
    expect((await payoutOf(f.payoutId)).status).toBe("held");
    expect(await findPayoutTransfer(db, { providerRef: "tr_held", transferId: null })).toMatchObject({ id: tr.id });
    expect(await findPayoutTransfer(db, { providerRef: "tr_nope", transferId: tr.id })).toMatchObject({ id: tr.id });
    expect(await findPayoutTransfer(db, { providerRef: "tr_nope", transferId: "not-a-uuid" })).toBeNull();
  });

  test("an unknown outcome keeps the transfer pending with its code, audited once", async () => {
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    const mark = () =>
      markPayoutTransferUnsettled(db, { transferId: tr.id, code: PAYOUT_TRANSFER_CODES.outcomeUnknown, at: AT });
    expect(await mark()).toBe(true);
    expect(await mark()).toBe(false);
    const [row] = await db.select().from(s.payoutTransfers).where(eq(s.payoutTransfers.id, tr.id));
    expect(row).toMatchObject({ status: "pending", failureCode: "outcome_unknown", providerRef: null });
    // A later answer settles it and clears the code.
    const created = await recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_late", at: AT });
    expect(created.transfer.failureCode).toBeNull();
    const audits = await db
      .select({ action: s.auditLog.action })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectId, tr.id), eq(s.auditLog.action, "payout_transfer.unsettled")));
    expect(audits).toHaveLength(1);
  });

  test("a reversal before the transfer is created is refused (the webhook retries)", async () => {
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    await expect(
      recordPayoutTransferReversal(db, { transferId: tr.id, reversedTotalCents: 100, at: AT }),
    ).rejects.toThrow(PayoutStateError);
  });
});

describe("account readiness", () => {
  test("a refused account is marked not ready, audited as the sync does", async () => {
    const f = await reservedPayout();
    expect(await markStripeAccountNotReady(db, { userId: f.userId, at: AT })).toBe(true);
    expect(await markStripeAccountNotReady(db, { userId: f.userId, at: AT })).toBe(false);
    const [acct] = await db.select().from(s.payoutAccounts).where(eq(s.payoutAccounts.userId, f.userId));
    expect(acct?.payoutsEnabled).toBe(false);
    const audits = await db
      .select({ action: s.auditLog.action })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectId, f.userId), eq(s.auditLog.action, "payout_account.set")));
    expect(audits).toHaveLength(1);
  });
});
