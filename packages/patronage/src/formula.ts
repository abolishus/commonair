// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Versioned patronage formulas. A period records the version and weights it was computed
 * with, so a statement can always be reproduced, and a new formula is a new registry entry
 * (adopted by a protected decision changing `patronage.formula`), never an edit of an old one.
 */
import type { PatronageLine } from "@commonair/contracts/shapes";
import { PatronageWeights } from "@commonair/contracts/shapes";
import { assertCents, floorShare, largestRemainder, toMicros } from "@commonair/ledger";
import { type PatronageFormatter, englishFormatter, explainLine } from "./explain.ts";

export const MEMBER_COMPONENTS = ["revenue", "streamingHours", "relayBandwidth", "viewerHours"] as const;
export type MemberComponent = (typeof MEMBER_COMPONENTS)[number];

/** One eligible member's inputs for a period (the `patronage_inputs` row). */
export interface MemberInputs {
  userId: string;
  /** Subscription + tip gross net of refunds and chargebacks; negative counts as zero. */
  revenueCents: number;
  eligibleStreamingHours: number;
  relayBytesVerified: number;
  viewerHoursVerified: number;
  /** Shown on the statement; never paid on. */
  viewerHoursExcluded: number;
}

export interface AllocationInput {
  surplusCents: number;
  currency: string;
  weights: PatronageWeights;
  members: readonly MemberInputs[];
}

export interface MemberAllocation {
  userId: string;
  amountCents: number;
  /** One line per component, in MEMBER_COMPONENTS order. */
  lines: PatronageLine[];
}

export interface PoolSummary {
  component: MemberComponent;
  poolCents: number;
  allocatedCents: number;
  retainedCents: number;
}

export interface AllocationResult {
  formulaVersion: string;
  pools: PoolSummary[];
  /** Every member, ordered by user id (zero allocations included so statements explain them). */
  allocations: MemberAllocation[];
  /** Surplus kept by the co-op: empty pools and cap overflow. allocations + retained = surplus. */
  retainedCents: number;
  retainedLines: PatronageLine[];
}

export interface PatronageFormula {
  version: string;
  allocate(input: AllocationInput, fmt?: PatronageFormatter): AllocationResult;
}

