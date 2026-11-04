// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `patronage-payout` job (M1-coop-money; ADR 0020) against a real database, through M1-connect's
 * transfer service (the adapter's `transfer`), with faults injected and, when it is running,
 * stripe-mock: a ready Express member is paid (`patronagePayout` on `cash:stripe`, keyed by the
 * row, under the row's own transfer key); a definite refusal fails the row and opens a manual one
 * for the same amount; a timeout keeps the row pending and the retry gets the same transfer; a
 * member who is not ready goes to the manual path, unless an earlier attempt may have reached
 * Stripe; the manual adapter moves nothing. Ledger checks after each: balances, and the payable
 * equals the allocation less what was paid out.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { B8_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import {
  PAYOUT_TRANSFER_KEY_WINDOW_MS,
  accounts,
  insertFraudFlag,
  patronageAllocation,
  payoutTransferKey,
  post,
  rawBalance,
} from "@commonair/ledger";
import {
  StripeOutcomeUnknown,
  StripeRequestError,
  type PaymentAdapter,
  type TransferRequest,
  type TransferResult,
} from "@commonair/payments";
import { owedCents, runPatronagePayout } from "../src/coop/patronage-payout.ts";
import { job } from "../src/jobs/patronage-payout.ts";
import { transferAdapterFromEnv } from "../src/money/transfers.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const STRIPE_MOCK = process.env.STRIPE_MOCK_URL ?? "http://127.0.0.1:12111";
const mockUp = await fetch(`${STRIPE_MOCK}/v1/customers`, {
  headers: { authorization: "Bearer sk_test_123" },
  signal: AbortSignal.timeout(1_000),
})
  .then((r) => r.ok)
  .catch(() => false);
if (!mockUp && process.env.CI) throw new Error(`stripe-mock is not reachable at ${STRIPE_MOCK} (CI is set)`);
if (!mockUp) console.warn(`stripe-mock is not reachable at ${STRIPE_MOCK}; skipping its test`);

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());

const ctx = () => env.worker.ctx;
const db = () => env.t.db;
const LAST = { lastAttempt: true };
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const NOT_LAST = { lastAttempt: false };

let periods = 0;
let staff: { computer: string; approver: string } | null = null;
async function treasurers() {
  if (staff) return staff;
  const a = await makeUser(db());
  const b = await makeUser(db());
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, a.user.id));
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, b.user.id));
  staff = { computer: a.user.id, approver: b.user.id };
  return staff;
}

/** An approved period allocating `cents` to `userId`, with one pending row for them. */
async function approvedWithRow(userId: string, cents: number, provider: "stripe" | "manual" = "stripe") {
  const s = await treasurers();
  periods += 1;
  const periodId = uuidv7();
  await db()
    .insert(schema.patronagePeriods)
    .values({
      id: periodId,
      periodStart: new Date(Date.UTC(2002, periods, 1)),
      periodEnd: new Date(Date.UTC(2002, periods + 1, 1)),
      status: "computed",
      formulaVersion: "test",
      weights: {
        revenue: 1,
        streamingHours: 0,
        relayBandwidth: 0,
        viewerHours: 0,
        dailyStreamingHourCap: 12,
        viewerHoursChannelCap: 1,
      },
      surplusCents: cents,
      currency: "usd",
      computedAt: new Date(),
      computedById: s.computer,
    });
  await db().insert(schema.patronageAllocations).values({ periodId, userId, amountCents: cents, lines: [] });
  const r = await post(
    db(),
    patronageAllocation({
      periodId,
      currency: "usd",
      occurredAt: new Date(),
      allocations: [{ userId, amountCents: cents }],
    }),
  );
  await db()
    .update(schema.patronagePeriods)
    .set({ status: "approved", approvedAt: new Date(), approvedById: s.approver, ledgerTransactionId: r.transactionId })
    .where(eq(schema.patronagePeriods.id, periodId));
  const id = uuidv7();
  await env.t.app.db.insert(schema.patronagePayouts).values({
    id,
    periodId,
    userId,
    amountCents: cents,
    currency: "usd",
    provider,
    idempotencyKey: `patronage-payout:${id}`,
  });
  return { periodId, userId, payoutId: id };
}

