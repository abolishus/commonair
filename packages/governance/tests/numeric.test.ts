// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { compareDecimal, decimalOf, pgDivScale, pgDivide, ratioAtMost, ratioBelow } from "../src/numeric.ts";

const text = (d: { units: bigint; scale: number }) => {
  const s = d.units.toString().padStart(d.scale + 1, "0");
  return d.scale === 0 ? s : `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`;
};

describe("pgDivide reproduces Postgres numeric division", () => {
  // Expected values captured from PostgreSQL 17 (`select (a::numeric / b)::text`).
  test.each([
    [1, 1, "1.00000000000000000000"],
    [2, 3, "0.66666666666666666667"],
    [10, 3, "3.3333333333333333"],
    [9999, 10000, "0.99990000000000000000"],
    [12345, 7, "1763.5714285714285714"],
    [1, 12345, "0.000081004455245038477116"],
    [2, 2, "1.00000000000000000000"],
    [20001, 30000, "0.66670000000000000000"],
    [0, 7, "0.00000000000000000000"],
  ])("%i / %i = %s", (a, b, expected) => {
    expect(text(pgDivide(a, b))).toBe(expected);
  });

  test("scale grows for small quotients and shrinks for large ones", () => {
    expect(pgDivScale(1n, 1_000_000_000n)).toBeGreaterThan(pgDivScale(1n, 3n));
    expect(pgDivScale(10n ** 80n, 1n)).toBe(0);
  });

  test("rejects a zero divisor and negative operands", () => {
    expect(() => pgDivide(1, 0)).toThrow(RangeError);
    expect(() => pgDivide(-1, 2)).toThrow(RangeError);
  });
});

describe("decimalOf parses the JSON text jsonb stores", () => {
  test.each([
    [0.5, 5n, 1],
    [2 / 3, 6666666666666666n, 16],
    [1, 1n, 0],
    [1e-7, 1n, 7],
    [1e21, 10n ** 21n, 0],
    [0, 0n, 0],
  ])("%d", (n, units, scale) => {
    expect(compareDecimal(decimalOf(n), { units, scale })).toBe(0);
  });

  test("rejects non-finite and negative numbers", () => {
    expect(() => decimalOf(Number.NaN)).toThrow(RangeError);
    expect(() => decimalOf(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => decimalOf(-0.5)).toThrow(RangeError);
  });
});

describe("ratio comparisons at exact boundaries", () => {
  test("2 of 3 meets a 2/3 threshold even though 2/3 is not representable", () => {
    // Postgres: 0.66666666666666666667 >= 0.6666666666666666
    expect(ratioBelow(2, 3, 2 / 3)).toBe(false);
    expect(ratioBelow(4, 6, 2 / 3)).toBe(false);
    expect(ratioBelow(199_999, 300_000, 2 / 3)).toBe(true);
  });

  test("exactly half is at most 0.5 (the strict-majority rule fails)", () => {
    expect(ratioAtMost(1, 2, 0.5)).toBe(true);
    expect(ratioAtMost(500_001, 1_000_000, 0.5)).toBe(false);
  });

  test("a non-negative ratio is never below a negative threshold", () => {
    expect(ratioBelow(0, 5, -1)).toBe(false);
    expect(ratioAtMost(0, 5, -1)).toBe(false);
  });

  test("agrees with exact rational comparison away from rounding boundaries", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 2000; i++) {
      const den = 1 + Math.floor(rand() * 500);
      const num = Math.floor(rand() * (den + 1));
      const t = Math.round(rand() * 1000) / 1000;
      // num/den < t/1000*1000 exactly ⇔ num*1000 < t*1000*den
      expect(ratioBelow(num, den, t)).toBe(num * 1000 < Math.round(t * 1000) * den);
    }
  });
});
