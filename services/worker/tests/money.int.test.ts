// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { schema, uuidv7 } from "@commonair/db";
import { creatorBalances, DEFAULT_PLATFORM_CUT, paymentSucceeded, post, splitNet } from "@commonair/ledger";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { job as expireJob } from "../src/jobs/money-expire-pending.ts";
import { job as renewJob } from "../src/jobs/money-renew.ts";
import { expirePendingPayments } from "../src/money/expire.ts";
import { releaseHolds } from "../src/money/holds.ts";
import { MONEY_JOBS, moneyLockKey, withMoneyLock } from "../src/money/job.ts";
import { renewDueSubscriptions } from "../src/money/renew.ts";
import type { MoneyJobConfig } from "../src/money/config.ts";
import { DAY_MS } from "../src/money/time.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
// Every test builds its rows relative to one fixed instant; the jobs see it as `now`.
const NOW = new Date("2026-10-19T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const cfg: MoneyJobConfig = { currency: "usd", pendingDays: 7, batchSize: 500, budgetMs: 30_000 };

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, now: () => NOW });
});
afterAll(() => env.close());

const ctx = () => env.worker.ctx;
const db = () => env.t.db;
let refN = 0;
const ref = () => `CA-T${String(++refN).padStart(7, "0")}`;

async function channelWithTiers(prices: [number, number, number] | null = [500, 1000, 2500]) {
  const owner = await makeUser(db());
  if (prices) {
    await db()
      .insert(schema.channelSubTiers)
      .values(
        prices.map((priceCents, i) => ({ channelId: owner.channel.id, tier: i + 1, name: `T${i + 1}`, priceCents })),
      );
  }
  return owner;
}

async function subscription(
  over: Partial<typeof schema.subscriptions.$inferInsert> & { subscriberId: string; channelId: string },
) {
  const [row] = await db()
    .insert(schema.subscriptions)
    .values({ id: uuidv7(), tier: 1, provider: "manual", priceCents: 500, currency: "usd", ...over })
    .returning();
  return row!;
}

async function payment(over: Partial<typeof schema.payments.$inferInsert>) {
  const [row] = await db()
    .insert(schema.payments)
    .values({
      id: uuidv7(),
      provider: "manual",
      providerRef: ref(),
      kind: "subscription",
      amountCents: 500,
      currency: "usd",
      tier: 1,
      ...over,
    })
    .returning();
  return row!;
}

const subStatus = async (id: string) =>
  (await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, id)))[0]!.status;
const payStatus = async (id: string) =>
  (await db().select().from(schema.payments).where(eq(schema.payments.id, id)))[0]!.status;
const endEvents = (channelId: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, "channel.subscription.end")));
const pendingFor = (subscriptionId: string) =>
  db()
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.subscriptionId, subscriptionId), eq(schema.payments.status, "pending")));

