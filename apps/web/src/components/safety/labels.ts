// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code-to-message maps for the trust & safety pages. Typed as `MessageKey`, so a missing catalog
 * entry fails the type check (the i18n test allows dynamic `t()` in this file only for that reason).
 */
import type {
  ACCOUNT_ACTION_REVERSALS,
  ACCOUNT_ACTIONS,
  APPEAL_KINDS,
  APPEAL_STATUSES,
  APPEAL_SUBJECTS,
  EVIDENCE_KINDS,
  LEGAL_HOLD_REASONS,
  MODERATION_CASE_STATUSES,
  MODERATION_CATEGORIES,
  MODERATION_REVIEW_DECISIONS,
  NCII_STATUSES,
  NCMEC_REPORT_STATUSES,
  REPORT_REASONS,
} from "@commonair/contracts/enums";
import type { StatusTone } from "@commonair/ui";
import { t, type MessageKey } from "../../i18n/index.ts";

type Of<T extends readonly string[]> = T[number];

const REPORT_REASON_KEYS: Record<Of<typeof REPORT_REASONS>, MessageKey> = {
  spam: "safety.reason.spam",
  harassment: "safety.reason.harassment",
  hate: "safety.reason.hate",
  sexual_content: "safety.reason.sexual_content",
  minor_safety: "safety.reason.minor_safety",
  violence: "safety.reason.violence",
  self_harm: "safety.reason.self_harm",
  illegal: "safety.reason.illegal",
  impersonation: "safety.reason.impersonation",
  copyright: "safety.reason.copyright",
  unlabeled_mature: "safety.reason.unlabeled_mature",
  ncii: "safety.reason.ncii",
  other: "safety.reason.other",
};
export const reportReasonLabel = (reason: Of<typeof REPORT_REASONS>): string => t(REPORT_REASON_KEYS[reason]);

const CATEGORY_KEYS: Record<Of<typeof MODERATION_CATEGORIES>, MessageKey> = {
  sexual: "safety.category.sexual",
  graphic_violence: "safety.category.graphic_violence",
  weapons: "safety.category.weapons",
  self_harm: "safety.category.self_harm",
};
export const categoryLabel = (category: Of<typeof MODERATION_CATEGORIES>): string => t(CATEGORY_KEYS[category]);

const DECISION_KEYS: Record<Of<typeof MODERATION_REVIEW_DECISIONS>, MessageKey> = {
  clear: "safety.decision.clear",
  warn: "safety.decision.warn",
  end_stream: "safety.decision.end_stream",
  suspend: "safety.decision.suspend",
  escalate_legal: "safety.decision.escalate_legal",
};
export const decisionLabel = (d: Of<typeof MODERATION_REVIEW_DECISIONS>): string => t(DECISION_KEYS[d]);

const CASE_STATUS: Record<Of<typeof MODERATION_CASE_STATUSES>, { key: MessageKey; tone: StatusTone }> = {
  open: { key: "safety.caseStatus.open", tone: "warning" },
  labelled: { key: "safety.caseStatus.labelled", tone: "info" },
  cleared: { key: "safety.caseStatus.cleared", tone: "success" },
  actioned: { key: "safety.caseStatus.actioned", tone: "neutral" },
  dismissal_pending: { key: "safety.caseStatus.dismissal_pending", tone: "warning" },
  dismissed: { key: "safety.caseStatus.dismissed", tone: "neutral" },
  confirmed: { key: "safety.caseStatus.confirmed", tone: "danger" },
};
export function caseStatusBadge(status: Of<typeof MODERATION_CASE_STATUSES>): { label: string; tone: StatusTone } {
  const entry = CASE_STATUS[status];
  return { label: t(entry.key), tone: entry.tone };
}

const APPEAL_STATUS: Record<Of<typeof APPEAL_STATUSES>, { key: MessageKey; tone: StatusTone }> = {
  open: { key: "safety.appealStatus.open", tone: "warning" },
  upheld: { key: "safety.appealStatus.upheld", tone: "neutral" },
  overturned: { key: "safety.appealStatus.overturned", tone: "success" },
};
export function appealStatusBadge(status: Of<typeof APPEAL_STATUSES>): { label: string; tone: StatusTone } {
  const entry = APPEAL_STATUS[status];
  return { label: t(entry.key), tone: entry.tone };
}

const NCII_STATUS: Record<Of<typeof NCII_STATUSES>, { key: MessageKey; tone: StatusTone }> = {
  received: { key: "safety.nciiStatus.received", tone: "warning" },
  removed: { key: "safety.nciiStatus.removed", tone: "success" },
  rejected: { key: "safety.nciiStatus.rejected", tone: "neutral" },
  auto_hidden: { key: "safety.nciiStatus.auto_hidden", tone: "danger" },
};
export function nciiStatusBadge(status: Of<typeof NCII_STATUSES>): { label: string; tone: StatusTone } {
  const entry = NCII_STATUS[status];
  return { label: t(entry.key), tone: entry.tone };
}

const HOLD_REASON_KEYS: Record<Of<typeof LEGAL_HOLD_REASONS>, MessageKey> = {
  csam_match: "safety.holdReason.csam_match",
  ncii_match: "safety.holdReason.ncii_match",
  csam_confirmed: "safety.holdReason.csam_confirmed",
  law_enforcement: "safety.holdReason.law_enforcement",
  litigation: "safety.holdReason.litigation",
};
export const holdReasonLabel = (r: Of<typeof LEGAL_HOLD_REASONS>): string => t(HOLD_REASON_KEYS[r]);

