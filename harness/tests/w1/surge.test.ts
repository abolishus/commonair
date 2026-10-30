// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `surge-guard`'s pure helpers (src/w1/surge.ts): the burst size, the unlock deadline and the cap's verdict. */
import { describe, expect, test } from "vite-plus/test";
import {
  GATE_SECONDS,
  JITTER_MAX_SECONDS,
  RETRY_INTERVAL_MS,
  SCORING_PASS_SECONDS,
  UNLOCK_DEADLINE_MS,
  capOutcome,
  surgeBurstSize,
  surgeThreshold,
} from "../../src/w1/surge.ts";

describe("surge burst", () => {
  test("threshold mirrors the job: max(20, 3 × the trailing rate per 2 minutes)", () => {
    expect(surgeThreshold(0)).toBe(20);
    expect(surgeThreshold(45)).toBe(20);
    expect(surgeThreshold(75)).toBe(30);
    expect(surgeThreshold(76)).toBe(31);
    expect(surgeThreshold(-5)).toBe(20);
  });

  test("the burst always clears the threshold", () => {
    for (const trailing of [0, 10, 75, 150, 600])
      expect(surgeBurstSize(trailing)).toBeGreaterThan(surgeThreshold(trailing));
  });
});

describe("timing", () => {
  test("the unlock deadline covers the gate, the largest jitter and two scoring passes", () => {
    expect(UNLOCK_DEADLINE_MS).toBeGreaterThan((GATE_SECONDS + JITTER_MAX_SECONDS + 2 * SCORING_PASS_SECONDS) * 1000);
  });

  test("retries stay under six denials a minute", () => {
    expect(60_000 / RETRY_INTERVAL_MS).toBeLessThan(6);
  });
});

describe("capOutcome", () => {
  const ok = (user: string) => ({ user, accepted: true, code: null });
  const refused = (user: string, code = "msg_verified_watch") => ({ user, accepted: false, code });

  test("five accepted and the last refused with the gate's code", () => {
    expect(capOutcome([ok("a"), ok("b"), ok("c"), ok("d"), ok("e"), refused("f")], "f")).toEqual({
      ok: true,
      problems: [],
    });
  });

  test("the sixth accepted, another refused, or another code fail", () => {
    expect(capOutcome([ok("a"), ok("f")], "f").ok).toBe(false);
    expect(capOutcome([refused("a"), refused("f")], "f").problems).toEqual(["a: refused with msg_verified_watch"]);
    expect(capOutcome([ok("a"), refused("f", "msg_ratelimit")], "f").ok).toBe(false);
    expect(capOutcome([ok("a")], "f").problems).toEqual(["f: never tried"]);
  });
});
