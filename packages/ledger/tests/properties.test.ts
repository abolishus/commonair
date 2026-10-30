// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Property-based tests of the money arithmetic: invariants that must hold for every amount and
 * cut, not just the worked examples in math.test.ts and rules.test.ts. A cent lost or created
 * here would unbalance the ledger (the database trigger would then refuse the posting).
 */
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { largestRemainder } from "../src/math.ts";
import { type PlatformCut, reversalSplit, splitNet } from "../src/rules.ts";

// Up to $10M in cents keeps every product well inside BigInt-free safe-integer range for the
// assertions, while still covering amounts far beyond any real payment.
const cents = fc.integer({ min: 0, max: 1_000_000_000 });
// Settings store fractions as JSON numbers; millionths is their resolution.
const cut = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((m): PlatformCut => ({ streamerShare: m / 1_000_000, coopShare: 1 - m / 1_000_000 }));

describe("largestRemainder", () => {
  const weights = fc.array(fc.bigInt({ min: 0n, max: 1_000_000_000n }), { minLength: 1, maxLength: 40 });

  test("parts sum to the total, and each is its exact share rounded down or up", () => {
    fc.assert(
      fc.property(cents, weights, (total, ws) => {
        const sum = ws.reduce((a, w) => a + w, 0n);
        fc.pre(sum > 0n);
        const parts = largestRemainder(
          total,
          ws.map((weight, key) => ({ key, weight })),
        );
        expect(parts.reduce((a, p) => a + p.cents, 0)).toBe(total);
        parts.forEach((p, i) => {
          const exactFloor = Number((BigInt(total) * (ws[i] ?? 0n)) / sum);
          expect(p.key).toBe(i);
          expect(p.cents - exactFloor).toBeGreaterThanOrEqual(0);
          expect(p.cents - exactFloor).toBeLessThanOrEqual(1);
          expect(ws[i] === 0n && p.cents !== 0).toBe(false);
        });
      }),
    );
  });

  test("is deterministic", () => {
    fc.assert(
      fc.property(cents, weights, (total, ws) => {
        fc.pre(ws.some((w) => w > 0n));
        const items = ws.map((weight, key) => ({ key, weight }));
        expect(largestRemainder(total, items)).toEqual(largestRemainder(total, items));
      }),
    );
  });
});

describe("splitNet", () => {
  test("creator and co-op shares are non-negative and sum to net exactly", () => {
    fc.assert(
      fc.property(cents, cut, (net, c) => {
        const { creatorCents, coopCents } = splitNet(net, c);
        expect(creatorCents).toBeGreaterThanOrEqual(0);
        expect(coopCents).toBeGreaterThanOrEqual(0);
        expect(creatorCents + coopCents).toBe(net);
      }),
    );
  });

  test("the creator's share never shrinks as net grows", () => {
    fc.assert(
      fc.property(cents, cents, cut, (a, b, c) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(splitNet(hi, c).creatorCents).toBeGreaterThanOrEqual(splitNet(lo, c).creatorCents);
      }),
    );
  });
});

describe("reversalSplit", () => {
  // A payment, a cut, and a full refund sliced into partial reversals at arbitrary points.
  const sliced = fc
    .record({ gross: fc.integer({ min: 1, max: 100_000_000 }), taxShare: fc.double({ min: 0, max: 1, noNaN: true }) })
    .chain(({ gross, taxShare }) =>
      fc.record({
        gross: fc.constant(gross),
        tax: fc.constant(Math.floor(gross * taxShare)),
        cut,
        cuts: fc.array(fc.integer({ min: 0, max: gross }), { maxLength: 12 }),
      }),
    );

  test("however a full reversal is sliced, it returns exactly the original split", () => {
    fc.assert(
      fc.property(sliced, ({ gross, tax, cut: c, cuts }) => {
        const points = [...new Set([0, ...cuts, gross])].toSorted((a, b) => a - b);
        const total = { taxCents: 0, creatorCents: 0, coopCents: 0 };
        for (let i = 1; i < points.length; i++) {
          const from = points[i - 1] ?? 0;
          const part = reversalSplit({ grossCents: gross, taxCents: tax }, c, from, (points[i] ?? 0) - from);
          expect(part.taxCents).toBeGreaterThanOrEqual(0);
          expect(part.creatorCents).toBeGreaterThanOrEqual(0);
          expect(part.coopCents).toBeGreaterThanOrEqual(0);
          expect(part.taxCents + part.creatorCents + part.coopCents).toBe((points[i] ?? 0) - from);
          total.taxCents += part.taxCents;
          total.creatorCents += part.creatorCents;
          total.coopCents += part.coopCents;
        }
        expect(total).toEqual({ taxCents: tax, ...splitNet(gross - tax, c) });
      }),
    );
  });
});
