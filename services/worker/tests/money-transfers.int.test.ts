// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `payout-transfers` job (M1-connect; ADR 0007 Amendment 1) against a real database, with an
 * injected adapter (faults on demand) and, when it is running, stripe-mock: one transfer per payout
 * with its own key, nothing with the manual adapter, a not-ready or held payee cancelled back to the
 * payable without calling Stripe, a timeout kept pending and retried under the same key, and the
 * audit and outbox rows.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import {
  DEFAULT_PLATFORM_CUT,
  creatorBalances,
  holdPayoutsForFraud,
  insertFraudFlag,
  payoutTransferKey,
  paymentSucceeded,
  post,
  releaseDueHolds,
  runPayoutBatch,
  schedulePayoutTransfers,
} from "@commonair/ledger";
import {
  StripeOutcomeUnknown,
  StripeRequestError,
  type PaymentAdapter,
  type TransferRequest,
  type TransferResult,
} from "@commonair/payments";
import { B8_JOBS, QUEUES } from "@commonair/contracts/internal";
import { job } from "../src/jobs/payout-transfers.ts";
import { runPayoutTransfer, transferAdapterFromEnv } from "../src/money/transfers.ts";
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
const mails: { template: string; props: Record<string, unknown>; to: string }[] = [];

beforeAll(async () => {
  env = await setup({
    jobs: [],
    outbox: false,
    segments: false,
    mailer: {
      send: async (template: string, props: Record<string, unknown>, to: string) => {
        mails.push({ template, props, to });
      },
    } as never,
    site: { publicUrl: "https://example.test" } as never,
  });
});
afterAll(() => env.close());

const ctx = () => env.worker.ctx;
const db = () => env.t.db;
const DAY = 86_400_000;
const LAST = { lastAttempt: true };
const NOT_LAST = { lastAttempt: false };

let periods = 0;
/** A fresh far-future month per run, so each run's payouts are its own. */
function period() {
  periods += 1;
  const start = new Date(Date.UTC(2090, periods, 1));
  return { periodStart: start, periodEnd: new Date(Date.UTC(2090, periods + 1, 1)) };
}

/** A payee with a Stripe account (enabled by default) and released earnings in usd. */
async function payee(opts: { enabled?: boolean; provider?: "stripe" | "manual" } = {}) {
  const u = await makeUser(db());
  const provider = opts.provider ?? "stripe";
  await db()
    .insert(schema.payoutAccounts)
    .values({
      userId: u.user.id,
      provider,
      providerAccountId: provider === "stripe" ? `acct_${u.user.id.replace(/-/g, "").slice(-16)}` : "ref",
      payoutsEnabled: opts.enabled ?? true,
    });
  await post(
    db(),
    paymentSucceeded({
      paymentId: uuidv7(),
      paymentKind: "tip",
      provider: "stripe",
      creatorUserId: u.user.id,
      grossCents: 10_000,
      taxCents: 0,
      feeCents: 0,
      currency: "usd",
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: new Date(Date.now() - 30 * DAY),
    }),
  );
  await releaseDueHolds(db(), { asOf: new Date(), holdDays: 7, currency: "usd" });
  return u.user;
}