describe("money-expire-pending", () => {
  test("fails the payment, expires incomplete subs and the tip, ends only the past_due renewal", async () => {
    const owner = await channelWithTiers();
    const viewer = await makeUser(db());
    const gifter = await makeUser(db());
    const r1 = await makeUser(db());
    const r2 = await makeUser(db());
    const renewer = await makeUser(db());

    // A first checkout that was never paid.
    const own = await subscription({ subscriberId: viewer.user.id, channelId: owner.channel.id });
    const ownPay = await payment({
      userId: viewer.user.id,
      channelId: owner.channel.id,
      subscriptionId: own.id,
      expiresAt: ago(1),
    });
    // A gift payment for two recipients.
    const giftPay = await payment({
      userId: gifter.user.id,
      channelId: owner.channel.id,
      quantity: 2,
      amountCents: 1000,
      expiresAt: ago(HOUR),
    });
    const g1 = await subscription({
      subscriberId: r1.user.id,
      channelId: owner.channel.id,
      giftedById: gifter.user.id,
      giftPaymentId: giftPay.id,
    });
    const g2 = await subscription({
      subscriberId: r2.user.id,
      channelId: owner.channel.id,
      giftedById: gifter.user.id,
      giftPaymentId: giftPay.id,
    });
    // A tip.
    const [tip] = await db()
      .insert(schema.tips)
      .values({
        id: uuidv7(),
        fromUserId: viewer.user.id,
        channelId: owner.channel.id,
        amountCents: 300,
        currency: "usd",
      })
      .returning();
    const tipPay = await payment({
      kind: "tip",
      tier: null,
      tipId: tip!.id,
      amountCents: 300,
      userId: viewer.user.id,
      channelId: owner.channel.id,
      expiresAt: NOW,
    });
    await db().update(schema.tips).set({ paymentId: tipPay.id }).where(eq(schema.tips.id, tip!.id));
    // A renewal left unpaid.
    const lapsing = await subscription({
      subscriberId: renewer.user.id,
      channelId: owner.channel.id,
      status: "past_due",
      currentPeriodStart: ago(37 * DAY_MS),
      currentPeriodEnd: ago(7 * DAY_MS),
    });
    const renewalPay = await payment({
      userId: renewer.user.id,
      channelId: owner.channel.id,
      subscriptionId: lapsing.id,
      expiresAt: NOW,
    });
    // Not yet due.
    const fresh = await subscription({ subscriberId: r1.user.id, channelId: (await channelWithTiers()).channel.id });
    const freshPay = await payment({ subscriptionId: fresh.id, expiresAt: new Date(NOW.getTime() + 1) });

    const r = await expirePendingPayments(ctx(), cfg);
    expect(r.exhausted).toBe(false);

    for (const p of [ownPay, giftPay, tipPay, renewalPay]) expect(await payStatus(p.id)).toBe("failed");
    for (const sub of [own, g1, g2, lapsing]) expect(await subStatus(sub.id)).toBe("expired");
    expect((await db().select().from(schema.tips).where(eq(schema.tips.id, tip!.id)))[0]!.status).toBe("failed");
    expect(await payStatus(freshPay.id)).toBe("pending");
    expect(await subStatus(fresh.id)).toBe("incomplete");

    const events = await endEvents(owner.channel.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      broadcaster_user_id: owner.user.id,
      broadcaster_user_login: owner.channel.slug,
      user_id: renewer.user.id,
      user_login: renewer.user.username,
      tier: "1000",
      is_gift: false,
    });

    // Nothing posted; a second run finds nothing.
    const again = await expirePendingPayments(ctx(), cfg);
    expect(again.payments).toBe(0);
    expect(await endEvents(owner.channel.id)).toHaveLength(1);
  });

  test("leaves succeeded payments and their active subscriptions alone", async () => {
    const owner = await channelWithTiers();
    const viewer = await makeUser(db());
    const sub = await subscription({
      subscriberId: viewer.user.id,
      channelId: owner.channel.id,
      status: "active",
      currentPeriodStart: ago(DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() + 29 * DAY_MS),
    });
    const paid = await payment({
      status: "succeeded",
      subscriptionId: sub.id,
      expiresAt: ago(DAY_MS),
      succeededAt: ago(DAY_MS),
    });
    await expirePendingPayments(ctx(), cfg);
    expect(await payStatus(paid.id)).toBe("succeeded");
    expect(await subStatus(sub.id)).toBe("active");
  });

  test("works through more rows than one batch", async () => {
    const owner = await channelWithTiers();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const p = await payment({
        kind: "tip",
        tier: null,
        channelId: owner.channel.id,
        amountCents: 100,
        expiresAt: ago(HOUR),
      });
      ids.push(p.id);
    }
    const r = await expirePendingPayments(ctx(), { ...cfg, batchSize: 3 });
    expect(r.batches).toBeGreaterThanOrEqual(3);
    for (const id of ids) expect(await payStatus(id)).toBe("failed");
  });
});

