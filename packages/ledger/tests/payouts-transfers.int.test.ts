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
  cancelPayout,
  cancelPayoutWithoutAccount,
  creatorBalances,
  holdPayoutsForFraud,
  insertFraudFlag,
  markPayoutTransferSending,
  markPayoutTransferUnsettled,
  markStripeAccountNotReady,
  openPayoutTransfer,
  payoutTransferKey,
  paymentSucceeded,
  post,
  postPayout,
  rawBalance,
  recordOrphanedPayoutTransfer,
  recordPayoutTransferCreated,
  recordPayoutTransferFailed,
  recordPayoutTransferReversal,
  releaseDueHolds,
  runPayoutBatch,
  schedulePayoutTransfers,
  findPayoutTransfer,
  transferMayHaveReachedStripe,
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

describe("send markers and reconciliation", () => {
  test("`sending` is written once, before the first request, and a later answer clears it", async () => {
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    expect(transferMayHaveReachedStripe(tr)).toBe(false);
    expect(await markPayoutTransferSending(db, { transferId: tr.id, at: AT })).toBe(true);
    expect(await markPayoutTransferSending(db, { transferId: tr.id, at: AT })).toBe(false);
    const [row] = await db.select().from(s.payoutTransfers).where(eq(s.payoutTransfers.id, tr.id));
    expect(row).toMatchObject({ status: "pending", failureCode: "sending", providerRef: null });
    expect(transferMayHaveReachedStripe(row!)).toBe(true);
    // Outcome unknown replaces it (audited); Stripe's answer clears it.
    expect(
      await markPayoutTransferUnsettled(db, { transferId: tr.id, code: PAYOUT_TRANSFER_CODES.outcomeUnknown, at: AT }),
    ).toBe(true);
    expect(await markPayoutTransferSending(db, { transferId: tr.id, at: AT })).toBe(false);
    const created = await recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_marked", at: AT });
    expect(created.transfer.failureCode).toBeNull();
  });

  test("a Stripe transfer on a failed row is audited once as orphaned; nothing is posted", async () => {
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    await recordPayoutTransferFailed(db, { transferId: tr.id, failureCode: "held", at: AT });
    const owedBefore = await owed(f);
    const mark = () => recordOrphanedPayoutTransfer(db, { transferId: tr.id, providerRef: "tr_orphan", at: AT });
    expect(await mark()).toBe(true);
    expect(await mark()).toBe(false);
    const audits = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectId, tr.id), eq(s.auditLog.action, "payout_transfer.orphaned")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "system", subjectType: "payout_transfer" });
    expect(audits[0]?.details).toEqual({ payoutId: f.payoutId, payeeUserId: f.userId, transferRef: "tr_orphan" });
    expect(await owed(f)).toBe(owedBefore);
    const [row] = await db.select().from(s.payoutTransfers).where(eq(s.payoutTransfers.id, tr.id));
    expect(row).toMatchObject({ status: "failed", providerRef: null });
  });

  test("a scheduled payout with no Stripe account is cancelled with an audit row; one with an account is not", async () => {
    const f = await reservedPayout();
    await schedulePayoutTransfers(db);
    expect((await payoutOf(f.payoutId)).status).toBe("scheduled");
    // An account still there: nothing happens.
    expect(await cancelPayoutWithoutAccount(db, { payoutId: f.payoutId, at: AT })).toBe(false);
    await owner.delete(s.payoutAccounts).where(eq(s.payoutAccounts.userId, f.userId));
    expect(await cancelPayoutWithoutAccount(db, { payoutId: f.payoutId, at: AT })).toBe(true);
    expect((await payoutOf(f.payoutId)).status).toBe("failed");
    expect(await owed(f)).toBe(f.amountCents);
    // Not scheduled any more: a repeat does nothing and writes nothing.
    expect(await cancelPayoutWithoutAccount(db, { payoutId: f.payoutId, at: AT })).toBe(false);
    const audits = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectId, f.payoutId), eq(s.auditLog.action, "payout.cancel")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({ reason: "no_account", payeeUserId: f.userId });
    expect(await rawBalance(db, accounts.payoutClearing(f.userId), f.cur)).toBe(0);
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

describe("edges: unknown rows, wrong states, a rerun of the same period", () => {
  test("every entry point refuses an unknown payout or transfer with PayoutStateError", async () => {
    const nope = uuidv7();
    await expect(postPayout(db, { payoutId: nope, paidAt: AT })).rejects.toThrow(/payout .* not found/);
    await expect(cancelPayout(db, { payoutId: nope, at: AT })).rejects.toThrow(/payout .* not found/);
    await expect(openPayoutTransfer(db, { payoutId: nope, at: AT })).rejects.toThrow(PayoutStateError);
    await expect(cancelPayoutWithoutAccount(db, { payoutId: nope, at: AT })).rejects.toThrow(PayoutStateError);
    for (const call of [
      () => recordPayoutTransferCreated(db, { transferId: nope, providerRef: "tr_x", at: AT }),
      () => recordPayoutTransferFailed(db, { transferId: nope, failureCode: "held", at: AT }),
      () => recordPayoutTransferReversal(db, { transferId: nope, reversedTotalCents: 1, at: AT }),
      () => markPayoutTransferUnsettled(db, { transferId: nope, code: PAYOUT_TRANSFER_CODES.outcomeUnknown, at: AT }),
      () => recordOrphanedPayoutTransfer(db, { transferId: nope, providerRef: "tr_x", at: AT }),
    ])
      await expect(call()).rejects.toThrow(/payout transfer .* not found/);
    expect(await findPayoutTransfer(db, { providerRef: "tr_none", transferId: nope })).toBeNull();
    expect(await findPayoutTransfer(db, { providerRef: "tr_none", transferId: null })).toBeNull();
  });

  test("a held payout is never posted as sent; a paid one is never cancelled", async () => {
    const held = await reservedPayout({ enabled: false });
    expect((await payoutOf(held.payoutId)).status).toBe("held");
    await expect(postPayout(db, { payoutId: held.payoutId, paidAt: AT })).rejects.toThrow(/is held/);
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    await recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_paid", at: AT });
    await expect(cancelPayout(db, { payoutId: f.payoutId, at: AT })).rejects.toThrow(/was paid/);
    // A paid payout's repeat post is a no-op returning the same transaction.
    const again = await postPayout(db, { payoutId: f.payoutId, paidAt: AT });
    expect(again.created).toBe(false);
  });

  test("a created transfer is never failed nor marked unsettled; a second reference is refused", async () => {
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    await markPayoutTransferUnsettled(db, {
      transferId: tr.id,
      code: PAYOUT_TRANSFER_CODES.sentUnrecorded,
      providerRef: "tr_first",
      at: AT,
    });
    await expect(
      markPayoutTransferUnsettled(db, {
        transferId: tr.id,
        code: PAYOUT_TRANSFER_CODES.sentUnrecorded,
        providerRef: "tr_other",
        at: AT,
      }),
    ).rejects.toThrow(/another provider reference/);
    await expect(
      recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_other", at: AT }),
    ).rejects.toThrow(/another provider reference/);
    await recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_first", at: AT });
    await expect(recordPayoutTransferFailed(db, { transferId: tr.id, failureCode: "held", at: AT })).rejects.toThrow(
      /is created/,
    );
    expect(
      await markPayoutTransferUnsettled(db, { transferId: tr.id, code: PAYOUT_TRANSFER_CODES.outcomeUnknown, at: AT }),
    ).toBe(false);
    // A repeat of the same answer changes nothing.
    const repeat = await recordPayoutTransferCreated(db, { transferId: tr.id, providerRef: "tr_first", at: AT });
    expect(repeat.created).toBe(false);
  });

  test("a scheduled payout whose account went away opens no transfer; one with a transfer is not cancelled", async () => {
    const gone = await reservedPayout();
    await schedulePayoutTransfers(db);
    await owner.delete(s.payoutAccounts).where(eq(s.payoutAccounts.userId, gone.userId));
    expect(await openPayoutTransfer(db, { payoutId: gone.payoutId, at: AT })).toEqual({
      transfer: null,
      reason: "no_account",
    });
    const f = await reservedPayout();
    const tr = await scheduledTransfer(f);
    // Already opened: the existing row is returned, and the no-account cancel leaves it to the worker.
    expect((await openPayoutTransfer(db, { payoutId: f.payoutId, at: AT })).transfer?.id).toBe(tr.id);
    await owner.delete(s.payoutAccounts).where(eq(s.payoutAccounts.userId, f.userId));
    expect(await cancelPayoutWithoutAccount(db, { payoutId: f.payoutId, at: AT })).toBe(false);
    expect((await payoutOf(f.payoutId)).status).toBe("scheduled");
  });

  test("a period runs once per creator: money earned in it after its run waits for the next period", async () => {
    const f = await reservedPayout({ provider: "manual" });
    // Dated inside the period, posted after its run (a late webhook): available at its end.
    await earn(f.userId, 5_000, f.cur);
    const rerun = await runPayoutBatch(db, { ...PERIOD, currency: f.cur, minimumCents: 1_000 });
    expect(rerun).toMatchObject({ created: 0, held: 0, totalCents: 0 });
    expect(await db.select().from(s.payouts).where(eq(s.payouts.userId, f.userId))).toHaveLength(1);
    const next = { periodStart: PERIOD.periodEnd, periodEnd: new Date(PERIOD.periodEnd.getTime() + 28 * DAY) };
    expect(await runPayoutBatch(db, { ...next, currency: f.cur, minimumCents: 1_000 })).toMatchObject({
      created: 1,
      totalCents: 4_500,
    });
  });

  test("a payout row the ledger never reserved is never sent; cancelling it posts nothing", async () => {
    const userId = await makeUser();
    const cur = freshCurrency();
    const [row] = await db
      .insert(s.payouts)
      .values({ userId, ...PERIOD, amountCents: 1_000, currency: cur, status: "pending", provider: "manual" })
      .returning({ id: s.payouts.id });
    await expect(postPayout(db, { payoutId: row!.id, paidAt: AT })).rejects.toThrow(/never reserved/);
    expect(await cancelPayout(db, { payoutId: row!.id, at: AT })).toBeNull();
    expect((await payoutOf(row!.id)).status).toBe("failed");
    // Failed already: a repeat cancel leaves it as it is.
    expect(await cancelPayout(db, { payoutId: row!.id, at: AT })).toBeNull();
  });

  test("a run refuses an empty or inverted period, a bad currency or minimum", async () => {
    const cur = freshCurrency();
    for (const bad of [
      { periodStart: PERIOD.periodEnd, periodEnd: PERIOD.periodEnd, currency: cur, minimumCents: 0 },
      { periodStart: PERIOD.periodEnd, periodEnd: PERIOD.periodStart, currency: cur, minimumCents: 0 },
      { ...PERIOD, currency: "USD", minimumCents: 0 },
      { ...PERIOD, currency: cur, minimumCents: -1 },
      { ...PERIOD, currency: cur, minimumCents: 0.5 },
    ])
      await expect(runPayoutBatch(db, bad), JSON.stringify(bad)).rejects.toThrow(RangeError);
  });
});