/** Run a payout batch and schedule: the payouts of `users`. */
async function run(users: { id: string }[]) {
  await runPayoutBatch(db(), { ...period(), currency: "usd", minimumCents: 1_000 });
  await schedulePayoutTransfers(db());
  const rows = await db()
    .select()
    .from(schema.payouts)
    .where(
      inArray(
        schema.payouts.userId,
        users.map((u) => u.id),
      ),
    );
  return rows;
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
const okAnswer = (r: TransferRequest): TransferResult => ({
  providerRef: `tr_${r.transferId.replace(/-/g, "").slice(-20)}`,
  amountCents: r.amountCents,
  currency: r.currency,
});

const transferOf = async (payoutId: string) =>
  (await db().select().from(schema.payoutTransfers).where(eq(schema.payoutTransfers.payoutId, payoutId)))[0];
const payoutOf = async (id: string) => (await db().select().from(schema.payouts).where(eq(schema.payouts.id, id)))[0];

describe("payout-transfers", () => {
  test("a run with two recipients makes two transfers with distinct keys, pays both, and mails", async () => {
    const a = await payee();
    const b = await payee();
    const payouts = await run([a, b]);
    expect(payouts.map((p) => p.status)).toEqual(["scheduled", "scheduled"]);
    const { adapter, calls } = fakeAdapter(okAnswer);
    for (const p of payouts)
      expect(await runPayoutTransfer(ctx(), { adapter }, p.id, NOT_LAST)).toMatchObject({ outcome: "created" });
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(2);
    for (const [i, p] of payouts.entries()) {
      expect(calls[i]).toMatchObject({
        payoutId: p.id,
        idempotencyKey: payoutTransferKey(p.id),
        amountCents: p.amountCents,
        currency: "usd",
        group: p.periodStart.toISOString(),
      });
      expect(calls[i]?.destination).toMatch(/^acct_/);
      const tr = await transferOf(p.id);
      expect(tr).toMatchObject({ status: "created", idempotencyKey: payoutTransferKey(p.id) });
      expect((await payoutOf(p.id))?.status).toBe("paid");
    }
    const events = await db()
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(eq(schema.events.type, "money.payout_transfer.created"));
    const ids = events.map((e) => (e.payload as { payout_id: string }).payout_id);
    for (const p of payouts) expect(ids).toContain(p.id);
    const sent = mails.filter((m) => m.template === "payoutSent");
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.at(-1)?.props).toMatchObject({ currency: "usd", earningsUrl: "https://example.test/revenue" });
    // A redelivered job changes nothing and calls Stripe no more.
    for (const p of payouts)
      expect(await runPayoutTransfer(ctx(), { adapter }, p.id, NOT_LAST)).toEqual({
        outcome: "skipped",
        reason: "settled",
      });
    expect(calls).toHaveLength(2);
  });

  test("the manual adapter moves nothing and opens no row", async () => {
    const u = await payee();
    const [p] = await run([u]);
    const manual = transferAdapterFromEnv({ PAYMENTS_PROVIDER: "manual" });
    expect("transfer" in manual).toBe(false);
    expect(await runPayoutTransfer(ctx(), { adapter: manual }, p!.id, NOT_LAST)).toEqual({
      outcome: "skipped",
      reason: "manual",
    });
    expect(await transferOf(p!.id)).toBeUndefined();
    expect((await payoutOf(p!.id))?.status).toBe("scheduled");
  });

  test("a manual payout is never transferred", async () => {
    const u = await payee({ provider: "manual" });
    const [p] = await run([u]);
    expect(p?.status).toBe("pending");
    const { adapter, calls } = fakeAdapter(okAnswer);
    expect(await runPayoutTransfer(ctx(), { adapter }, p!.id, NOT_LAST)).toEqual({
      outcome: "skipped",
      reason: "not_scheduled",
    });
    expect(calls).toHaveLength(0);
  });

  test("a payee no longer onboarded is cancelled back to the payable; Stripe is not called", async () => {
    const u = await payee();
    const [p] = await run([u]);
    await db()
      .update(schema.payoutAccounts)
      .set({ payoutsEnabled: false })
      .where(eq(schema.payoutAccounts.userId, u.id));
    const { adapter, calls } = fakeAdapter(okAnswer);
    expect(await runPayoutTransfer(ctx(), { adapter }, p!.id, NOT_LAST)).toMatchObject({
      outcome: "failed",
      code: "account_not_ready",
    });
    expect(calls).toHaveLength(0);
    expect((await payoutOf(p!.id))?.status).toBe("failed");
    expect((await creatorBalances(db(), u.id, "usd")).availableCents).toBe(p!.amountCents);
    const audits = await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectType, "payout_transfer"));
    expect(audits.some((x) => x.action === "payout_transfer.failed")).toBe(true);
  });

  test("a held payee is never transferred to", async () => {
    // Held before the job ran: no row is opened, the payout stays held for the review.
    const early = await payee();
    const [e] = await run([early]);
    await insertFraudFlag(db(), {
      payeeUserId: early.id,
      kind: "manual",
      evidence: {},
      raisedById: null,
      at: new Date(),
    });
    await holdPayoutsForFraud(db(), early.id);
    const first = fakeAdapter(okAnswer);
    expect(await runPayoutTransfer(ctx(), { adapter: first.adapter }, e!.id, NOT_LAST)).toEqual({
      outcome: "skipped",
      reason: "not_scheduled",
    });
    expect(first.calls).toHaveLength(0);
    expect((await payoutOf(e!.id))?.status).toBe("held");

    // Held after the row opened (a retry finds it): the transfer fails `held`, the payout is cancelled.
    const late = await payee();
    const [p] = await run([late]);
    const timeout = fakeAdapter(() => {
      throw new StripeOutcomeUnknown("timed out", 503, null, null);
    });
    await expect(runPayoutTransfer(ctx(), { adapter: timeout.adapter }, p!.id, NOT_LAST)).rejects.toThrow(/timed out/);
    await insertFraudFlag(db(), {
      payeeUserId: late.id,
      kind: "manual",
      evidence: {},
      raisedById: null,
      at: new Date(),
    });
    await holdPayoutsForFraud(db(), late.id);
    const { adapter, calls } = fakeAdapter(okAnswer);
    expect(await runPayoutTransfer(ctx(), { adapter }, p!.id, NOT_LAST)).toMatchObject({
      outcome: "failed",
      code: "held",
    });
    expect(calls).toHaveLength(0);
    expect((await payoutOf(p!.id))?.status).toBe("failed");
    expect((await transferOf(p!.id))?.status).toBe("failed");
  });

  test("a timeout keeps the transfer pending; the retry reuses the key; the last attempt says outcome unknown", async () => {
    const u = await payee();
    const [p] = await run([u]);
    const flaky = fakeAdapter((_r, n) => {
      if (n <= 2) throw new StripeOutcomeUnknown("timed out", 503, null, null);
      return okAnswer(_r);
    });
    await expect(runPayoutTransfer(ctx(), { adapter: flaky.adapter }, p!.id, NOT_LAST)).rejects.toThrow(
      StripeOutcomeUnknown,
    );
    expect(await transferOf(p!.id)).toMatchObject({ status: "pending", failureCode: null });
    await expect(runPayoutTransfer(ctx(), { adapter: flaky.adapter }, p!.id, LAST)).rejects.toThrow(
      StripeOutcomeUnknown,
    );
    expect(await transferOf(p!.id)).toMatchObject({ status: "pending", failureCode: "outcome_unknown" });
    expect((await payoutOf(p!.id))?.status).toBe("scheduled");
    // A later run's job: the same key, and Stripe's answer settles it.
    expect(await runPayoutTransfer(ctx(), { adapter: flaky.adapter }, p!.id, NOT_LAST)).toMatchObject({
      outcome: "created",
    });
    expect(new Set(flaky.calls.map((c) => c.idempotencyKey))).toEqual(new Set([payoutTransferKey(p!.id)]));
    expect(new Set(flaky.calls.map((c) => c.transferId)).size).toBe(1);
    expect(await transferOf(p!.id)).toMatchObject({ status: "created", failureCode: null });
  });

  test("a deleted account (4xx resource_missing) cancels the payout and marks the account not ready", async () => {
    const u = await payee();
    const [p] = await run([u]);
    const { adapter } = fakeAdapter(() => {
      throw new StripeRequestError("No such destination", 400, "invalid_request_error", "resource_missing");
    });
    expect(await runPayoutTransfer(ctx(), { adapter }, p!.id, NOT_LAST)).toMatchObject({
      outcome: "failed",
      code: "resource_missing",
    });
    expect((await payoutOf(p!.id))?.status).toBe("failed");
    const [acct] = await db().select().from(schema.payoutAccounts).where(eq(schema.payoutAccounts.userId, u.id));
    expect(acct?.payoutsEnabled).toBe(false);
  });

  test("a currency the account refuses (a 4xx without a code) fails with the HTTP status", async () => {
    const u = await payee();
    const [p] = await run([u]);
    const { adapter } = fakeAdapter(() => {
      throw new StripeRequestError("currency not supported", 400, "invalid_request_error", null);
    });
    expect(await runPayoutTransfer(ctx(), { adapter }, p!.id, NOT_LAST)).toMatchObject({
      outcome: "failed",
      code: "stripe_400",
    });
    const [acct] = await db().select().from(schema.payoutAccounts).where(eq(schema.payoutAccounts.userId, u.id));
    expect(acct?.payoutsEnabled).toBe(true);
    expect((await creatorBalances(db(), u.id, "usd")).availableCents).toBe(p!.amountCents);
  });

  test("a hold raised while Stripe creates the transfer keeps Stripe's id on the pending row", async () => {
    const u = await payee();
    const [p] = await run([u]);
    const { adapter } = fakeAdapter(async (r) => {
      await insertFraudFlag(db(), {
        payeeUserId: u.id,
        kind: "manual",
        evidence: {},
        raisedById: null,
        at: new Date(),
      });
      await holdPayoutsForFraud(db(), u.id);
      return okAnswer(r);
    });
    expect(await runPayoutTransfer(ctx(), { adapter }, p!.id, NOT_LAST)).toMatchObject({ outcome: "unrecorded" });
    const tr = await transferOf(p!.id);
    expect(tr).toMatchObject({ status: "pending", failureCode: "sent_unrecorded" });
    expect(tr?.providerRef).toMatch(/^tr_/);
    expect((await payoutOf(p!.id))?.status).toBe("held");
    // Not cancelled while held, and not sent again.
    const again = fakeAdapter(okAnswer);
    expect(await runPayoutTransfer(ctx(), { adapter: again.adapter }, p!.id, NOT_LAST)).toEqual({
      outcome: "skipped",
      reason: "waiting",
    });
    expect(again.calls).toHaveLength(0);
  });

  test("the registered job: queue, attempts, and the last-attempt flag", async () => {
    expect(job.queue).toBe(QUEUES.payments);
    expect(job.name).toBe(B8_JOBS.payoutTransfers);
    expect(job.attempts).toBeGreaterThan(1);
    expect(job.schedule).toBeUndefined();
  });

  test.skipIf(!mockUp)("against stripe-mock: the transfer is created and the payout paid", async () => {
    const u = await payee();
    const [p] = await run([u]);
    const adapter = transferAdapterFromEnv({
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_API_BASE: STRIPE_MOCK,
    });
    expect(await runPayoutTransfer(ctx(), { adapter }, p!.id, NOT_LAST)).toMatchObject({ outcome: "created" });
    const tr = await transferOf(p!.id);
    expect(tr?.providerRef).toMatch(/^tr_/);
    expect((await payoutOf(p!.id))?.status).toBe("paid");
    const rows = await db()
      .select()
      .from(schema.payoutTransfers)
      .where(and(eq(schema.payoutTransfers.payoutId, p!.id), eq(schema.payoutTransfers.status, "created")));
    expect(rows).toHaveLength(1);
  });
});