describe("money-renew", () => {
  const due = (over: Partial<typeof schema.subscriptions.$inferInsert> = {}) => ({
    status: "active" as const,
    currentPeriodStart: ago(30 * DAY_MS),
    currentPeriodEnd: ago(HOUR),
    ...over,
  });

  test("a manual self subscription gets one pending renewal at today's price and turns past_due", async () => {
    const owner = await channelWithTiers();
    const viewer = await makeUser(db());
    const sub = await subscription({
      subscriberId: viewer.user.id,
      channelId: owner.channel.id,
      tier: 2,
      priceCents: 1000,
      ...due(),
    });
    // The owner raised the tier 2 price since the subscription started.
    await db()
      .update(schema.channelSubTiers)
      .set({ priceCents: 1200 })
      .where(and(eq(schema.channelSubTiers.channelId, owner.channel.id), eq(schema.channelSubTiers.tier, 2)));

    const r = await renewDueSubscriptions(ctx(), cfg);
    expect(r.renewed).toBeGreaterThanOrEqual(1);
    expect(await subStatus(sub.id)).toBe("past_due");
    const pending = await pendingFor(sub.id);
    expect(pending).toHaveLength(1);
    const p = pending[0]!;
    expect(p).toMatchObject({
      provider: "manual",
      kind: "subscription",
      tier: 2,
      quantity: 1,
      amountCents: 1200,
      currency: "usd",
      userId: viewer.user.id,
      channelId: owner.channel.id,
    });
    expect(p.providerRef).toMatch(/^CA-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(p.expiresAt?.toISOString()).toBe(new Date(ago(HOUR).getTime() + 7 * DAY_MS).toISOString());
    // No end event: the badge stays while past_due.
    expect(await endEvents(owner.channel.id)).toHaveLength(0);

    await renewDueSubscriptions(ctx(), cfg);
    expect(await pendingFor(sub.id)).toHaveLength(1);
  });

  test("a renewal whose reference clashes retries with a fresh one", async () => {
    const owner = await channelWithTiers();
    const viewer = await makeUser(db());
    const taken = await payment({ kind: "tip", tier: null, providerRef: "CA-00000000" });
    const sub = await subscription({ subscriberId: viewer.user.id, channelId: owner.channel.id, ...due() });
    const refs = ["CA-00000000", "CA-11111111"];
    let i = 0;
    await renewDueSubscriptions(ctx(), cfg, { reference: () => refs[Math.min(i++, refs.length - 1)]! });
    expect(taken.providerRef).toBe("CA-00000000");
    const pending = await pendingFor(sub.id);
    expect(pending.map((p) => p.providerRef)).toEqual(["CA-11111111"]);
  });

  test("cancel at period end → canceled with an end event", async () => {
    const owner = await channelWithTiers();
    const viewer = await makeUser(db());
    const sub = await subscription({
      subscriberId: viewer.user.id,
      channelId: owner.channel.id,
      cancelAtPeriodEnd: true,
      tier: 3,
      ...due(),
    });
    await renewDueSubscriptions(ctx(), cfg);
    expect(await subStatus(sub.id)).toBe("canceled");
    expect(await pendingFor(sub.id)).toHaveLength(0);
    const events = await endEvents(owner.channel.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ user_id: viewer.user.id, tier: "3000", is_gift: false });
  });

  test("a gift expires with is_gift, never renews", async () => {
    const owner = await channelWithTiers();
    const gifter = await makeUser(db());
    const recipient = await makeUser(db());
    const giftPay = await payment({ status: "succeeded", userId: gifter.user.id, channelId: owner.channel.id });
    const sub = await subscription({
      subscriberId: recipient.user.id,
      channelId: owner.channel.id,
      giftedById: gifter.user.id,
      giftPaymentId: giftPay.id,
      ...due(),
    });
    await renewDueSubscriptions(ctx(), cfg);
    expect(await subStatus(sub.id)).toBe("expired");
    expect(await pendingFor(sub.id)).toHaveLength(0);
    const events = await endEvents(owner.channel.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ user_id: recipient.user.id, is_gift: true });
  });

  test("a channel without tiers ends the subscription", async () => {
    const owner = await channelWithTiers(null);
    const viewer = await makeUser(db());
    const sub = await subscription({ subscriberId: viewer.user.id, channelId: owner.channel.id, ...due() });
    await renewDueSubscriptions(ctx(), cfg);
    expect(await subStatus(sub.id)).toBe("expired");
    expect(await endEvents(owner.channel.id)).toHaveLength(1);
  });

  test("Stripe subscriptions and periods not yet over are untouched", async () => {
    const owner = await channelWithTiers();
    const a = await makeUser(db());
    const b = await makeUser(db());
    const stripe = await subscription({
      subscriberId: a.user.id,
      channelId: owner.channel.id,
      provider: "stripe",
      providerRef: `sub_${uuidv7()}`,
      ...due(),
    });
    const later = await subscription({
      subscriberId: b.user.id,
      channelId: owner.channel.id,
      ...due({ currentPeriodEnd: new Date(NOW.getTime() + 1) }),
    });
    await renewDueSubscriptions(ctx(), cfg);
    expect(await subStatus(stripe.id)).toBe("active");
    expect(await subStatus(later.id)).toBe("active");
    expect(await pendingFor(stripe.id)).toHaveLength(0);
    expect(await endEvents(owner.channel.id)).toHaveLength(0);
  });

  test("the unpaid renewal later expires and ends the subscription", async () => {
    const owner = await channelWithTiers();
    const viewer = await makeUser(db());
    const sub = await subscription({
      subscriberId: viewer.user.id,
      channelId: owner.channel.id,
      ...due({ currentPeriodEnd: ago(8 * DAY_MS) }),
    });
    await renewDueSubscriptions(ctx(), cfg);
    expect(await subStatus(sub.id)).toBe("past_due");
    // expires_at = period end + 7 days = one day ago.
    await expirePendingPayments(ctx(), cfg);
    expect(await subStatus(sub.id)).toBe("expired");
    expect(await endEvents(owner.channel.id)).toHaveLength(1);
  });
});