async function member(opts: { enabled?: boolean } = {}) {
  const u = await makeUser(db());
  await db()
    .insert(schema.payoutAccounts)
    .values({
      userId: u.user.id,
      provider: "stripe",
      providerAccountId: `acct_${u.user.id.replace(/-/g, "").slice(-16)}`,
      payoutsEnabled: opts.enabled ?? true,
    });
  return u.user;
}

function fakeAdapter(answer: (r: TransferRequest, n: number) => Promise<TransferResult> | TransferResult) {
  const calls: TransferRequest[] = [];
  const adapter: Pick<PaymentAdapter, "provider" | "transfer"> = {
    provider: "stripe",
    transfer: async (r) => {
      calls.push(r);
      return answer(r, calls.length);
    },
  };
  return { adapter, calls };
}
const ok = (r: TransferRequest): TransferResult => ({
  providerRef: `tr_${r.payoutId.replace(/-/g, "").slice(-12)}`,
  amountCents: r.amountCents,
  currency: r.currency,
});

const rowsOf = (periodId: string) =>
  db().select().from(schema.patronagePayouts).where(eq(schema.patronagePayouts.periodId, periodId));
const owed = async (userId: string) => 0 - (await rawBalance(db(), accounts.patronagePayable(userId), "usd"));
const markers = async (payoutId: string) =>
  (
    await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "patronage_payout"), eq(schema.auditLog.subjectId, payoutId)))
  ).map((r) => r.action);
