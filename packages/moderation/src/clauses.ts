// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The clause catalog as the open enforcement report sees it (batch 6 decision (d), ADR 0019
 * decision 1): `rule_ref` (`<clause id>@<version>`) on cases, appeals and platform mod actions, and
 * the report's grouping of clauses into areas. It declares no clause: the catalog is `CLAUSES` in
 * `reasons.ts`, re-exported here so the report and the writers import one module. Pure.
 */
import { RULE_REF_PATTERN } from "@commonair/contracts/enums";
import { CLAUSES, clauseFor, clauseRef, type ClauseInput } from "./reasons.ts";

export {
  CATEGORY_CLAUSES,
  CLAUSES,
  clauseFor,
  clauseRef,
  currentClause,
  FALLBACK_CLAUSE_ID,
  findClause,
  NCII_CLAUSE_ID,
  REPORT_REASON_CLAUSES,
  T2_CLAUSE_ID,
  type Clause,
  type ClauseInput,
} from "./reasons.ts";

/** The report's areas, in display order (`EnforcementReportRow.group`). */
export const REPORT_GROUP_IDS = ["safety", "decency", "honesty", "creative", "mature", "illegal", "general"] as const;
export type ReportGroup = (typeof REPORT_GROUP_IDS)[number];

/** A clause id's prefix (`<area>.<rule>`) → its report area; `guidelines.*` is the general area. */
const PREFIX_GROUPS: Readonly<Record<string, ReportGroup>> = {
  safety: "safety",
  decency: "decency",
  honesty: "honesty",
  creative: "creative",
  mature: "mature",
  illegal: "illegal",
  guidelines: "general",
};

/** The area of a clause id by its prefix, or undefined for a prefix the report does not know. */
export function groupOfClauseId(id: string): ReportGroup | undefined {
  const prefix = id.split(".", 1)[0] ?? "";
  return Object.hasOwn(PREFIX_GROUPS, prefix) ? PREFIX_GROUPS[prefix] : undefined;
}

/**
 * Every clause id in `CLAUSES` → its area. A clause with an unknown prefix is left out, and
 * `tests/clauses.test.ts` fails on it: a new area is a deliberate change to the report.
 */
export const REPORT_GROUPS: Readonly<Record<string, ReportGroup>> = Object.freeze(
  Object.fromEntries(
    CLAUSES.flatMap((c) => {
      const g = groupOfClauseId(c.id);
      return g ? [[c.id, g] as const] : [];
    }),
  ),
);

/** The `rule_ref` an action with these facts cites: `clauseRef(clauseFor(input))`. */
export const ruleRefFor = (input: ClauseInput): string => clauseRef(clauseFor(input));

const RULE_REF = new RegExp(RULE_REF_PATTERN);

/**
 * `<clause id>@<version>` back into its parts, or null for anything the database CHECK
 * (`RULE_REF_PATTERN`) refuses. It does not check that the clause exists (`findClause` does).
 */
export function parseRuleRef(ref: string): { id: string; version: number } | null {
  if (!RULE_REF.test(ref)) return null;
  const at = ref.lastIndexOf("@");
  const version = Number(ref.slice(at + 1));
  if (!Number.isSafeInteger(version)) return null;
  return { id: ref.slice(0, at), version };
}
