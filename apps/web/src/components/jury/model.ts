// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The advisory jury's web types and labels (ADR 0038; `jury.*`). Pure. */
import { JURY_REASON_CODES, JURY_VOTES } from "@commonair/contracts/enums";
import type { MessageKey } from "../../i18n/index.ts";
import type { api } from "../../lib/api.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";

type Api = ReturnType<typeof api>;
export type JuryStatusDto = Awaited<ReturnType<Api["jury"]["status"]>>;
export type JuryPanelDto = NonNullable<Awaited<ReturnType<Api["jury"]["panel"]>>>;
export type JuryCaseDto = Awaited<ReturnType<Api["jury"]["cases"]>>[number];
export type JuryFlagDto = Awaited<ReturnType<Api["jury"]["flags"]["list"]>>["items"][number];
export type JuryResultsDto = Awaited<ReturnType<Api["jury"]["results"]>>;
export type JuryVote = (typeof JURY_VOTES)[number];
export type JuryReasonCode = (typeof JURY_REASON_CODES)[number];

export { JURY_REASON_CODES, JURY_VOTES };

/** A panel sits 14 days from its draw (ADR 0038 decision 8). */
export const PANEL_DAYS = 14;

export function panelClosesAt(openedAt: string): string {
  return new Date(Date.parse(openedAt) + PANEL_DAYS * 86_400_000).toISOString();
}

export const VOTE_KEYS: Record<JuryVote, MessageKey> = {
  agree: "jury.vote.agree",
  disagree: "jury.vote.disagree",
  unsure: "jury.vote.unsure",
};

export const REASON_KEYS: Record<JuryReasonCode, MessageKey> = {
  clause_fits: "jury.reason.clause_fits",
  clause_does_not_fit: "jury.reason.clause_does_not_fit",
  action_too_severe: "jury.reason.action_too_severe",
  action_too_lenient: "jury.reason.action_too_lenient",
  context_missing: "jury.reason.context_missing",
  evidence_unclear: "jury.reason.evidence_unclear",
  other: "jury.reason.other",
};

const OUTCOME_KEYS: Record<string, MessageKey> = {
  cleared: "jury.case.outcome.cleared",
  actioned: "jury.case.outcome.actioned",
  dismissed: "jury.case.outcome.dismissed",
  confirmed: "jury.case.outcome.confirmed",
};

export const outcomeKey = (outcome: string): MessageKey => OUTCOME_KEYS[outcome] ?? "jury.case.outcome.other";

export const KIND_KEYS: Record<JuryCaseDto["subjectKind"], MessageKey> = {
  moderation_case: "jury.case.kind.moderation_case",
  report: "jury.case.kind.report",
};

/** `<id>@<version>` → its version, or null. */
export function ruleVersion(ruleRef: string | null): number | null {
  if (!ruleRef) return null;
  const v = Number(ruleRef.slice(ruleRef.lastIndexOf("@") + 1));
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Why the caller cannot opt in, as far as the web knows (the API decides). */
export type IneligibleReason = "staff" | "not_member" | "other";

export function ineligibleReason(
  me: Pick<SessionUser, "role"> | null,
  activeClasses: readonly string[] | null,
): IneligibleReason {
  if (me && me.role !== "user") return "staff";
  if (activeClasses !== null && activeClasses.length === 0) return "not_member";
  return "other";
}

export const INELIGIBLE_KEYS: Record<IneligibleReason, MessageKey> = {
  staff: "jury.ineligible.staff",
  not_member: "jury.ineligible.notMember",
  other: "jury.ineligible.other",
};

/** `data-*` value of a published count. */
export const countAttr = (c: JuryResultsDto["rows"][number]["agree"]): string =>
  c.suppressed ? "suppressed" : String(c.value);

/** The month before a `YYYY-MM` period. */
export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}
