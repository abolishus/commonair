// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import { JOBS } from "../src/jobs/index.ts";
import { MONEY_BATCH_SIZE, MONEY_BUDGET_MS, moneyConfig, moneyConfigFromEnv } from "../src/money/config.ts";
import { tierCode } from "../src/money/ends.ts";
import { takeWithinCap } from "../src/money/expire.ts";
import { MONEY_JOBS, moneyLockKey } from "../src/money/job.ts";
import { DAY_MS, isExpired, isPeriodOver, renewalExpiresAt, runBatches } from "../src/money/time.ts";

const T = new Date("2026-01-31T23:59:59.999Z");

describe("renewal expiry arithmetic", () => {
  test("period end plus the pending days, in whole UTC days", () => {
    expect(renewalExpiresAt(T, 7).toISOString()).toBe("2026-02-07T23:59:59.999Z");
    expect(renewalExpiresAt(T, 1).getTime() - T.getTime()).toBe(DAY_MS);
    expect(renewalExpiresAt(T, 60).toISOString()).toBe("2026-04-01T23:59:59.999Z");
  });

  test("crosses leap-day and month boundaries exactly (UTC)", () => {
    const feb = new Date("2028-02-28T00:00:00.000Z");
    expect(renewalExpiresAt(feb, 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    const march = new Date("2026-03-28T12:00:00.000Z");
    expect(renewalExpiresAt(march, 2).toISOString()).toBe("2026-03-30T12:00:00.000Z");
  });

  test("a renewal opened late still gets at least a day to pay", () => {
    const end = new Date("2026-03-01T00:00:00.000Z");
    // On time: the normal window.
    expect(renewalExpiresAt(end, 7, end).toISOString()).toBe("2026-03-08T00:00:00.000Z");
    // Six and a half days late: only half a day would be left, so now + 1 day.
    const late = new Date(end.getTime() + 6.5 * DAY_MS);
    expect(renewalExpiresAt(end, 7, late).toISOString()).toBe(new Date(late.getTime() + DAY_MS).toISOString());
    // Ten days late (an outage): now + 1 day.
    const outage = new Date(end.getTime() + 10 * DAY_MS);
    expect(renewalExpiresAt(end, 7, outage).toISOString()).toBe("2026-03-12T00:00:00.000Z");
    // Exactly at the boundary both rules agree.
    const edge = new Date(end.getTime() + 6 * DAY_MS);
    expect(renewalExpiresAt(end, 7, edge).toISOString()).toBe("2026-03-08T00:00:00.000Z");
  });

  test("rejects non-positive or fractional days", () => {
    expect(() => renewalExpiresAt(T, 0)).toThrow(RangeError);
    expect(() => renewalExpiresAt(T, -1)).toThrow(RangeError);
    expect(() => renewalExpiresAt(T, 1.5)).toThrow(RangeError);
  });

  test("expiry and period end are inclusive of now; null never expires", () => {
    expect(isExpired(T, T)).toBe(true);
    expect(isExpired(new Date(T.getTime() + 1), T)).toBe(false);
    expect(isExpired(new Date(T.getTime() - 1), T)).toBe(true);
    expect(isExpired(null, T)).toBe(false);
    expect(isPeriodOver(T, T)).toBe(true);
    expect(isPeriodOver(new Date(T.getTime() + 1), T)).toBe(false);
    expect(isPeriodOver(null, T)).toBe(false);
  });
});

describe("runBatches", () => {
  const fakeClock = (stepMs: number) => {
    let t = 0;
    return { clock: () => t, advance: (ms = stepMs) => (t += ms) };
  };

  test("stops after a short batch", async () => {
    const { clock } = fakeClock(0);
    const sizes = [3, 3, 1, 3];
    let i = 0;
    const r = await runBatches({ batchSize: 3, budgetMs: 1_000, clock }, async () => sizes[i++]!);
    expect(r).toEqual({ batches: 3, rows: 7, exhausted: false });
  });

  test("an empty first batch is one batch, nothing done", async () => {
    const r = await runBatches({ batchSize: 500, budgetMs: 1_000, clock: () => 0 }, async () => 0);
    expect(r).toEqual({ batches: 1, rows: 0, exhausted: false });
  });

  test("an exact multiple needs one more (empty) batch to know it is done", async () => {
    const sizes = [2, 2, 0];
    let i = 0;
    const r = await runBatches({ batchSize: 2, budgetMs: 1_000, clock: () => 0 }, async () => sizes[i++]!);
    expect(r).toEqual({ batches: 3, rows: 4, exhausted: false });
  });

  test("the time budget stops further batches and reports exhaustion", async () => {
    const c = fakeClock(400);
    let calls = 0;
    const r = await runBatches({ batchSize: 10, budgetMs: 1_000, clock: c.clock }, async (limit) => {
      calls += 1;
      c.advance();
      return limit;
    });
    // 0 → 400 → 800 → 1200: the third batch starts at 800 (< 1000), the fourth would start at 1200.
    expect(calls).toBe(3);
    expect(r).toEqual({ batches: 3, rows: 30, exhausted: true });
  });

  test("a zero budget runs nothing", async () => {
    let calls = 0;
    const r = await runBatches({ batchSize: 10, budgetMs: 0, clock: () => 0 }, async () => ++calls);
    expect(calls).toBe(0);
    expect(r).toEqual({ batches: 0, rows: 0, exhausted: true });
  });

  test("an explicit `more` overrides the row count either way", async () => {
    const steps = [
      { rows: 1, more: true },
      { rows: 5, more: true },
      { rows: 5, more: false },
    ];
    let i = 0;
    const r = await runBatches({ batchSize: 5, budgetMs: 1_000, clock: () => 0 }, async () => steps[i++]!);
    expect(r).toEqual({ batches: 3, rows: 11, exhausted: false });
  });

  test("passes the batch size as the limit and rejects a bad one", async () => {
    const seen: number[] = [];
    await runBatches({ batchSize: 7, budgetMs: 1_000, clock: () => 0 }, async (limit) => {
      seen.push(limit);
      return 0;
    });
    expect(seen).toEqual([7]);
    await expect(runBatches({ batchSize: 0, budgetMs: 1_000 }, async () => 0)).rejects.toThrow(RangeError);
  });
});

describe("takeWithinCap", () => {
  const q = (...quantities: number[]) => quantities.map((quantity, i) => ({ i, quantity }));

  test("takes payments in order while their subscriptions fit", () => {
    expect(takeWithinCap(q(1, 1, 1, 1), 3).map((r) => r.i)).toEqual([0, 1, 2]);
    expect(takeWithinCap(q(2, 1, 5, 1), 3).map((r) => r.i)).toEqual([0, 1]);
    expect(takeWithinCap(q(100, 100, 100, 100, 100, 1), 500).map((r) => r.i)).toEqual([0, 1, 2, 3, 4]);
  });

  test("always takes the first, even when it alone exceeds the cap", () => {
    expect(takeWithinCap(q(100, 1), 50).map((r) => r.i)).toEqual([0]);
  });

  test("stops at the first that does not fit (keeps the order)", () => {
    expect(takeWithinCap(q(2, 3, 1), 4).map((r) => r.i)).toEqual([0]);
  });

  test("empty in, empty out", () => {
    expect(takeWithinCap([], 500)).toEqual([]);
  });
});

describe("money job wiring", () => {
  test("three scheduled jobs on the payments queue", () => {
    const money = JOBS.filter((j) => j.queue === QUEUES.payments);
    expect(money.map((j) => j.name).sort()).toEqual(Object.values(MONEY_JOBS).sort());
    for (const j of money) expect(j.schedule).toBeDefined();
    const by = new Map(money.map((j) => [j.name, j]));
    expect(by.get(MONEY_JOBS.expirePending)!.schedule).toEqual({ every: 300_000 });
    expect(by.get(MONEY_JOBS.renew)!.schedule).toEqual({ every: 300_000 });
    expect(by.get(MONEY_JOBS.releaseHolds)!.schedule).toEqual({ pattern: "41 * * * *" });
  });

  test("each job has its own lock key", () => {
    const keys = Object.values(MONEY_JOBS).map(moneyLockKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("tier codes", () => {
    expect([1, 2, 3].map(tierCode)).toEqual(["1000", "2000", "3000"]);
    expect(() => tierCode(0)).toThrow(RangeError);
    expect(() => tierCode(4)).toThrow(RangeError);
  });

  test("config comes from the payment env with defaults", () => {
    expect(moneyConfigFromEnv({})).toEqual({
      currency: "usd",
      pendingDays: 7,
      batchSize: MONEY_BATCH_SIZE,
      budgetMs: MONEY_BUDGET_MS,
    });
    expect(moneyConfigFromEnv({ CURRENCY: "sek", PAYMENT_PENDING_DAYS: "14" })).toMatchObject({
      currency: "sek",
      pendingDays: 14,
    });
    expect(() => moneyConfigFromEnv({ PAYMENT_PENDING_DAYS: "0" })).toThrow("PAYMENT_PENDING_DAYS");
    expect(MONEY_BATCH_SIZE).toBeLessThanOrEqual(500);
    expect(MONEY_BUDGET_MS).toBe(30_000);
  });

  test("a context's injected config wins over the env", () => {
    const injected = { currency: "eur", pendingDays: 3, batchSize: 10, budgetMs: 5 };
    expect(moneyConfig({ money: injected })).toBe(injected);
    expect(moneyConfig({})).toEqual(moneyConfigFromEnv());
  });
});
