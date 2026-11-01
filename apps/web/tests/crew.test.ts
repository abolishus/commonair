// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { PREVIEW_EXAMPLE_CENTS, crewPreview, isBasis, parseBps } from "../src/components/money/crew.tsx";
import { splitWriteOffCents } from "../src/components/money/transparency.tsx";

describe("crew form helpers", () => {
  test("parseBps takes whole basis points in [1, 9999] only", () => {
    expect(parseBps("1")).toBe(1);
    expect(parseBps(" 2500 ")).toBe(2500);
    expect(parseBps("9999")).toBe(9999);
    for (const bad of ["", "0", "10000", "12.5", "-3", "1e3", "abc"]) expect(parseBps(bad)).toBeNull();
  });

  test("isBasis accepts the contract's bases", () => {
    expect(["tips", "subs", "all"].every(isBasis)).toBe(true);
    expect(isBasis("gifts")).toBe(false);
  });
});

describe("crewPreview", () => {
  test("a $10 tip at a 90% creator share: the co-op first, then the crew by basis points", () => {
    expect(PREVIEW_EXAMPLE_CENTS).toBe(1000);
    expect(
      crewPreview(1000, 0.9, [
        { username: "mod", bps: 1000 },
        { username: "editor", bps: 2500 },
      ]),
    ).toEqual({
      ownerCents: 585,
      crew: [
        { username: "mod", cents: 90 },
        { username: "editor", cents: 225 },
      ],
    });
  });

  test("the parts always sum to the creator share, rounding cents to the largest remainders", () => {
    const p = crewPreview(1000, 0.9, [
      { username: "a", bps: 3333 },
      { username: "b", bps: 3333 },
    ]);
    expect(p).not.toBeNull();
    expect((p?.ownerCents ?? 0) + (p?.crew ?? []).reduce((s, c) => s + c.cents, 0)).toBe(900);
  });

  test("nothing to preview without a full row, or when the crew would take everything", () => {
    expect(crewPreview(1000, 0.9, [])).toBeNull();
    expect(crewPreview(1000, 0.9, [{ username: " ", bps: 100 }])).toBeNull();
    expect(
      crewPreview(1000, 0.9, [
        { username: "a", bps: 6000 },
        { username: "b", bps: 4000 },
      ]),
    ).toBeNull();
  });
});

describe("transparency split lines", () => {
  test("the write-off total is the split-shortfall-writeoff cost line of every month shown", () => {
    const month = (cents: number[]) => ({
      costs: [
        { category: "payment-fees", amount: { cents: 999, currency: "usd" } },
        ...cents.map((c) => ({ category: "split-shortfall-writeoff", amount: { cents: c, currency: "usd" } })),
      ],
    });
    expect(splitWriteOffCents([month([450]), month([]), month([50])])).toBe(500);
    expect(splitWriteOffCents([])).toBe(0);
  });
});
