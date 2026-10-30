// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money-fraud-scan` (ADR 0036) against a real database: flags once, holds the payee's payouts
 * (re-tagging account-not-ready holds, never touching paid ones), writes the audit and outbox rows,
 * and does not undo a clear on the same evidence. Tests run in order on one database; each scan
 * sees the earlier tests' payees as already flagged or decided.
 */
import { schema, uuidv7 } from "@commonair/db";
import { FRAUD_REVIEW_HOLD, PAYOUT_ACCOUNT_NOT_READY } from "@commonair/ledger";
import { PAYMENT_FRAUD_RULES } from "@commonair/contracts/enums";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { job } from "../src/jobs/money-fraud-scan.ts";
import { runFraudScan } from "../src/money/fraud.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const NOW = new Date("2026-10-19T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, now: () => NOW });
});
afterAll(() => env.close());

const ctx = () => env.worker.ctx;
const db = () => env.t.db;
let refN = 0;

async function tip(
  payer: string,
  channelId: string,
  cents: number,
  at: Date,
  over: Partial<typeof schema.payments.$inferInsert> = {},
) {
  await db()
    .insert(schema.payments)
    .values({
      id: uuidv7(),
      provider: "manual",
      providerRef: `CA-F${String(++refN).padStart(7, "0")}`,
      kind: "tip",
      status: "succeeded",
      userId: payer,
      channelId,
      amountCents: cents,
      currency: "usd",
      succeededAt: at,
      ...over,
    });
}

/** A payee whose whole gross comes from one long-standing payer. */
async function concentrated(cents = PAYMENT_FRAUD_RULES.concentrationMinGrossCents, at = ago(2 * DAY)) {
  const payee = await makeUser(db());
  const payer = await makeUser(db());
  await db()
    .update(schema.users)
    .set({ createdAt: ago(365 * DAY) })
    .where(eq(schema.users.id, payer.user.id));
  await tip(payer.user.id, payee.channel.id, cents, at);
  return { payee, payer };
}

let periods = 0;
async function payoutFor(
  userId: string,
  status: "pending" | "held" | "paid" | "scheduled",
  holdReason: string | null = null,
) {
  periods += 1;
  const start = new Date(Date.UTC(2026, 0, periods));
  const [p] = await db()
    .insert(schema.payouts)
    .values({
      userId,
      periodStart: start,
      periodEnd: new Date(start.getTime() + DAY),
      amountCents: 1000,
      currency: "usd",
      provider: "manual",
      status,
      holdReason,
      paidAt: status === "paid" ? ago(DAY) : null,
    })
    .returning();
  return p!;
}

const flagsOf = (payee: string) =>
  db().select().from(schema.paymentFraudFlags).where(eq(schema.paymentFraudFlags.payeeUserId, payee));
const payout = async (id: string) => (await db().select().from(schema.payouts).where(eq(schema.payouts.id, id)))[0]!;

async function treasurer(): Promise<string> {
  const u = await makeUser(db());
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, u.user.id));
  return u.user.id;
}

async function clear(flagId: string, at: Date) {
  await db()
    .update(schema.paymentFraudFlags)
    .set({ status: "reviewed", reviewedById: await treasurer(), recommendation: "clear", reviewedAt: at })
    .where(eq(schema.paymentFraudFlags.id, flagId));
  await db()
    .update(schema.paymentFraudFlags)
    .set({ status: "cleared", decidedById: await treasurer(), decision: "clear", decidedAt: at })
    .where(eq(schema.paymentFraudFlags.id, flagId));
}

