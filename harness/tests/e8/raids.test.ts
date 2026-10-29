// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers of the `interact` raid step (harness/src/e8/raids.ts). */
import { describe, expect, test } from "vite-plus/test";
import {
  codeOf,
  gateEligibleViewers,
  refusal,
  requirementOf,
  viewersBracketed,
  type RaidSessionRow,
} from "../../src/e8/raids.ts";

const row = (over: Partial<RaidSessionRow> = {}): RaidSessionRow => ({
  userId: null,
  deviceHash: `dev-${Math.random()}`,
  verdict: "verified",
  verdictReasons: [],
  scoredAt: new Date(),
  ...over,
});

describe("gateEligibleViewers", () => {
  test("verified, scored and judged sessions count; excluded, unscored and unjudged do not", () => {
    expect(
      gateEligibleViewers([
        row(),
        row({ verdict: "excluded", verdictReasons: ["headless"] }),
        row({ verdict: "pending" }),
        row({ scoredAt: null }),
        row({ verdictReasons: ["fetch_unjudged"] }),
        row({ verdictReasons: null }),
      ]),
    ).toBe(2);
  });
  test("distinct by account, else device", () => {
    expect(
      gateEligibleViewers([
        row({ userId: "u1" }),
        row({ userId: "u1" }),
        row({ deviceHash: "d1" }),
        row({ deviceHash: "d1" }),
        // A signed-in session is the account, whatever its device.
        row({ userId: "u2", deviceHash: "d1" }),
      ]),
    ).toBe(3);
  });
  test("no sessions → 0", () => expect(gateEligibleViewers([])).toBe(0));
});

describe("viewersBracketed", () => {
  test("between the two reads, either order", () => {
    expect(viewersBracketed(2, 1, 3)).toBe(true);
    expect(viewersBracketed(2, 3, 1)).toBe(true);
    expect(viewersBracketed(1, 1, 1)).toBe(true);
  });
  test("outside the reads", () => {
    expect(viewersBracketed(0, 1, 1)).toBe(false);
    expect(viewersBracketed(4, 1, 3)).toBe(false);
  });
});

describe("errors", () => {
  test("requirementOf and codeOf read oRPC errors and nothing else", () => {
    const err = Object.assign(new Error("x"), { code: "PRECONDITION_FAILED", data: { requirement: "raid_refused" } });
    expect(requirementOf(err)).toBe("raid_refused");
    expect(codeOf(err)).toBe("PRECONDITION_FAILED");
    expect(requirementOf(Object.assign(new Error("x"), { code: "CONFLICT" }))).toBeNull();
    expect(requirementOf({ data: { requirement: 3 } })).toBeNull();
    expect(requirementOf(null)).toBeNull();
    expect(codeOf("nope")).toBeNull();
  });
  test("refusal returns the error, and fails when the call succeeds", async () => {
    const e = new Error("refused");
    expect(await refusal("x", () => Promise.reject(e))).toBe(e);
    await expect(refusal("start", () => Promise.resolve(1))).rejects.toThrow(/start: expected a refusal/);
  });
});
