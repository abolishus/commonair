// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `rule_ref` the API's writers stamp on platform actions (batch 6 decision (d), ADR 0019): the
 * clause `id@version` the action cites, from the catalog at action time. Channel-scope actions
 * never carry one (the `mod_actions_rule_ref_platform` CHECK refuses it).
 */
import type { ModerationCategory, REPORT_REASONS } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";
import { clauseFor, clauseRef, currentClause, REPORT_REASON_CLAUSES } from "@commonair/moderation";
import { and, asc, eq } from "drizzle-orm";
import { badRequest } from "../lib/errors.ts";

type ReportReason = (typeof REPORT_REASONS)[number];
type CaseDecision = "warn" | "end_stream" | "suspend";
type CaseFacts = { category: ModerationCategory | null; ruleRef: string | null; origin: string };
const { enforcementStatements: st, moderationCases, modActions } = schema;

/** A report-origin case cites the report's reason (`REPORT_REASON_CLAUSES`), as its statement will. */
export const reportReasonRuleRef = (reportReason: ReportReason): string =>
  clauseRef(clauseFor({ action: "moderation.case.warn", category: null, reportReason }));

/**
 * The clause a staff action names (`safety.resolve` / `safety.suspend` `clauseId`, ADR 0019
 * acceptance answer 3), at its current version; null when none is named. An id the catalog does
 * not know is refused: the database checks only the format. So is an illegal ground: `illegal.ncii`
 * is reserved for the NCII request process and NCII-list matches (`reasons.ts`), and a staff action
 * citing it would be counted as one of those.
 */
export function staffRuleRef(clauseId: string | undefined): string | null {
  if (clauseId === undefined) return null;
  const c = currentClause(clauseId);
  if (!c) throw badRequest("Unknown clause");
  if (c.ground === "illegal") throw badRequest("This clause is not available to staff actions");
  return clauseRef(c);
}

const REPORT_REASON_CLAUSE_IDS: ReadonlySet<string> = new Set(Object.values(REPORT_REASON_CLAUSES));
const clauseIdOf = (ruleRef: string) => ruleRef.slice(0, ruleRef.lastIndexOf("@"));

/**
 * What a moderator's decision on a case cites, as the statement builder decides it (`clauseFor`,
 * `sor-build.ts`): the classifier category, else for a human-origin case the report reason (which
 * the case already cites, `reportReasonRuleRef`), else the general clause. Any other clause on the
 * case row (a T0 NCII-list match's `illegal.ncii`) is not what the decision's statement cites.
 */
export function caseDecisionRuleRef(c: CaseFacts, decision: CaseDecision): string {
  const action = `moderation.case.${decision}` as const;
  if (c.category) return clauseRef(clauseFor({ action, category: c.category, reportReason: null }));
  if (c.origin === "human" && c.ruleRef && REPORT_REASON_CLAUSE_IDS.has(clauseIdOf(c.ruleRef))) return c.ruleRef;
  return clauseRef(clauseFor({ action, category: null, reportReason: null }));
}

/** A decided case keeps the clause it cites; one without (older rows) takes the decision's. */
export function caseRuleRefAfter(c: CaseFacts, decision: string): string | null {
  if (c.ruleRef) return c.ruleRef;
  return decision === "warn" || decision === "end_stream" || decision === "suspend"
    ? caseDecisionRuleRef(c, decision)
    : null;
}

/**
 * The clause an appeal's subject cites: the statement of reasons that offered this appeal, else
 * the case's or the mod action's own `rule_ref`; null for subjects that cite none (integrity,
 * account actions, channel bans).
 */
export async function appealRuleRef(tx: Executor, subjectType: string, subjectId: string): Promise<string | null> {
  const [s] = await tx
    .select({ id: st.clauseId, version: st.clauseVersion })
    .from(st)
    .where(and(eq(st.appealSubjectType, subjectType), eq(st.appealSubjectId, subjectId)))
    .orderBy(asc(st.createdAt))
    .limit(1);
  if (s) return clauseRef(s);
  if (subjectType === "moderation_case") {
    const [c] = await tx
      .select({ ruleRef: moderationCases.ruleRef })
      .from(moderationCases)
      .where(eq(moderationCases.id, subjectId));
    return c?.ruleRef ?? null;
  }
  if (subjectType === "moderation_action") {
    const [m] = await tx.select({ ruleRef: modActions.ruleRef }).from(modActions).where(eq(modActions.id, subjectId));
    return m?.ruleRef ?? null;
  }
  return null;
}