describe("money-fraud-scan", () => {
  test("flags a concentrated payee once, holds pending, re-tags account holds, leaves paid", async () => {
    const { payee } = await concentrated();
    const pending = await payoutFor(payee.user.id, "pending");
    const scheduled = await payoutFor(payee.user.id, "scheduled");
    const notReady = await payoutFor(payee.user.id, "held", PAYOUT_ACCOUNT_NOT_READY);
    const paid = await payoutFor(payee.user.id, "paid");

    expect(await runFraudScan(ctx())).toEqual({ flagged: 1, held: 3 });
    const [flag, ...rest] = await flagsOf(payee.user.id);
    expect(rest).toEqual([]);
    expect(flag).toMatchObject({
      kind: "payer_concentration",
      status: "open",
      raisedById: null,
      evidence: { grossCents: 50_000, topShareBps: 10_000, newPayerShareBps: 0, payers: 1 },
    });
    for (const p of [pending, scheduled, notReady])
      expect(await payout(p.id)).toMatchObject({ status: "held", holdReason: FRAUD_REVIEW_HOLD });
    expect(await payout(paid.id)).toMatchObject({ status: "paid" });

    const audit = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "payment_fraud_flag"), eq(schema.auditLog.subjectId, flag!.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "system",
      action: "money.fraud.raise",
      channelId: payee.channel.id,
      reason: "",
      details: { flagId: flag!.id, kind: "payer_concentration", status: "open" },
    });
    const events = (await db().select().from(schema.events).where(eq(schema.events.type, "money.fraud.flag"))).filter(
      (e) => e.payload.flag_id === flag!.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: payee.channel.id,
      payload: {
        flag_id: flag!.id,
        payee_user_id: payee.user.id,
        kind: "payer_concentration",
        status: "open",
        released: false,
        held_payouts: 3,
      },
    });

    // The second run finds the undecided flag and adds nothing.
    expect(await runFraudScan(ctx())).toEqual({ flagged: 0, held: 0 });
    expect(await flagsOf(payee.user.id)).toHaveLength(1);
  });

  test("velocity flags every payee of the burst; refunded payments do not count", async () => {
    const payer = await makeUser(db());
    const a = await makeUser(db());
    const b = await makeUser(db());
    const quiet = await makeUser(db());
    const n = PAYMENT_FRAUD_RULES.velocityMaxPayments;
    for (let i = 0; i < n; i++) await tip(payer.user.id, a.channel.id, 100, ago(3 * HOUR - i * 60_000));
    await tip(payer.user.id, b.channel.id, 100, ago(3 * HOUR - n * 60_000));
    await tip(payer.user.id, quiet.channel.id, 100, ago(10 * DAY));
    // A second payer at exactly the maximum, plus a refunded payment that would tip it over.
    const other = await makeUser(db());
    for (let i = 0; i < n; i++) await tip(other.user.id, quiet.channel.id, 100, ago(5 * HOUR - i * 60_000));
    await tip(other.user.id, quiet.channel.id, 100, ago(5 * HOUR - 30 * 60_000), {
      status: "refunded",
      refundedCents: 100,
    });

    expect(await runFraudScan(ctx())).toEqual({ flagged: 2, held: 0 });
    for (const u of [a, b]) {
      const [flag] = await flagsOf(u.user.id);
      expect(flag).toMatchObject({ kind: "payer_velocity", evidence: { payerUserId: payer.user.id, payments: n + 1 } });
    }
    expect(await flagsOf(quiet.user.id)).toEqual([]);
  });

  test("after a clear the same evidence raises nothing; new evidence after it does", async () => {
    const { payee, payer } = await concentrated(PAYMENT_FRAUD_RULES.concentrationMinGrossCents, ago(5 * DAY));
    await runFraudScan(ctx());
    const [flag] = await flagsOf(payee.user.id);
    await clear(flag!.id, ago(4 * DAY));

    expect(await runFraudScan(ctx())).toEqual({ flagged: 0, held: 0 });
    expect(await flagsOf(payee.user.id)).toHaveLength(1);

    // Below the floor on its own: still nothing (the old 50 000 no longer counts).
    await tip(payer.user.id, payee.channel.id, 1000, ago(DAY));
    expect(await runFraudScan(ctx())).toEqual({ flagged: 0, held: 0 });

    await tip(payer.user.id, payee.channel.id, PAYMENT_FRAUD_RULES.concentrationMinGrossCents, ago(HOUR));
    const pending = await payoutFor(payee.user.id, "pending");
    expect(await runFraudScan(ctx())).toEqual({ flagged: 1, held: 1 });
    const open = (await flagsOf(payee.user.id)).find((f) => f.status === "open");
    expect(open?.evidence).toMatchObject({ grossCents: 51_000, payers: 1 });
    expect(await payout(pending.id)).toMatchObject({ status: "held", holdReason: FRAUD_REVIEW_HOLD });
  });

  test("new accounts bringing half the gross flag it", async () => {
    const payee = await makeUser(db());
    // 20 payers, 2 500 each: the top three bring 15 %, the ten new accounts 50 %.
    for (let i = 0; i < 20; i++) {
      const payer = await makeUser(db());
      const created = i < 10 ? ago(3 * DAY) : ago(400 * DAY);
      await db().update(schema.users).set({ createdAt: created }).where(eq(schema.users.id, payer.user.id));
      await tip(payer.user.id, payee.channel.id, 2500, ago(DAY));
    }
    expect(await runFraudScan(ctx())).toEqual({ flagged: 1, held: 0 });
    const [flag] = await flagsOf(payee.user.id);
    expect(flag?.evidence).toMatchObject({ grossCents: 50_000, topShareBps: 1500, newPayerShareBps: 5000, payers: 20 });
  });

  test("the job runs the scan under its run lock", async () => {
    await concentrated();
    const r = await job.handler({}, ctx(), {} as never);
    expect(r).toEqual({ flagged: 1, held: 0 });
  });
});