async function expectLedgerBalanced() {
  const off = await db().execute<{ transaction_id: string }>(sql`
    select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
  expect([...off]).toEqual([]);
}

describe("owedCents", () => {
  test("allocation less paid rows and what reversed rows kept", () => {
    expect(owedCents(500, [])).toBe(500);
    expect(owedCents(500, [{ status: "failed", amountCents: 500, reversedCents: 0 }])).toBe(500);
    expect(owedCents(500, [{ status: "reversed", amountCents: 500, reversedCents: 200 }])).toBe(200);
    expect(owedCents(500, [{ status: "paid", amountCents: 500, reversedCents: 0 }])).toBe(0);
  });
});

describe("the patronage-payout job", () => {
  test("is on the payments queue, on demand, with its payload", () => {
    expect(job.queue).toBe(QUEUES.payments);
    expect(job.name).toBe(B8_JOBS.patronagePayout);
    expect(job.schedule).toBeUndefined();
    expect(job.data.safeParse({ periodId: uuidv7(), userId: uuidv7() }).success).toBe(true);
  });

  test("a ready Express member is paid through the transfer service, keyed by the row", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 1_234);
    const { adapter, calls } = fakeAdapter(ok);
    expect(await owed(m.id)).toBe(1_234);
    const out = await runPatronagePayout(ctx(), { adapter }, r, NOT_LAST);
    expect(out).toEqual({ outcome: "paid", payoutId: r.payoutId });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      payoutId: r.payoutId,
      transferId: r.payoutId,
      destination: `acct_${m.id.replace(/-/g, "").slice(-16)}`,
      amountCents: 1_234,
      currency: "usd",
      idempotencyKey: payoutTransferKey(r.payoutId),
    });
    const [row] = await rowsOf(r.periodId);
    expect(row).toMatchObject({ status: "paid", provider: "stripe" });
    expect(row?.providerRef).toMatch(/^tr_/);
    const [posting] = await db()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `patronage-payout:${r.payoutId}`));
    expect(posting?.kind).toBe("patronage_payout");
    expect(await rawBalance(db(), accounts.cash("stripe"), "usd")).toBeLessThan(0);
    expect(await owed(m.id)).toBe(0);
    const events = await db().select().from(schema.events).where(eq(schema.events.type, "coop.patronage_payout.paid"));
    expect(events.some((e) => (e.payload as Record<string, unknown>).patronage_payout_id === r.payoutId)).toBe(true);
    expect(await markers(r.payoutId)).toEqual(
      expect.arrayContaining(["patronage.payout_sending", "patronage.payout_paid"]),
    );
    // Run again (a redelivered job): nothing is sent or posted twice.
    expect(await runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).toEqual({ outcome: "skipped", reason: "no_row" });
    expect(calls).toHaveLength(1);
    await expectLedgerBalanced();
  });

  test("a definite refusal (injected) fails the row and opens a manual one; nothing is posted", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 800);
    const { adapter } = fakeAdapter(() => {
      throw new StripeRequestError("refused", 400, "invalid_request_error", "account_invalid");
    });
    const out = await runPatronagePayout(ctx(), { adapter }, r, NOT_LAST);
    expect(out).toMatchObject({ outcome: "failed", payoutId: r.payoutId, code: "account_invalid" });
    const rows = await rowsOf(r.periodId);
    expect(rows.map((x) => [x.status, x.provider, x.amountCents]).toSorted(byJson)).toEqual(
      [
        ["failed", "stripe", 800],
        ["pending", "manual", 800],
      ].toSorted(byJson),
    );
    expect(await owed(m.id)).toBe(800);
    expect(await markers(r.payoutId)).toContain("patronage.payout_failed");
    await expectLedgerBalanced();
  });

  test("a timeout keeps the row pending; the retry asks again under the same key", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 600);
    const { adapter, calls } = fakeAdapter((req, n) => {
      if (n === 1) throw new StripeOutcomeUnknown("timeout", 504, null, null);
      return ok(req);
    });
    await expect(runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).rejects.toThrow(StripeOutcomeUnknown);
    const [pending] = await rowsOf(r.periodId);
    expect(pending?.status).toBe("pending");
    expect(await owed(m.id)).toBe(600);
    expect(await runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).toMatchObject({ outcome: "paid" });
    expect(calls.map((c) => c.idempotencyKey)).toEqual([payoutTransferKey(r.payoutId), payoutTransferKey(r.payoutId)]);
    expect(await owed(m.id)).toBe(0);
  });

  test("the last unanswered attempt leaves a marker for the treasurer", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 500);
    const { adapter } = fakeAdapter(() => {
      throw new StripeOutcomeUnknown("timeout", 504, null, null);
    });
    await expect(runPatronagePayout(ctx(), { adapter }, r, LAST)).rejects.toThrow(StripeOutcomeUnknown);
    expect(await markers(r.payoutId)).toContain("patronage.payout_outcome_unknown");
    const [row] = await rowsOf(r.periodId);
    expect(row).toMatchObject({ status: "pending", provider: "stripe" });
  });

  test("a row whose outcome is unknown is never sent again, even when queued again", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 450);
    const { adapter, calls } = fakeAdapter((req, n) => {
      if (n === 1) throw new StripeOutcomeUnknown("timeout", 504, null, null);
      return ok(req);
    });
    await expect(runPatronagePayout(ctx(), { adapter }, r, LAST)).rejects.toThrow(StripeOutcomeUnknown);
    expect(await runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).toEqual({
      outcome: "unknown",
      payoutId: r.payoutId,
    });
    expect(calls).toHaveLength(1);
    const [row] = await rowsOf(r.periodId);
    expect(row).toMatchObject({ status: "pending", provider: "stripe" });
  });

  test("past Stripe's idempotency window a maybe-sent row is not sent again", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 650);
    const { adapter, calls } = fakeAdapter((req, n) => {
      if (n === 1) throw new StripeOutcomeUnknown("timeout", 504, null, null);
      return ok(req);
    });
    await expect(runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).rejects.toThrow(StripeOutcomeUnknown);
    const later = new Date(Date.now() + PAYOUT_TRANSFER_KEY_WINDOW_MS + 60_000);
    const lateCtx = { ...ctx(), now: () => later };
    expect(await runPatronagePayout(lateCtx, { adapter }, r, NOT_LAST)).toEqual({
      outcome: "unknown",
      payoutId: r.payoutId,
    });
    expect(calls).toHaveLength(1);
    expect(await markers(r.payoutId)).toContain("patronage.payout_outcome_unknown");
    const [row] = await rowsOf(r.periodId);
    expect(row).toMatchObject({ status: "pending", provider: "stripe" });
    expect(await owed(m.id)).toBe(650);
  });

  test("a row never sent is sent whatever its age", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 350);
    const { adapter, calls } = fakeAdapter(ok);
    const lateCtx = { ...ctx(), now: () => new Date(Date.now() + PAYOUT_TRANSFER_KEY_WINDOW_MS + 60_000) };
    expect(await runPatronagePayout(lateCtx, { adapter }, r, NOT_LAST)).toMatchObject({ outcome: "paid" });
    expect(calls).toHaveLength(1);
  });

  test("a member whose account is not ready (or held, or deleted) goes to the manual path", async () => {
    const notReady = await member({ enabled: false });
    const a = await approvedWithRow(notReady.id, 300);
    const { adapter, calls } = fakeAdapter(ok);
    expect(await runPatronagePayout(ctx(), { adapter }, a, NOT_LAST)).toMatchObject({
      outcome: "manual",
      reason: "account_not_ready",
    });
    const held = await member();
    await insertFraudFlag(db(), {
      payeeUserId: held.id,
      kind: "manual",
      evidence: {},
      raisedById: null,
      at: new Date(),
    });
    const b = await approvedWithRow(held.id, 300);
    expect(await runPatronagePayout(ctx(), { adapter }, b, NOT_LAST)).toMatchObject({
      outcome: "manual",
      reason: "held",
    });
    const deleted = await member();
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, deleted.id));
    const c = await approvedWithRow(deleted.id, 300);
    expect(await runPatronagePayout(ctx(), { adapter }, c, NOT_LAST)).toMatchObject({
      outcome: "manual",
      reason: "account_deleted",
    });
    expect(calls).toHaveLength(0);
    const [row] = await rowsOf(a.periodId);
    expect(row).toMatchObject({ status: "pending", provider: "manual" });
    expect(await owed(deleted.id)).toBe(300);
    // A manual row is not the job's.
    expect(await runPatronagePayout(ctx(), { adapter }, a, NOT_LAST)).toEqual({
      outcome: "skipped",
      reason: "manual_row",
    });
  });

  test("not ready after an attempt that may have reached Stripe: left for a person, never manual", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 700);
    const { adapter } = fakeAdapter(() => {
      throw new StripeOutcomeUnknown("timeout", 504, null, null);
    });
    await expect(runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).rejects.toThrow(/timeout/);
    await db()
      .update(schema.payoutAccounts)
      .set({ payoutsEnabled: false })
      .where(eq(schema.payoutAccounts.userId, m.id));
    expect(await runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).toEqual({
      outcome: "unknown",
      payoutId: r.payoutId,
    });
    const [row] = await rowsOf(r.periodId);
    expect(row).toMatchObject({ status: "pending", provider: "stripe" });
  });

  test("the manual adapter moves nothing", async () => {
    const m = await member();
    const r = await approvedWithRow(m.id, 200);
    expect(await runPatronagePayout(ctx(), { adapter: { provider: "manual" } }, r, NOT_LAST)).toEqual({
      outcome: "skipped",
      reason: "manual_adapter",
    });
    const [row] = await rowsOf(r.periodId);
    expect(row?.status).toBe("pending");
  });

  test.skipIf(!mockUp)("through the real Stripe adapter on stripe-mock", async () => {
    const adapter = transferAdapterFromEnv({
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_API_BASE: STRIPE_MOCK,
    });
    const m = await member();
    const r = await approvedWithRow(m.id, 900);
    expect(await runPatronagePayout(ctx(), { adapter }, r, NOT_LAST)).toMatchObject({ outcome: "paid" });
    expect((await rowsOf(r.periodId))[0]?.providerRef).toMatch(/^tr_/);
    expect(await owed(m.id)).toBe(0);
    await expectLedgerBalanced();
  });
});