const EVIDENCE_KIND_KEYS: Record<Of<typeof EVIDENCE_KINDS>, MessageKey> = {
  frame: "safety.evidenceKind.frame",
  upload: "safety.evidenceKind.upload",
  vod_object: "safety.evidenceKind.vod_object",
  clip_object: "safety.evidenceKind.clip_object",
  thumbnail: "safety.evidenceKind.thumbnail",
};
export const evidenceKindLabel = (k: Of<typeof EVIDENCE_KINDS>): string => t(EVIDENCE_KIND_KEYS[k]);

const NCMEC_STATUS: Record<Of<typeof NCMEC_REPORT_STATUSES>, { key: MessageKey; tone: StatusTone }> = {
  draft: { key: "safety.ncmecStatus.draft", tone: "warning" },
  filed: { key: "safety.ncmecStatus.filed", tone: "success" },
  withdrawn: { key: "safety.ncmecStatus.withdrawn", tone: "neutral" },
};
export function ncmecStatusBadge(status: Of<typeof NCMEC_REPORT_STATUSES>): { label: string; tone: StatusTone } {
  const entry = NCMEC_STATUS[status];
  return { label: t(entry.key), tone: entry.tone };
}

// ── Appeals (E7) ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_ACTION_KEYS: Record<Of<typeof ACCOUNT_ACTIONS>, MessageKey> = {
  dmca_strike: "appeals.account.action.dmca_strike",
  dmca_termination: "appeals.account.action.dmca_termination",
};
export const accountActionLabel = (a: Of<typeof ACCOUNT_ACTIONS>): string => t(ACCOUNT_ACTION_KEYS[a]);

const REVERSAL_KEYS: Record<Of<typeof ACCOUNT_ACTION_REVERSALS>, MessageKey> = {
  appeal_overturned: "appeals.account.reversal.appeal_overturned",
  counter_notice_restored: "appeals.account.reversal.counter_notice_restored",
  strikes_below_threshold: "appeals.account.reversal.strikes_below_threshold",
};
export const reversalLabel = (r: Of<typeof ACCOUNT_ACTION_REVERSALS>): string => t(REVERSAL_KEYS[r]);

const APPEAL_KIND_KEYS: Record<Of<typeof APPEAL_KINDS>, MessageKey> = {
  integrity: "appeals.account.kind.integrity",
  moderation: "appeals.account.kind.moderation",
  dmca: "appeals.account.kind.dmca",
  account: "appeals.account.kind.account",
};
export const appealKindLabel = (k: Of<typeof APPEAL_KINDS>): string => t(APPEAL_KIND_KEYS[k]);

const APPEAL_SUBJECT_KEYS: Record<Of<typeof APPEAL_SUBJECTS>, MessageKey> = {
  session: "appeals.account.subject.session",
  user: "appeals.account.subject.user",
  integrity_flag: "appeals.account.subject.integrity_flag",
  moderation_action: "safety.appeals.otherSubject",
  dmca_notice: "appeals.account.subject.dmca_notice",
  account_action: "appeals.account.subject.account_action",
  content_label: "safety.appeals.labelSubject",
  moderation_case: "safety.appeals.otherSubject",
  // W0-sor may give NCII removals their own label with the statements list.
  ncii_request_item: "safety.appeals.otherSubject",
};
/** What an appeal is about; `subjectType` is a plain string on the wire. */
export function appealSubjectLabel(subjectType: string): string {
  const key = (APPEAL_SUBJECT_KEYS as Partial<Record<string, MessageKey>>)[subjectType];
  return t(key ?? "safety.appeals.otherSubject");
}

export type OverturnEffect =
  | "liftsBan"
  | "liftsSuspension"
  | "recordsOnly"
  | "moderationAction"
  | "reversesStrike"
  | "reversesTermination"
  | "accountAction";
const EFFECT_KEYS: Record<OverturnEffect, MessageKey> = {
  liftsBan: "appeals.account.effect.liftsBan",
  liftsSuspension: "appeals.account.effect.liftsSuspension",
  recordsOnly: "appeals.account.effect.recordsOnly",
  moderationAction: "appeals.account.effect.moderationAction",
  reversesStrike: "appeals.account.effect.reversesStrike",
  reversesTermination: "appeals.account.effect.reversesTermination",
  accountAction: "appeals.account.effect.accountAction",
};

/**
 * What overturning an appeal will do (the API's rules in `services/api/src/routes/appeals.ts`),
 * for `moderation_action` and `account_action` subjects; `null` for the others. `action` is the
 * mod or account action when known; without it the general rule for the subject is shown.
 */
export function overturnEffect(subjectType: string, action?: string | null): OverturnEffect | null {
  if (subjectType === "moderation_action") {
    if (!action) return "moderationAction";
    if (action === "ban" || action === "timeout") return "liftsBan";
    if (action === "suspend_user" || action === "suspend_channel") return "liftsSuspension";
    return "recordsOnly";
  }
  if (subjectType === "account_action") {
    if (action === "dmca_strike") return "reversesStrike";
    if (action === "dmca_termination") return "reversesTermination";
    return "accountAction";
  }
  return null;
}
export const overturnEffectLabel = (e: OverturnEffect): string => t(EFFECT_KEYS[e]);
