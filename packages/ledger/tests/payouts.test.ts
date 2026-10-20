// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { computePayoutBatch, reservableAt } from "../src/payouts.ts";

describe("computePayoutBatch", () => {
  test("pays at or above the minimum, carries over the rest, in user-id order", () => {
    const batch = computePayoutBatch(
      [
        { userId: "c", availableCents: 2500 },
        { userId: "a", availableCents: 10_000 },
        { userId: "b", availableCents: 2499 },
        { userId: "d", availableCents: -300 },
        { userId: "e", availableCents: 0 },
      ],
      2500,
    );
    expect(batch.payouts).toEqual([
      { userId: "a", amountCents: 10_000 },
      { userId: "c", amountCents: 2500 },
    ]);
    expect(batch.carriedOver.map((c) => c.userId)).toEqual(["b", "d", "e"]);
  });

  test("a zero minimum still never pays zero or negative balances", () => {
    const batch = computePayoutBatch(
      [
        { userId: "a", availableCents: 0 },
        { userId: "b", availableCents: 1 },
      ],
      0,
    );
    expect(batch.payouts).toEqual([{ userId: "b", amountCents: 1 }]);
  });

  test("rejects an invalid minimum", () => {
    expect(() => computePayoutBatch([], -1)).toThrow(RangeError);
  });
});

describe("reservableAt", () => {
  const b = (liabilityCents: number, receivableCents: number) => ({ liabilityCents, receivableCents });

  test("reserves what was available at period end, netting the receivable owed by then", () => {
    expect(reservableAt(b(5000, 300), b(5000, 300))).toEqual({
      amountCents: 4700,
      nettedCents: 300,
      balances: b(5000, 300),
    });
  });

  test("earnings released after period end are left for the next run", () => {
    expect(reservableAt(b(4500, 0), b(6300, 0))).toMatchObject({ amountCents: 4500, nettedCents: 0 });
  });

  test("a receivable owed after period end is not netted, and what is available now caps the amount", () => {
    expect(reservableAt(b(4500, 0), b(4500, 300))).toEqual({ amountCents: 4200, nettedCents: 0, balances: b(4200, 0) });
  });

  test("the lowest running balance after period end caps the amount", () => {
    expect(reservableAt(b(4500, 0), b(900, 0), 0).amountCents).toBe(0);
    expect(reservableAt(b(1800, 0), b(1800, 0), 0).amountCents).toBe(0);
    expect(reservableAt(b(1800, 0), b(1800, 0), 700).amountCents).toBe(700);
    expect(reservableAt(b(1800, 0), b(1800, 0), 5000).amountCents).toBe(1800);
    expect(reservableAt(b(1800, 0), b(1800, 0), null).amountCents).toBe(1800);
  });

  test("never nets more than is still owed now", () => {
    expect(reservableAt(b(5000, 300), b(5000, 100))).toMatchObject({ amountCents: 4700, nettedCents: 100 });
  });

  test("an empty or overdrawn balance reserves nothing positive", () => {
    expect(reservableAt(b(0, 0), b(0, 0)).amountCents).toBe(0);
    expect(reservableAt(b(100, 500), b(100, 500)).amountCents).toBe(-400);
  });

  test("the balances handed to payoutReserve reserve exactly the amount and never overdraw today's", () => {
    for (const [then, now] of [
      [b(5000, 300), b(7000, 300)],
      [b(5000, 300), b(5000, 900)],
      [b(2000, 0), b(1500, 0)],
    ] as const) {
      const r = reservableAt(then, now);
      expect(r.balances.liabilityCents - r.balances.receivableCents).toBe(r.amountCents);
      expect(Math.min(r.balances.receivableCents, r.balances.liabilityCents)).toBe(r.nettedCents);
      expect(r.amountCents + r.nettedCents).toBeLessThanOrEqual(now.liabilityCents);
      expect(r.nettedCents).toBeLessThanOrEqual(now.receivableCents);
    }
  });
});
