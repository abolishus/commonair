// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { PatronageLine, type PatronageWeights } from "@commonair/contracts/shapes";
import {
  type AllocationResult,
  FORMULAS,
  MEMBER_COMPONENTS,
  type MemberInputs,
  type PatronageFormatter,
  englishFormatter,
  explainLine,
  getFormula,
  waterFill,
} from "../src/index.ts";

const WEIGHTS: PatronageWeights = {
  revenue: 0.5,
  streamingHours: 0.2,
  relayBandwidth: 0.2,
  viewerHours: 0.1,
  dailyStreamingHourCap: 8,
  viewerHoursChannelCap: 0.1,
};
const formula = getFormula("2026.1");

function m(userId: string, over: Partial<MemberInputs> = {}): MemberInputs {
  return {
    userId,
    revenueCents: 0,
    eligibleStreamingHours: 0,
    relayBytesVerified: 0,
    viewerHoursVerified: 0,
    viewerHoursExcluded: 0,
    ...over,
  };
}

function allocate(members: MemberInputs[], surplusCents = 100_000, weights = WEIGHTS): AllocationResult {
  return formula.allocate({ surplusCents, currency: "usd", weights, members });
}

function amounts(r: AllocationResult): Record<string, number> {
  return Object.fromEntries(r.allocations.map((a) => [a.userId, a.amountCents]));
}

