// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { MINUTE_MS } from "../src/accounting.ts";
import { probeProductionMinute } from "./production-probe.ts";

const B = Date.UTC(2026, 10, 4, 13, 10);

/** A clock that reads each value in turn, then keeps the last. */
const clock = (...reads: number[]) => {
  let i = 0;
  return () => reads[Math.min(i++, reads.length - 1)] ?? 0;
};

describe("probeProductionMinute", () => {
  test("the heartbeat is never before the chosen minute, even when the boundary falls mid-probe", async () => {
    // CI run 41834516797: stamped at 13:09:59.98, the pull's production and the bucket at 13:10.
    for (const reads of [
      [B - 20, B + 30],
      [B - 20, B - 10],
      [B + 5, B + 10],
      [B + MINUTE_MS - 1, B + MINUTE_MS + 1],
    ]) {
      let stamped = Number.NaN;
      const minute = await probeProductionMinute({
        now: clock(...reads),
        stamp: async (at) => {
          stamped = at.getTime();
        },
        pull: async () => {},
        produced: async () => true,
      });
      expect(minute).toBe(Math.floor((reads[0] ?? 0) / MINUTE_MS) * MINUTE_MS);
      expect(stamped).toBeGreaterThanOrEqual(minute ?? Number.POSITIVE_INFINITY);
    }
  });

  test("the steps run in order: stamp, pull, then the production check for the chosen minute", async () => {
    const calls: string[] = [];
    const minute = await probeProductionMinute({
      now: clock(B + 1, B + 2),
      stamp: async () => {
        calls.push("stamp");
      },
      pull: async () => {
        calls.push("pull");
      },
      produced: async (m) => {
        calls.push(`produced ${m - B}`);
        return true;
      },
    });
    expect(minute).toBe(B);
    expect(calls).toEqual(["stamp", "pull", "produced 0"]);
  });

  test("no production for the chosen minute: undefined, so the caller tries again", async () => {
    const seen: number[] = [];
    expect(
      await probeProductionMinute({
        now: clock(B - 1, B + 1),
        stamp: async () => {},
        pull: async () => {},
        produced: async (m) => {
          seen.push(m);
          return false;
        },
      }),
    ).toBeUndefined();
    expect(seen).toEqual([B - MINUTE_MS]);
  });
});
