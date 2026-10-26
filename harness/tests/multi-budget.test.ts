// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { CLAIM_WEIGHTS_MS, SCENARIO_TIMEOUT_MS, TEARDOWN_RESERVE_MS } from "../scenarios/multi-instance.ts";
import { ClaimBudget } from "../src/multi/budget.ts";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ClaimBudget", () => {
  test("with time to spare each claim gets at least its weight", () => {
    const c = clock();
    const b = new ClaimBudget({ deadline: 1_000, weights: [100, 200, 300], now: c.now });
    expect(b.begin(0)).toBe(166);
    expect(b.cap(100)).toBe(100);
    c.advance(50);
    expect(b.begin(1)).toBe(380);
  });

  test("a claim that overruns its share does not take the next claims' time", () => {
    const c = clock();
    const b = new ClaimBudget({ deadline: 600, weights: [300, 300], now: c.now });
    expect(b.begin(0)).toBe(300);
    // Wanted 500 but the claim ends at 300.
    expect(b.cap(500)).toBe(300);
    c.advance(300);
    expect(b.cap(500)).toBe(0);
    expect(b.begin(1)).toBe(300);
  });

  test("when behind, the remaining time is split by weight and the last claim gets all that is left", () => {
    const c = clock();
    const b = new ClaimBudget({ deadline: 1_000, weights: [500, 500, 500], reserveMs: 100, now: c.now });
    c.advance(300);
    expect(b.begin(1)).toBe(300);
    c.advance(300);
    expect(b.begin(2)).toBe(300);
  });

  test("past the deadline every claim gets nothing, and caps honour a floor", () => {
    const c = clock(2_000);
    const b = new ClaimBudget({ deadline: 1_000, weights: [10], now: c.now });
    expect(b.begin(0)).toBe(0);
    expect(b.cap(5_000)).toBe(0);
    expect(b.cap(5_000, 1_000)).toBe(1_000);
    expect(b.until(5_000)).toBe(2_000);
  });

  test("before begin nothing is capped; unknown claims throw", () => {
    const b = new ClaimBudget({ deadline: 1_000, weights: [1], now: () => 0 });
    expect(b.cap(42)).toBe(42);
    expect(() => b.begin(1)).toThrow(RangeError);
  });

  test("zero weights split nothing and hand the claim all that is left", () => {
    const b = new ClaimBudget({ deadline: 100, weights: [0], now: () => 0 });
    expect(b.begin(0)).toBe(100);
  });
});

describe("multi-instance claim weights", () => {
  test("the claims' worst cases plus the teardown reserve fit the scenario timeout", () => {
    const sum = CLAIM_WEIGHTS_MS.reduce((a, b) => a + b, 0);
    // Room for the setup steps (podman ps, bus, signups) too.
    expect(sum + TEARDOWN_RESERVE_MS + 30_000).toBeLessThanOrEqual(SCENARIO_TIMEOUT_MS);
  });
});
