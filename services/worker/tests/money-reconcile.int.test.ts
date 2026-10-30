// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money-reconcile` against real postings: payments, a hold release, a refund, a chargeback and a
 * won chargeback reconcile with no mismatch; a second fixture database, built for it, holds a
 * payment with an extra balanced transaction that moves its settlement account (one mismatch).
 */
import { schema, uuidv7 } from "@commonair/db";
import {
  DEFAULT_PLATFORM_CUT,
  manualConfirmation,
  paymentSucceeded,
  post,
  postChargebackReversal,
  postReversal,
  releaseDueHolds,
} from "@commonair/ledger";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { job } from "../src/jobs/money-reconcile.ts";
import { RECONCILE_CURSOR_KEY, reconcilePayments } from "../src/money/reconcile.ts";
import { tip } from "./e6-fixtures.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

const run = (env: TestEnv) => job.handler({}, env.worker.ctx, { id: undefined, attemptsMade: 0 });

/** A succeeded Stripe-style subscription payment (cash settlement, a processor fee). */
async function stripePayment(env: TestEnv, owner: Awaited<ReturnType<typeof makeUser>>, payer: string, at: Date) {
  const db = env.t.db;
  const paymentId = uuidv7(at.getTime());
  await db.insert(schema.payments).values({
    id: paymentId,
    provider: "stripe",
    providerRef: `pi_${paymentId.replace(/-/g, "")}`,
    kind: "subscription",
    status: "succeeded",
    userId: payer,
    channelId: owner.channel.id,
    amountCents: 999,
    feeCents: 59,
    currency: "usd",
    tier: 2,
    succeededAt: at,
  });
  await post(
    db,
    paymentSucceeded({
      paymentId,
      paymentKind: "subscription",
      provider: "stripe",
      creatorUserId: owner.user.id,
      grossCents: 999,
      taxCents: 0,
      feeCents: 59,
      currency: "usd",
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: at,
    }),
  );
  return paymentId;
}

async function dispute(env: TestEnv, paymentId: string, kind: "refund" | "chargeback", cents: number) {
  const [d] = await env.t.db
    .insert(schema.disputes)
    .values({ id: uuidv7(), paymentId, kind, amountCents: cents, status: "open", reason: "test" })
    .returning();
  if (!d) throw new Error("no dispute");
  return d.id;
}

describe("real postings", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ jobs: [], outbox: false, segments: false });
  });
  afterAll(() => env.close());

  test("payments, a hold release, refunds and chargebacks (one won) reconcile", async () => {
    const db = env.t.db;
    const owner = await makeUser(db);
    const payer = await makeUser(db);
    const old = new Date(Date.now() - 20 * 86_400_000);

    const manualTip = await tip(db, {
      from: payer.user.id,
      channelId: owner.channel.id,
      creatorUserId: owner.user.id,
      cents: 700,
      message: "hi",
    });
    await stripePayment(env, owner, payer.user.id, old);
    expect((await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" })).released).toBe(1);
    const refunded = await stripePayment(env, owner, payer.user.id, new Date());
    const won = await stripePayment(env, owner, payer.user.id, new Date());

    await postReversal(db, {
      kind: "refund",
      disputeId: await dispute(env, manualTip.paymentId, "refund", 300),
      paymentId: manualTip.paymentId,
      amountCents: 300,
      occurredAt: new Date(),
    });
    await postReversal(db, {
      kind: "refund",
      disputeId: await dispute(env, refunded, "refund", 999),
      paymentId: refunded,
      amountCents: 999,
      occurredAt: new Date(),
    });
    const wonDispute = await dispute(env, won, "chargeback", 500);
    await postReversal(db, {
      kind: "chargeback",
      disputeId: wonDispute,
      paymentId: won,
      amountCents: 500,
      occurredAt: new Date(),
      disputeFeeCents: 1500,
    });
    await postChargebackReversal(db, { disputeId: wonDispute, occurredAt: new Date(), feeRefundCents: 1500 });

    expect(await run(env)).toEqual({ payments: 4, mismatches: 0 });
    // The cursor keeps a short overlap, so the next run re-checks what just changed, and still agrees.
    expect(await env.worker.ctx.valkey.get(RECONCILE_CURSOR_KEY)).not.toBeNull();
    expect(await run(env)).toEqual({ payments: 4, mismatches: 0 });
  });

  test("a cursor past every posting checks nothing", async () => {
    await env.worker.ctx.valkey.set(RECONCILE_CURSOR_KEY, new Date(Date.now() + 3_600_000).toISOString());
    expect(await reconcilePayments(env.worker.ctx)).toEqual({ payments: 0, mismatches: 0 });
  });

  test("a busy run lock answers skipped", async () => {
    await env.worker.ctx.valkey.set("worker:lock:payments:money-reconcile", "someone-else", "PX", 5_000);
    expect(await run(env)).toEqual({ skipped: 1 });
    await env.worker.ctx.valkey.del("worker:lock:payments:money-reconcile");
  });
});

describe("tampered settlement", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ jobs: [], outbox: false, segments: false });
  });
  afterAll(() => env.close());

  test("an extra balanced transaction moving the payment's settlement is one mismatch", async () => {
    const db = env.t.db;
    const owner = await makeUser(db);
    const payer = await makeUser(db);
    const good = await tip(db, {
      from: payer.user.id,
      channelId: owner.channel.id,
      creatorUserId: owner.user.id,
      cents: 500,
      message: "ok",
    });
    const bad = await tip(db, {
      from: payer.user.id,
      channelId: owner.channel.id,
      creatorUserId: owner.user.id,
      cents: 500,
      message: "tampered",
    });
    // Same `ref_id`, balanced, and it moves the receivable the tip settled on.
    await post(
      db,
      manualConfirmation({ paymentId: bad.paymentId, amountCents: 120, currency: "usd", occurredAt: new Date() }),
    );
    expect(await run(env)).toEqual({ payments: 2, mismatches: 1 });
    expect(good.paymentId).not.toBe(bad.paymentId);
  });
});
