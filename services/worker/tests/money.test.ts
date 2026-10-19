// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import { JOBS } from "../src/jobs/index.ts";
import { MONEY_BATCH_SIZE, MONEY_BUDGET_MS, moneyConfigFromEnv } from "../src/money/config.ts";
import { tierCode } from "../src/money/ends.ts";
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
});
