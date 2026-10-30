// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 1's pure helpers (harness/src/n1/inapp.ts). */
import { describe, expect, test } from "vite-plus/test";
import { goLiveRowsFor, IN_APP_BUDGET_MS, IN_APP_TIMEOUT_MS, payloadProblems, step } from "../../src/n1/inapp.ts";

const channelId = "0190f5a0-0000-7000-8000-000000000003";
const broadcastId = "0190f5a0-0000-7000-8000-000000000004";
const expected = { channelId, slug: "n1s1abc", broadcastId, title: "Live now" };

describe("goLiveRowsFor", () => {
  test("keeps go_live rows about the channel only", () => {
    const items = [
      { id: "a", type: "go_live", payload: { channelId } },
      { id: "b", type: "go_live", payload: { channelId: "other" } },
      { id: "c", type: "moderation", payload: { channelId } },
      { id: "d", type: "go_live", payload: {} },
    ];
    expect(goLiveRowsFor(items, channelId).map((i) => i.id)).toEqual(["a"]);
    expect(goLiveRowsFor([], channelId)).toEqual([]);
  });
});

describe("payloadProblems", () => {
  test("the contract payload passes", () => {
    expect(payloadProblems({ ...expected }, expected)).toEqual([]);
    expect(payloadProblems({ ...expected, title: "" }, { ...expected, title: "" })).toEqual([]);
  });

  test("each wrong field is named", () => {
    expect(payloadProblems({ ...expected, slug: "other" }, expected)).toEqual([
      'payload slug: expected "n1s1abc", got "other"',
    ]);
    const other = "0190f5a0-0000-7000-8000-000000000009";
    expect(payloadProblems({ ...expected, broadcastId: other, title: "x" }, expected)).toHaveLength(2);
  });

  test("a mature title must be hidden from an unconfirmed viewer", () => {
    expect(payloadProblems({ ...expected, title: "After dark" }, { ...expected, title: "" })).toEqual([
      'payload title: expected "", got "After dark"',
    ]);
  });

  test("shape errors: missing, extra or malformed fields", () => {
    const { title: _title, ...noTitle } = expected;
    expect(payloadProblems(noTitle, expected)[0]).toMatch(/^payload title:/);
    expect(payloadProblems({ ...expected, email: "x@example.test" }, expected)[0]).toMatch(/^payload \(root\):/);
    expect(payloadProblems({ ...expected, channelId: "nope" }, expected)[0]).toMatch(/^payload channelId:/);
    expect(payloadProblems(null, expected)).not.toEqual([]);
  });
});

describe("step 1", () => {
  test("module contract", () => {
    expect(step).toMatchObject({ name: "in-app", owner: "N1-fanout", needs: [] });
    expect(step.webOnly).toBeUndefined();
    expect(step.requires).toBeUndefined();
    expect(IN_APP_TIMEOUT_MS).toBeGreaterThan(IN_APP_BUDGET_MS);
    expect(IN_APP_BUDGET_MS).toBe(30_000);
  });
});
