// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `refund-reconcile` against Postgres (ADR 0007 decisions 2 and 3), driven by an injected provider
 * port because stripe-mock is stateless: each outcome of an unknown request (succeeded, pending,
 * failed, none, a refund of another amount, no answer), the webhook settling it first, the window,
 * and the sweep that makes the automatic refunds the API's hook missed. Also the gift window's
 * expiry by `money-expire-pending` (decision (d)): a gift fails at 24 h, not at 23 h.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { StripeOutcomeUnknown, StripeRequestError } from "@commonair/payments";
import { expirePendingPayments } from "../src/money/expire.ts";
import {
  PAID_AFTER_END,
  type ProviderRefund,
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REQUESTED,
  REFUND_SUBMITTED,
  RECONCILE_MIN_AGE_MS,
  type RefundPort,
  reconcileUnknownRefunds,
  runRefundReconcile,
  sweepPaidAfterEnd,
} from "../src/money/refund-reconcile.ts";
import type { MoneyJobConfig } from "../src/money/config.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
let NOW = new Date("2026-11-03T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const cfg: MoneyJobConfig = { currency: "usd", pendingDays: 7, batchSize: 500, budgetMs: 30_000 };

const logs: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
const logger = {
  debug: () => {},
  info: (msg: string, fields: Record<string, unknown> = {}) => logs.push({ level: "info", msg, fields }),
  warn: (msg: string, fields: Record<string, unknown> = {}) => logs.push({ level: "warn", msg, fields }),
  error: (msg: string, fields: Record<string, unknown> = {}) => logs.push({ level: "error", msg, fields }),
  child: () => logger,
};

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, now: () => NOW });
}, 120_000);
afterAll(() => env.close());

const db = () => env.t.db;
const ctx = () => ({ db: db(), logger: logger as never, now: () => NOW });
let n = 0;

async function stripePayment(over: Partial<typeof schema.payments.$inferInsert> = {}) {
  const owner = await makeUser(db());
  const payer = await makeUser(db());
  const [p] = await db()
    .insert(schema.payments)
    .values({
      id: uuidv7(),
      provider: "stripe",
      providerRef: `pi_rec${++n}${Math.random().toString(36).slice(2, 8)}`,
      kind: "tip",
      status: "succeeded",
      userId: payer.user.id,
      channelId: owner.channel.id,
      amountCents: 500,
      currency: "usd",
      quantity: 1,
      succeededAt: ago(DAY),
      createdAt: ago(DAY),
      ...over,
    })
    .returning();
  return { p: p!, owner, payer };
}

async function marker(paymentId: string, action: string, details: Record<string, unknown>, at: Date) {
  await db()
    .insert(schema.auditLog)
    .values({
      id: uuidv7(at.getTime()),
      actorType: "system",
      action,
      subjectType: "payment",
      subjectId: paymentId,
      details,
      createdAt: at,
    });
}

/** A request whose outcome is unknown, made `age` ago. */
async function unknownRequest(paymentId: string, amountCents: number, age: number) {
  const requestId = uuidv7();
  await marker(paymentId, REFUND_REQUESTED, { requestId, amountCents, provider: "stripe" }, ago(age));
  await marker(
    paymentId,
    REFUND_OUTCOME_UNKNOWN,
    { requestId, idempotencyKey: `refund-${paymentId}-0-${amountCents}` },
    ago(age - 1000),
  );
  return requestId;
}

const markersOf = async (paymentId: string) =>
  db()
    .select({ action: schema.auditLog.action, details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectType, "payment"), eq(schema.auditLog.subjectId, paymentId)))
    .orderBy(schema.auditLog.createdAt, schema.auditLog.id);

function port(listing: Record<string, ProviderRefund[] | Error>, refunds: unknown[] = []): RefundPort {
  return {
    provider: "stripe",
    async listRefunds(pi) {
      const v = listing[pi] ?? [];
      if (v instanceof Error) throw v;
      return v;
    },
    async refund(r) {
      refunds.push(r);
      return { providerRef: `re_sweep_${refunds.length}` };
    },
  };
}
const refundOf = (over: Partial<ProviderRefund>): ProviderRefund => ({
  id: `re_${Math.random().toString(36).slice(2, 10)}`,
  amountCents: 500,
  currency: "usd",
  status: "succeeded",
  metadata: {},
  ...over,
});