describe("money-release-holds", () => {
  test("releases a 7-day-old creator share, keeps a 6-day-old one in the hold", async () => {
    const creator = await makeUser(db());
    const mk = (gross: number, at: Date) =>
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "subscription",
        provider: "manual",
        creatorUserId: creator.user.id,
        grossCents: gross,
        taxCents: 0,
        feeCents: 0,
        currency: "usd",
        cut: DEFAULT_PLATFORM_CUT,
        occurredAt: at,
      });
    await post(db(), mk(1000, ago(7 * DAY_MS)));
    await post(db(), mk(2000, ago(6 * DAY_MS)));
    const old = splitNet(1000, DEFAULT_PLATFORM_CUT).creatorCents;
    const young = splitNet(2000, DEFAULT_PLATFORM_CUT).creatorCents;

    const r = await releaseHolds(ctx());
    expect(r.holdDays).toBe(7);
    expect(r.totalCents).toBeGreaterThanOrEqual(old);
    const bal = await creatorBalances(db(), creator.user.id, "usd");
    expect(bal.liabilityCents).toBe(old);
    expect(bal.holdCents).toBe(young);

    // Idempotent: a second run releases nothing more for this creator.
    await releaseHolds(ctx());
    expect((await creatorBalances(db(), creator.user.id, "usd")).liabilityCents).toBe(old);
  });
});

describe("run lock", () => {
  test("a second run while one holds the lock is skipped", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = withMoneyLock(ctx(), MONEY_JOBS.expirePending, 60_000, async () => {
      await gate;
      return { ran: true };
    });
    const second = await expireJob.handler({}, ctx(), { id: undefined, attemptsMade: 0 });
    expect(second).toEqual({ skipped: true });
    release();
    expect(await first).toEqual({ ran: true });
    // Released: the next run goes through.
    expect(await expireJob.handler({}, ctx(), { id: undefined, attemptsMade: 0 })).not.toEqual({ skipped: true });
  });

  test("a lock held by another replica blocks the run", async () => {
    await ctx().valkey.set(moneyLockKey(MONEY_JOBS.renew), "other-replica", "PX", 30_000);
    expect(await renewJob.handler({}, ctx(), { id: undefined, attemptsMade: 0 })).toEqual({ skipped: true });
    await ctx().valkey.del(moneyLockKey(MONEY_JOBS.renew));
  });
});