function expectExact(r: AllocationResult, surplus: number): void {
  const total = r.allocations.reduce((s, a) => s + a.amountCents, 0);
  expect(total + r.retainedCents).toBe(surplus);
  expect(r.pools.reduce((s, p) => s + p.poolCents, 0)).toBe(surplus);
  for (const p of r.pools) {
    const allocated = r.allocations.reduce(
      (s, a) => s + a.lines.filter((l) => l.component === p.component).reduce((x, l) => x + l.amountCents, 0),
      0,
    );
    expect(allocated).toBe(p.allocatedCents);
    expect(p.allocatedCents + p.retainedCents).toBe(p.poolCents);
  }
  for (const a of r.allocations) {
    expect(a.lines.map((l) => l.component)).toEqual([...MEMBER_COMPONENTS]);
    expect(a.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(a.amountCents);
    for (const l of a.lines) {
      expect(() => PatronageLine.parse(l)).not.toThrow();
      expect(l.explanation.length).toBeGreaterThan(10);
      expect(l.amountCents).toBeGreaterThanOrEqual(0);
    }
  }
}

/** The worked example documented in README.md. */
const EXAMPLE = [
  m("a", { revenueCents: 400_000, eligibleStreamingHours: 40, viewerHoursVerified: 500 }),
  m("b", { revenueCents: 100_000, eligibleStreamingHours: 20, relayBytesVerified: 200e9, viewerHoursVerified: 100 }),
  m("c", { relayBytesVerified: 600e9 }),
  m("d", { eligibleStreamingHours: 10, relayBytesVerified: 200e9, viewerHoursVerified: 50 }),
  m("e"),
];

describe("formula 2026.1", () => {
  test("worked example with five members and the default weights", () => {
    const r = allocate(EXAMPLE);
    expectExact(r, 100_000);
    expect(r.formulaVersion).toBe("2026.1");
    expect(r.pools.map((p) => [p.component, p.poolCents])).toEqual([
      ["revenue", 50_000],
      ["streamingHours", 20_000],
      ["relayBandwidth", 20_000],
      ["viewerHours", 10_000],
    ]);
    // revenue 80/20; hours 40:20:10 of 70 (one leftover cent to the largest remainder);
    // relay 0:20:60:20 %; viewer-hours: everyone capped at 10% of the pool, 70% retained.
    expect(amounts(r)).toEqual({
      a: 40_000 + 11_429 + 0 + 1000,
      b: 10_000 + 5714 + 4000 + 1000,
      c: 12_000,
      d: 2857 + 4000 + 1000,
      e: 0,
    });
    expect(r.retainedCents).toBe(7000);
    expect(r.retainedLines).toHaveLength(1);
    expect(r.retainedLines[0]).toMatchObject({ component: "adjustment", amountCents: 7000, poolCents: 10_000 });
    const a = r.allocations.find((x) => x.userId === "a")!;
    expect(a.lines[0]!.explanation).toBe("Revenue: $4,000.00 of $5,000.00 (80.00%) of the $500.00 pool = $400.00");
    expect(a.lines[3]).toMatchObject({ capApplied: true, amountCents: 1000 });
    expect(a.lines[3]!.explanation).toMatch(/capped at 10\.00% of the pool/);
  });

  test("weights are taken from the input, not hard-coded", () => {
    const r = allocate(EXAMPLE, 100_000, {
      ...WEIGHTS,
      revenue: 1,
      streamingHours: 0,
      relayBandwidth: 0,
      viewerHours: 0,
    });
    expectExact(r, 100_000);
    expect(amounts(r)).toMatchObject({ a: 80_000, b: 20_000, c: 0, d: 0, e: 0 });
    expect(r.retainedCents).toBe(0);
    expect(() => allocate(EXAMPLE, 100, { ...WEIGHTS, revenue: 0.6 })).toThrow(/sum to 1/);
  });

  test("zero inputs: every pool rolls into retained surplus with an explanation", () => {
    const r = allocate([m("x"), m("y")], 12_345);
    expectExact(r, 12_345);
    expect(r.retainedCents).toBe(12_345);
    expect(r.retainedLines.map((l) => l.component)).toEqual([...MEMBER_COMPONENTS]);
    for (const l of r.retainedLines) expect(l.explanation).toMatch(/no eligible contributions/);
    expect(amounts(r)).toEqual({ x: 0, y: 0 });
  });

  test("no members at all retains everything", () => {
    const r = allocate([], 999);
    expectExact(r, 999);
    expect(r.allocations).toEqual([]);
    expect(r.retainedCents).toBe(999);
  });

  test("a single viewer-hours member is capped and the rest retained", () => {
    const r = allocate([m("solo", { viewerHoursVerified: 3 })], 10_000, {
      ...WEIGHTS,
      revenue: 0,
      streamingHours: 0,
      relayBandwidth: 0,
      viewerHours: 1,
    });
    expectExact(r, 10_000);
    expect(amounts(r)).toEqual({ solo: 1000 });
    expect(r.retainedCents).toBe(9000);
  });

  test("cap redistribution: excess flows to the uncapped, iterating until stable", () => {
    // One dominant channel, one mid-sized and twenty small ones; cap 10%.
    const members = [
      m("big", { viewerHoursVerified: 1000 }),
      m("mid", { viewerHoursVerified: 100 }),
      ...Array.from({ length: 20 }, (_, i) => m(`s${String(i).padStart(2, "0")}`, { viewerHoursVerified: 10 + i })),
    ];
    const vhOnly = { ...WEIGHTS, revenue: 0, streamingHours: 0, relayBandwidth: 0, viewerHours: 1 };
    const r = allocate(members, 100_000, vhOnly);
    expectExact(r, 100_000);
    const got = amounts(r);
    // big is capped in round one; with its excess redistributed, mid crosses the cap in round two.
    expect(got.big).toBe(10_000);
    expect(got.mid).toBe(10_000);
    for (const [id, cents] of Object.entries(got)) expect(cents, id).toBeLessThanOrEqual(10_000);
    expect(r.retainedCents).toBe(0);
    // The small channels share the remaining 80,000 in proportion to their hours.
    const smallTotal = Array.from({ length: 20 }, (_, i) => 10 + i).reduce((s, x) => s + x, 0);
    const s19 = got.s19!;
    expect(Math.abs(s19 - (80_000 * 29) / smallTotal)).toBeLessThan(1);
    const capped = r.allocations.filter((a) => a.lines[3]!.capApplied).map((a) => a.userId);
    expect(capped.sort()).toEqual(["big", "mid"]);
  });

  test("waterFill: all capped, none capped, and empty pool", () => {
    const c = (userId: string, u: bigint) => ({ userId, u });
    const all = waterFill(1000, [c("a", 5n), c("b", 5n)], 100);
    expect([...all.amounts]).toEqual([
      ["a", 100],
      ["b", 100],
    ]);
    expect(all.retainedCents).toBe(800);
    const none = waterFill(1000, [c("a", 1n), c("b", 1n)], 1000);
    expect(none.capped.size).toBe(0);
    expect(none.retainedCents).toBe(0);
    const empty = waterFill(0, [c("a", 1n)], 0);
    expect(empty.amounts.get("a")).toBe(0);
    expect(empty.retainedCents).toBe(0);
  });

  test("property: rounding is exact and nobody exceeds the viewer-hours cap", () => {
    let seed = 12_345;
    const rand = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(rand() * 25);
      const members = Array.from({ length: n }, (_, k) =>
        m(`u${k}`, {
          revenueCents: rand() < 0.3 ? 0 : Math.floor(rand() * 1e7),
          eligibleStreamingHours: rand() < 0.3 ? 0 : Math.round(rand() * 2000) / 7,
          relayBytesVerified: rand() < 0.5 ? 0 : Math.floor(rand() * 1e12),
          viewerHoursVerified: rand() < 0.3 ? 0 : rand() * (rand() < 0.1 ? 1e5 : 100),
        }),
      );
      const surplus = Math.floor(rand() * 10_000_000);
      const cap = 0.05 + rand() * 0.5;
      const r = allocate(members, surplus, { ...WEIGHTS, viewerHoursChannelCap: cap });
      expectExact(r, surplus);
      const vhPool = r.pools.find((p) => p.component === "viewerHours")!.poolCents;
      const capCents = Math.floor((vhPool * Math.round(cap * 1e6)) / 1e6);
      for (const a of r.allocations) expect(a.lines[3]!.amountCents).toBeLessThanOrEqual(capCents);
    }
  }, 60_000); // CPU-bound property run; the gate runs every package at once

  test("deterministic: input order does not matter, ties break by user id", () => {
    const a = allocate(EXAMPLE);
    const b = allocate([...EXAMPLE].reverse());
    expect(b).toEqual(a);
    const tie = allocate([m("z", { revenueCents: 1 }), m("a", { revenueCents: 1 }), m("m", { revenueCents: 1 })], 2, {
      ...WEIGHTS,
      revenue: 1,
      streamingHours: 0,
      relayBandwidth: 0,
      viewerHours: 0,
    });
    expect(amounts(tie)).toEqual({ a: 1, m: 1, z: 0 });
  });

  test("negative net revenue counts as zero; invalid inputs are rejected", () => {
    const r = allocate([m("a", { revenueCents: -500 }), m("b", { revenueCents: 500 })], 1000);
    expect(r.allocations.find((x) => x.userId === "a")!.lines[0]!.amountCents).toBe(0);
    expect(() => allocate([m("a", { eligibleStreamingHours: -1 })])).toThrow(RangeError);
    expect(() => allocate([m("a", { viewerHoursVerified: Number.NaN })])).toThrow(RangeError);
    expect(() => allocate([m("a"), m("a")])).toThrow(RangeError);
    expect(() => allocate([m("a")], -1)).toThrow(RangeError);
    expect(() => allocate([m("a")], 1.5)).toThrow(RangeError);
  });

  test("the registry rejects unknown versions", () => {
    expect(FORMULAS["2026.1"]?.version).toBe("2026.1");
    expect(() => getFormula("1999.1")).toThrow(RangeError);
  });
});

