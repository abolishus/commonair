// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { computePayoutBatch } from "../src/payouts.ts";

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