/** Hours are compared in whole seconds, bytes and cents as integers: exact and deterministic. */
function units(component: MemberComponent, m: MemberInputs): bigint {
  const check = (name: string, v: number) => {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} for ${m.userId} must be a non-negative number`);
    return v;
  };
  switch (component) {
    case "revenue":
      if (!Number.isFinite(m.revenueCents)) throw new RangeError(`revenueCents for ${m.userId} must be finite`);
      return BigInt(Math.max(0, Math.round(m.revenueCents)));
    case "streamingHours":
      return BigInt(Math.round(check("eligibleStreamingHours", m.eligibleStreamingHours) * 3600));
    case "relayBandwidth":
      return BigInt(Math.round(check("relayBytesVerified", m.relayBytesVerified)));
    case "viewerHours":
      return BigInt(Math.round(check("viewerHoursVerified", m.viewerHoursVerified) * 3600));
  }
}

function displayValue(component: MemberComponent, u: bigint): number {
  return component === "streamingHours" || component === "viewerHours" ? Number(u) / 3600 : Number(u);
}

interface PoolOutcome {
  amounts: Map<string, number>;
  capped: Set<string>;
  retainedCents: number;
}

/** Proportional split of a pool among members with a positive contribution. */
function proportional(poolCents: number, contributors: readonly { userId: string; u: bigint }[]): PoolOutcome {
  const parts = largestRemainder(
    poolCents,
    contributors.map((c) => ({ key: c.userId, weight: c.u })),
  );
  return { amounts: new Map(parts.map((p) => [p.key, p.cents])), capped: new Set(), retainedCents: 0 };
}

/**
 * Water-filling: nobody may receive more than `capCents`. Members whose proportional share
 * would exceed it are capped and the excess is shared proportionally among the rest,
 * repeating until no further member crosses the cap. If everyone ends up capped, what is left
 * is retained. Comparisons are exact (BigInt cross-multiplication).
 */
export function waterFill(
  poolCents: number,
  contributors: readonly { userId: string; u: bigint }[],
  capCents: number,
): PoolOutcome {
  const capped = new Set<string>();
  const cap = BigInt(capCents);
  for (;;) {
    const open = contributors.filter((c) => !capped.has(c.userId));
    if (open.length === 0) break;
    const remaining = BigInt(poolCents) - BigInt(capped.size) * cap;
    const total = open.reduce((s, c) => s + c.u, 0n);
    const over = open.filter((c) => remaining * c.u > cap * total);
    if (over.length === 0) break;
    for (const c of over) capped.add(c.userId);
  }
  const open = contributors.filter((c) => !capped.has(c.userId));
  const remaining = poolCents - capped.size * capCents;
  const amounts = new Map<string, number>([...capped].map((id) => [id, capCents]));
  if (open.length === 0) return { amounts, capped, retainedCents: remaining };
  for (const [id, cents] of proportional(remaining, open).amounts) amounts.set(id, cents);
  return { amounts, capped, retainedCents: 0 };
}

function allocate2026_1(input: AllocationInput, fmt?: PatronageFormatter): AllocationResult {
  assertCents("surplus", input.surplusCents);
  const weights = PatronageWeights.parse(input.weights);
  const format = fmt ?? englishFormatter(input.currency);
  const members = [...input.members].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  if (new Set(members.map((m) => m.userId)).size !== members.length) throw new RangeError("duplicate member ids");

  // Ties between pools go to the earlier component, so the split is deterministic.
  const poolParts = largestRemainder(
    input.surplusCents,
    MEMBER_COMPONENTS.map((c) => ({ key: c, weight: toMicros(weights[c]) })),
  );
  const pools: PoolSummary[] = [];
  const retainedLines: PatronageLine[] = [];
  const lineBy = new Map<string, PatronageLine[]>(members.map((m) => [m.userId, []]));

  for (const { key: component, cents: poolCents } of poolParts) {
    const all = members.map((m) => ({ userId: m.userId, u: units(component, m) }));
    const contributors = all.filter((c) => c.u > 0n);
    const totalUnits = contributors.reduce((s, c) => s + c.u, 0n);
    let outcome: PoolOutcome;
    if (contributors.length === 0) {
      outcome = { amounts: new Map(), capped: new Set(), retainedCents: poolCents };
      const line = {
        component,
        memberValue: 0,
        poolTotal: 0,
        share: 0,
        poolCents,
        amountCents: poolCents,
        capApplied: false,
      };
      if (poolCents > 0) retainedLines.push({ ...line, explanation: explainLine(line, format) });
    } else if (component === "viewerHours") {
      outcome = waterFill(poolCents, contributors, floorShare(poolCents, weights.viewerHoursChannelCap));
      if (outcome.retainedCents > 0) {
        const line = {
          component: "adjustment" as const,
          memberValue: displayValue(component, totalUnits),
          poolTotal: displayValue(component, totalUnits),
          share: outcome.retainedCents / poolCents,
          poolCents,
          amountCents: outcome.retainedCents,
          capApplied: true,
        };
        retainedLines.push({ ...line, explanation: explainLine(line, format) });
      }
    } else {
      outcome = proportional(poolCents, contributors);
    }

    for (const c of all) {
      const line = {
        component,
        memberValue: displayValue(component, c.u),
        poolTotal: displayValue(component, totalUnits),
        share: totalUnits === 0n ? 0 : Number(c.u) / Number(totalUnits),
        poolCents,
        amountCents: outcome.amounts.get(c.userId) ?? 0,
        capApplied: outcome.capped.has(c.userId),
      };
      // Invariant: lineBy was built from the same member list, so every id is present.
      lineBy.get(c.userId)!.push({ ...line, explanation: explainLine(line, format) });
    }
    pools.push({
      component,
      poolCents,
      allocatedCents: poolCents - outcome.retainedCents,
      retainedCents: outcome.retainedCents,
    });
  }

  const allocations = members.map((m) => {
    const lines = lineBy.get(m.userId) ?? [];
    return { userId: m.userId, amountCents: lines.reduce((s, l) => s + l.amountCents, 0), lines };
  });
  const retainedCents = pools.reduce((s, p) => s + p.retainedCents, 0);
  return { formulaVersion: "2026.1", pools, allocations, retainedCents, retainedLines };
}

/** The formula registry. Never edit a published version; add a new one. */
export const FORMULAS: Readonly<Record<string, PatronageFormula>> = {
  "2026.1": { version: "2026.1", allocate: allocate2026_1 },
};

export function getFormula(version: string): PatronageFormula {
  const f = FORMULAS[version];
  if (!f) throw new RangeError(`unknown patronage formula version ${version}`);
  return f;
}