describe("explanations", () => {
  test("a custom formatter localizes every line", () => {
    const base = englishFormatter("usd");
    const fr: PatronageFormatter = {
      ...base,
      component: (c) =>
        ({
          revenue: "Revenus",
          streamingHours: "Heures",
          relayBandwidth: "Relais",
          viewerHours: "Spectateurs",
          adjustment: "Ajustement",
        })[c],
      templates: {
        contribution: (p) => `${p.label} : ${p.member} sur ${p.total} (${p.share}) → ${p.amount}`,
        capped: () => " (plafonné)",
        emptyPool: (p) => `${p.label} : aucune contribution`,
        capOverflow: (p) => `${p.label} : ${p.amount} conservé`,
      },
    };
    const r = formula.allocate({ surplusCents: 100_000, currency: "usd", weights: WEIGHTS, members: EXAMPLE }, fr);
    expect(r.allocations[0]!.lines[0]!.explanation).toMatch(/^Revenus : /);
    expect(r.allocations[0]!.lines[3]!.explanation).toMatch(/\(plafonné\)$/);
    expect(r.retainedLines[0]!.explanation).toBe("Ajustement : $70.00 conservé");
    // Stored lines can be re-explained later from their numbers alone.
    const stored = allocate(EXAMPLE).allocations[0]!.lines[1]!;
    expect(explainLine(stored, fr)).toMatch(/^Heures : 40\.00 h sur 70\.00 h/);
    expect(explainLine(stored, base)).toBe(stored.explanation);
  });

  test("units are formatted per component", () => {
    const f = englishFormatter("eur");
    expect(f.value("revenue", 123_456)).toBe("€1,234.56");
    expect(f.value("relayBandwidth", 1.5e9)).toBe("1.50 GB");
    expect(f.value("streamingHours", 2.5)).toBe("2.50 h");
  });
});
