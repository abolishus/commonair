// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Every table is seeded": each table in the Drizzle schema belongs to exactly one unit, the base
 * seed, or `NOT_SEEDED` with a reason. A new table that is in none of them fails the coverage test,
 * so it cannot ship without seed data or an explicit decision.
 */
import type { SeedUnit } from "./types.ts";

/** Filled by `seedGovernanceSettings` / `seedLegalDocuments` at migration time, on every instance. */
export const BASE_SEEDED: Readonly<Record<string, string>> = {
  governance_settings: "default governance settings (packages/db seed.ts)",
  legal_documents: "the bundled legal documents (packages/db seed.ts)",
};

/** Tables deliberately left empty, each with the reason. Keep this list short. */
export const NOT_SEEDED: Readonly<Record<string, string>> = {
  verifications: "short-lived email-verification and reset tokens; signing up writes them and nothing lists them",
};

export interface CoverageProblems {
  /** Schema tables nobody claims. */
  unclaimed: string[];
  /** Tables claimed more than once, with every claimant. */
  duplicated: { table: string; by: string[] }[];
  /** Claimed names that are not schema tables (typos, dropped tables). */
  unknown: string[];
  /** Pending tables a unit does not own. */
  strayPending: { unit: string; table: string }[];
}

export function coverageProblems(schemaTables: readonly string[], units: readonly SeedUnit[]): CoverageProblems {
  const claims = new Map<string, string[]>();
  const claim = (table: string, by: string) => claims.set(table, [...(claims.get(table) ?? []), by]);
  for (const u of units) for (const t of u.tables) claim(t, `seed-${u.name}`);
  for (const t of Object.keys(BASE_SEEDED)) claim(t, "base");
  for (const t of Object.keys(NOT_SEEDED)) claim(t, "not-seeded");
  const known = new Set(schemaTables);
  return {
    unclaimed: schemaTables.filter((t) => !claims.has(t)),
    duplicated: [...claims].filter(([, by]) => by.length > 1).map(([table, by]) => ({ table, by })),
    unknown: [...claims.keys()].filter((t) => !known.has(t)).sort(),
    strayPending: units.flatMap((u) =>
      u.pending.filter((t) => !u.tables.includes(t)).map((table) => ({ unit: u.name, table })),
    ),
  };
}

/** Owned tables still pending, per unit (empty everywhere at the milestone). */
export function pendingTables(units: readonly SeedUnit[]): Record<string, readonly string[]> {
  return Object.fromEntries(units.filter((u) => u.pending.length > 0).map((u) => [u.name, u.pending]));
}