describe("reconciling unknown outcomes", () => {
  test("each outcome, by what the provider lists", async () => {
    const ok = await stripePayment();
    const pending = await stripePayment();
    const failed = await stripePayment();
    const nothing = await stripePayment();
    const other = await stripePayment();
    const silent = await stripePayment();
    for (const x of [ok, pending, failed, nothing, other, silent]) await unknownRequest(x.p.id, 500, 30 * MIN);
    logs.length = 0;
    const r = await reconcileUnknownRefunds(
      ctx(),
      port({
        [ok.p.providerRef]: [refundOf({})],
        [pending.p.providerRef]: [refundOf({ status: "pending" })],
        [failed.p.providerRef]: [refundOf({ status: "failed", id: "re_failed_one" })],
        [nothing.p.providerRef]: [],
        [other.p.providerRef]: [refundOf({ amountCents: 200 })],
        [silent.p.providerRef]: new StripeOutcomeUnknown("timeout", 504, null, null),
      }),
    );
    expect(r).toMatchObject({ succeeded: 1, pending: 1, failed: 1, none: 1, mismatch: 1, unanswered: 1 });

    // Succeeded: no marker (the webhook posts), a warn naming the payment only.
    expect((await markersOf(ok.p.id)).map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_OUTCOME_UNKNOWN]);
    expect(logs.some((l) => l.level === "warn" && l.fields.paymentId === ok.p.id)).toBe(true);
    for (const x of [pending, other, silent])
      expect((await markersOf(x.p.id)).map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_OUTCOME_UNKNOWN]);
    expect(logs.some((l) => l.level === "warn" && l.fields.paymentId === other.p.id)).toBe(true);

    const f = (await markersOf(failed.p.id)).at(-1);
    expect(f).toMatchObject({
      action: "payment.refund_request_failed",
      details: { reason: "reconciled_failed", refundRef: "re_failed_one" },
    });
    const z = (await markersOf(nothing.p.id)).at(-1);
    expect(z).toMatchObject({ action: "payment.refund_request_failed", details: { reason: "reconciled_none" } });

    // Released: a second run writes nothing more for them.
    await reconcileUnknownRefunds(ctx(), port({ [nothing.p.providerRef]: [] }));
    expect((await markersOf(nothing.p.id)).filter((m) => m.action === "payment.refund_request_failed")).toHaveLength(1);
    // Logs carry ids only.
    for (const l of logs) expect(JSON.stringify(l)).not.toMatch(/@example\.test/);
  });

  test("a request settled by its webhook meanwhile gets no failure marker", async () => {
    const x = await stripePayment();
    await unknownRequest(x.p.id, 500, 30 * MIN);
    // The refund was posted (charge.refunded) before the reconciler looks. Stamped on the test
    // clock: a wall-clock createdAt falls outside the request's 24 h window once NOW is a day old.
    await db()
      .insert(schema.disputes)
      .values({
        paymentId: x.p.id,
        kind: "refund",
        status: "closed",
        amountCents: 500,
        providerRef: "re_posted",
        createdAt: ago(20 * MIN),
      });
    const r = await reconcileUnknownRefunds(ctx(), port({ [x.p.providerRef]: [] }));
    expect(r.none).toBe(0);
    expect((await markersOf(x.p.id)).map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_OUTCOME_UNKNOWN]);
  });

  test("an outcome that just became unknown is not asked about yet: Stripe may still be processing", async () => {
    const x = await stripePayment();
    await unknownRequest(x.p.id, 500, 2 * MIN);
    const r = await reconcileUnknownRefunds(ctx(), port({ [x.p.providerRef]: [] }));
    expect(r.none).toBe(0);
    expect((await markersOf(x.p.id)).map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_OUTCOME_UNKNOWN]);
    // Once RECONCILE_MIN_AGE_MS has passed, an empty listing is "none".
    const later = { ...ctx(), now: () => new Date(NOW.getTime() + RECONCILE_MIN_AGE_MS) };
    await reconcileUnknownRefunds(later, port({ [x.p.providerRef]: [] }));
    expect((await markersOf(x.p.id)).at(-1)).toMatchObject({
      action: "payment.refund_request_failed",
      details: { reason: "reconciled_none" },
    });
  });

  test("requests older than 7 days, and providers that cannot list, are left alone", async () => {
    const old = await stripePayment();
    await unknownRequest(old.p.id, 500, 8 * DAY);
    const r = await reconcileUnknownRefunds(ctx(), port({ [old.p.providerRef]: [] }));
    expect((await markersOf(old.p.id)).map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_OUTCOME_UNKNOWN]);
    expect(r.none).toBe(0);

    const y = await stripePayment();
    await unknownRequest(y.p.id, 500, 30 * MIN);
    const cannot = await reconcileUnknownRefunds(ctx(), { provider: "stripe", listRefunds: null, refund: null });
    expect(cannot.unsupported).toBeGreaterThanOrEqual(1);
    expect((await markersOf(y.p.id)).map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_OUTCOME_UNKNOWN]);
  });
});

