// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `jury` extension's own checks (src/w3/jury.ts): the seed check, the k rule per row, grouping. */
import { describe, expect, test } from "vite-plus/test";
import { clauseIdOf, rowProblem, seedMatches, sharedCase, stepJury, tallies } from "../../src/w3/jury.ts";

const S = { suppressed: true as const };
const n = (value: number) => ({ suppressed: false as const, value });
const row = (
  agree: ReturnType<typeof n> | typeof S,
  disagree: ReturnType<typeof n> | typeof S,
  unsure: ReturnType<typeof n> | typeof S,
) => ({
  clauseId: "honesty.spam",
  tier: null,
  agree,
  disagree,
  unsure,
});

describe("seedMatches", () => {
  test("SHA-256 over the seed's bytes, not its text", async () => {
    // sha256 of 16 zero bytes.
    const seed = "00".repeat(16);
    const commitment = "374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb";
    expect(await seedMatches(seed, commitment)).toBe(true);
    expect(await seedMatches("11".repeat(16), commitment)).toBe(false);
    expect(await seedMatches("not hex", commitment)).toBe(false);
    expect(await seedMatches("00", commitment)).toBe(false);
  });
});

describe("rowProblem (k = 10)", () => {
  test("under k in all, everything must be hidden", () => {
    expect(rowProblem(row(S, S, S), { agree: 9, disagree: 0, unsure: 0 })).toBeNull();
    expect(rowProblem(row(S, n(0), S), { agree: 9, disagree: 0, unsure: 0 })).toMatch(/shown/);
  });
  test("at k and above, small counts hidden and shown counts exact", () => {
    expect(rowProblem(row(n(10), n(0), n(0)), { agree: 10, disagree: 0, unsure: 0 })).toBeNull();
    expect(rowProblem(row(S, S, n(0)), { agree: 10, disagree: 1, unsure: 0 })).toBeNull();
    expect(rowProblem(row(n(10), n(1), n(0)), { agree: 10, disagree: 1, unsure: 0 })).toMatch(/under k/);
    expect(rowProblem(row(n(12), n(0), n(0)), { agree: 11, disagree: 0, unsure: 0 })).toMatch(/shows 12/);
  });
});

describe("grouping and the shared case", () => {
  test("votes group by clause id and tier", () => {
    const t = tallies([
      { ruleRef: "honesty.spam@1", tier: null, vote: "agree" },
      { ruleRef: "honesty.spam@2", tier: null, vote: "disagree" },
      { ruleRef: "safety.weapons@1", tier: "t1", vote: "unsure" },
      { ruleRef: null, tier: null, vote: "agree" },
    ]);
    expect([...t.entries()]).toEqual([
      ["honesty.spam|", { agree: 1, disagree: 1, unsure: 0 }],
      ["safety.weapons|t1", { agree: 0, disagree: 0, unsure: 1 }],
    ]);
    expect(clauseIdOf("decency.intimate-images@1")).toBe("decency.intimate-images");
  });
  test("the first case every juror sees", () => {
    expect(
      sharedCase([
        ["a", "b"],
        ["b", "a"],
        ["c", "b"],
      ]),
    ).toBe("b");
    expect(sharedCase([["a"], ["b"]])).toBeNull();
    expect(sharedCase([])).toBeNull();
  });
  test("the step is implemented", () => {
    expect(stepJury).toBeTypeOf("function");
    expect(stepJury.toString()).not.toContain("not merged");
  });
});