describe("the automatic-refund sweep (the durable trigger)", () => {
  async function bookedAfterEnd(age: number) {
    const { p, owner, payer } = await stripePayment({ kind: "subscription", tier: 1 });
    const [sub] = await db()
      .insert(schema.subscriptions)
      .values({
        id: uuidv7(),
        subscriberId: payer.user.id,
        channelId: owner.channel.id,
        tier: 1,
        status: "canceled",
        provider: "stripe",
        providerRef: `sub_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        priceCents: 500,
        currency: "usd",
        updatedAt: ago(age + HOUR),
      })
      .returning();
    await db()
      .update(schema.payments)
      .set({ subscriptionId: sub!.id, createdAt: ago(age), succeededAt: ago(age) })
      .where(eq(schema.payments.id, p.id));
    return { ...p, subscriptionId: sub!.id };
  }

  test("asks for the full amount once, as the system, with the API's key; never reactivates", async () => {
    const p = await bookedAfterEnd(30 * MIN);
    const calls: { paymentId: string; amountCents: number; idempotencyKey: string }[] = [];
    const r = await sweepPaidAfterEnd(ctx(), port({}, calls));
    expect(r.requested).toBeGreaterThanOrEqual(1);
    expect(calls.find((c) => c.paymentId === p.id)).toMatchObject({
      amountCents: 500,
      idempotencyKey: `refund-${p.id}-0-500`,
    });
    const ms = await markersOf(p.id);
    expect(ms.map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_SUBMITTED]);
    expect(ms[0]?.details).toMatchObject({ amountCents: 500, reason: PAID_AFTER_END });
    const [sub] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, p.subscriptionId));
    expect(sub?.status).toBe("canceled");
    // Idempotent: the next run finds the request.
    const before = calls.length;
    await sweepPaidAfterEnd(ctx(), port({}, calls));
    expect(calls.filter((c) => c.paymentId === p.id)).toHaveLength(1);
    expect(calls.length).toBe(before);
  });

  test("leaves the hook its 15 minutes, skips normal renewals of later-ended subscriptions", async () => {
    const fresh = await bookedAfterEnd(5 * MIN);
    // A renewal booked while active, the subscription ended a day later: not paid after its end.
    const { p: normal, owner, payer } = await stripePayment({ kind: "subscription", tier: 1, createdAt: ago(3 * DAY) });
    const [sub] = await db()
      .insert(schema.subscriptions)
      .values({
        id: uuidv7(),
        subscriberId: payer.user.id,
        channelId: owner.channel.id,
        tier: 1,
        status: "canceled",
        provider: "stripe",
        priceCents: 500,
        currency: "usd",
        updatedAt: ago(2 * DAY),
      })
      .returning();
    await db().update(schema.payments).set({ subscriptionId: sub!.id }).where(eq(schema.payments.id, normal.id));
    const calls: { paymentId: string }[] = [];
    await sweepPaidAfterEnd(ctx(), port({}, calls));
    expect(calls.some((c) => c.paymentId === fresh.id)).toBe(false);
    expect(calls.some((c) => c.paymentId === normal.id)).toBe(false);
  });

  test("a partly refunded booking is refunded for the rest; a timeout is unknown, a 4xx failed", async () => {
    const partial = await bookedAfterEnd(40 * MIN);
    await db()
      .update(schema.payments)
      .set({ refundedCents: 200, status: "partially_refunded" })
      .where(eq(schema.payments.id, partial.id));
    const calls: { paymentId: string; amountCents: number; idempotencyKey: string }[] = [];
    await sweepPaidAfterEnd(ctx(), port({}, calls));
    expect(calls.find((c) => c.paymentId === partial.id)).toMatchObject({
      amountCents: 300,
      idempotencyKey: `refund-${partial.id}-200-300`,
    });

    const timeout = await bookedAfterEnd(50 * MIN);
    await sweepPaidAfterEnd(ctx(), {
      provider: "stripe",
      listRefunds: null,
      refund: async () => {
        throw new StripeOutcomeUnknown("timeout", 504, null, null);
      },
    });
    expect((await markersOf(timeout.id)).map((m) => m.action)).toEqual([REFUND_REQUESTED, REFUND_OUTCOME_UNKNOWN]);

    const refused = await bookedAfterEnd(55 * MIN);
    await sweepPaidAfterEnd(ctx(), {
      provider: "stripe",
      listRefunds: null,
      refund: async () => {
        throw new StripeRequestError("no", 400, null, null);
      },
    });
    expect((await markersOf(refused.id)).map((m) => m.action)).toEqual([
      REFUND_REQUESTED,
      "payment.refund_request_failed",
    ]);
  });

  async function gift(age: number, started: boolean) {
    const { p, owner } = await stripePayment({ kind: "subscription", tier: 1, gift: true, quantity: 1 });
    const recipient = await makeUser(db());
    await db()
      .insert(schema.subscriptions)
      .values({
        id: uuidv7(),
        subscriberId: recipient.user.id,
        channelId: owner.channel.id,
        tier: 1,
        status: started ? "canceled" : "expired",
        provider: "stripe",
        priceCents: 500,
        currency: "usd",
        giftPaymentId: p.id,
        ...(started ? { currentPeriodStart: ago(age + DAY), currentPeriodEnd: ago(age) } : {}),
      });
    await db()
      .update(schema.payments)
      .set({ createdAt: ago(age + DAY), succeededAt: ago(age) })
      .where(eq(schema.payments.id, p.id));
    return p;
  }

  test("a gift paid after its window (no gift subscription ever started) is refunded; a used gift is not", async () => {
    const late = await gift(30 * MIN, false);
    const used = await gift(30 * MIN, true);
    const fresh = await gift(5 * MIN, false);
    const calls: { paymentId: string; amountCents: number; idempotencyKey: string }[] = [];
    await sweepPaidAfterEnd(ctx(), port({}, calls));
    expect(calls.find((c) => c.paymentId === late.id)).toMatchObject({
      amountCents: 500,
      idempotencyKey: `refund-${late.id}-0-500`,
    });
    expect((await markersOf(late.id))[0]?.details).toMatchObject({ reason: PAID_AFTER_END });
    expect(calls.some((c) => c.paymentId === used.id)).toBe(false);
    expect(calls.some((c) => c.paymentId === fresh.id)).toBe(false);
  });

  test("one run does both passes", async () => {
    const r = await runRefundReconcile(ctx(), port({}));
    expect(r).toHaveProperty("reconcile");
    expect(r).toHaveProperty("sweep");
  });
});

describe("the gift window's expiry (decision (d))", () => {
  test("money-expire-pending fails an unpaid gift at 24 h and not at 23 h, freeing the recipients", async () => {
    const owner = await makeUser(db());
    const gifter = await makeUser(db());
    const r1 = await makeUser(db());
    const created = new Date(NOW.getTime());
    const [gift] = await db()
      .insert(schema.payments)
      .values({
        id: uuidv7(),
        provider: "manual",
        providerRef: `CA-GW${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        kind: "subscription",
        status: "pending",
        userId: gifter.user.id,
        channelId: owner.channel.id,
        amountCents: 500,
        currency: "usd",
        tier: 1,
        quantity: 1,
        gift: true,
        createdAt: created,
        // What `money.subscribe` sets for a gift: GIFT_PAYMENT_HOURS (24) after checkout.
        expiresAt: new Date(created.getTime() + 24 * HOUR),
      })
      .returning();
    const [sub] = await db()
      .insert(schema.subscriptions)
      .values({
        id: uuidv7(),
        subscriberId: r1.user.id,
        channelId: owner.channel.id,
        tier: 1,
        status: "incomplete",
        provider: "manual",
        priceCents: 500,
        currency: "usd",
        giftedById: gifter.user.id,
        giftPaymentId: gift!.id,
      })
      .returning();
    const status = async () =>
      (await db().select().from(schema.payments).where(eq(schema.payments.id, gift!.id)))[0]?.status;
    const saved = NOW;
    try {
      NOW = new Date(created.getTime() + 23 * HOUR);
      await expirePendingPayments(env.worker.ctx, cfg);
      expect(await status()).toBe("pending");
      NOW = new Date(created.getTime() + 24 * HOUR + MIN);
      await expirePendingPayments(env.worker.ctx, cfg);
      expect(await status()).toBe("failed");
      const [s] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, sub!.id));
      expect(s?.status).toBe("expired");
    } finally {
      NOW = saved;
    }
  });
});
