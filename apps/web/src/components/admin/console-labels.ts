// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Labels for the admin console (overhaul wave 4, D7.5): staff queues, the audit log's catalogued
 * actions (an unknown action shows its raw code) and its subject types. Admin consoles may use
 * their audience's terms (voice.md), but every label still goes through the catalog.
 */
import type { AdminQueue } from "@commonair/contracts/enums";
import { t, type MessageKey } from "../../i18n/index.ts";
import type { AdminPage } from "../safety/access.ts";

const QUEUE_LABEL: Record<AdminQueue, MessageKey> = {
  moderation: "d7Admin.queue.moderation",
  legal: "d7Admin.queue.legal",
  appeals: "d7Admin.queue.appeals",
  dmca: "d7Admin.queue.dmca",
  ncii: "d7Admin.queue.ncii",
  integrity: "d7Admin.queue.integrity",
  incidents: "d7Admin.queue.incidents",
  apps_review: "d7Admin.queue.apps_review",
  payments: "d7Admin.queue.payments",
};
export const queueLabel = (q: AdminQueue): string => t(QUEUE_LABEL[q]);

/** The page that works each queue (NCII requests are a tab of the mod queue). */
export const QUEUE_PAGE: Record<AdminQueue, AdminPage> = {
  moderation: "moderation",
  legal: "legal",
  appeals: "appeals",
  dmca: "dmca",
  ncii: "moderation",
  integrity: "integrity",
  incidents: "incidents",
  apps_review: "apps",
  payments: "treasury",
};

/** Whether the queue has a clock (an SLA, the NCII 48 hours, a counter-notice window, a payment's expiry). */
export const QUEUE_HAS_DEADLINE: Record<AdminQueue, boolean> = {
  moderation: true,
  legal: true,
  appeals: false,
  dmca: true,
  ncii: true,
  integrity: false,
  incidents: false,
  apps_review: false,
  payments: true,
};

const ACTION_LABEL: Record<string, MessageKey> = {
  "moderation.case.assign": "d7Admin.action.caseAssign",
  "moderation.case.release": "d7Admin.action.caseRelease",
  "moderation.case.clear": "d7Admin.action.caseClear",
  "moderation.case.warn": "d7Admin.action.caseWarn",
  "moderation.case.end_stream": "d7Admin.action.caseEndStream",
  "moderation.case.suspend": "d7Admin.action.caseSuspend",
  "moderation.case.escalate_legal": "d7Admin.action.caseEscalate",
  "moderation.case.report": "d7Admin.action.caseReport",
  "moderation.case.overturn": "d7Admin.action.caseOverturn",
  "moderation.t1.restrict": "d7Admin.action.t1Restrict",
  "moderation.t1.upload_reject": "d7Admin.action.t1UploadReject",
  "moderation.t2.label": "d7Admin.action.t2Label",
  "moderation.label.remove": "d7Admin.action.labelRemove",
  "moderation.frames.purge": "d7Admin.action.framesPurge",
  "moderation.t0.match": "d7Admin.action.t0Match",
  "moderation.t0.confirm": "d7Admin.action.t0Confirm",
  "moderation.t0.dismiss_first": "d7Admin.action.t0DismissFirst",
  "moderation.t0.dismiss": "d7Admin.action.t0Dismiss",
  "moderation.t0.media_preserved": "d7Admin.action.t0MediaPreserved",
  "report.resolve": "d7Admin.action.reportResolve",
  "appeal.resolve": "d7Admin.action.appealResolve",
  "user.suspend": "d7Admin.action.userSuspend",
  "user.unsuspend": "d7Admin.action.userUnsuspend",
  "user.ban_lapsed": "d7Admin.action.userBanLapsed",
  "user.set_role": "d7Admin.action.userSetRole",
  "user.email.reveal": "d7Admin.action.userEmailReveal",
  "channel.suspend": "d7Admin.action.channelSuspend",
  "channel.unsuspend": "d7Admin.action.channelUnsuspend",
  "legal.hold.place": "d7Admin.action.holdPlace",
  "legal.hold.eligible": "d7Admin.action.holdEligible",
  "evidence.view": "d7Admin.action.evidenceView",
  "evidence.audit": "d7Admin.action.evidenceAudit",
  "ncmec.view": "d7Admin.action.ncmecView",
  "ncmec.filed": "d7Admin.action.ncmecFiled",
  "ncii.received": "d7Admin.action.nciiReceived",
  "ncii.decide": "d7Admin.action.nciiDecide",
  "ncii.auto_hide": "d7Admin.action.nciiAutoHide",
  "dmca.notice.submit": "d7Admin.action.dmcaSubmit",
  "dmca.notice.action": "d7Admin.action.dmcaAction",
  "dmca.notice.reject": "d7Admin.action.dmcaReject",
  "dmca.counter.receive": "d7Admin.action.dmcaCounter",
  "dmca.counter.suit_filed": "d7Admin.action.dmcaSuit",
  "dmca.content.restore": "d7Admin.action.dmcaRestore",
  "account.deletion.request": "d7Admin.action.deletionRequest",
  "account.deletion.expedite": "d7Admin.action.deletionExpedite",
  "account.deletion.cancel": "d7Admin.action.deletionCancel",
  "account.deletion.complete": "d7Admin.action.deletionComplete",
  "integrity.flag.decide": "d7Admin.action.integrityDecide",
  "category.upsert": "d7Admin.action.categoryUpsert",
  "developer.app.suspend": "d7Admin.action.appSuspend",
  "developer.app.unsuspend": "d7Admin.action.appUnsuspend",
  "payment.confirm": "d7Admin.action.paymentConfirm",
  // Overhaul wave 5 (w5-deletion, ADR 0042).
  "subscription.renewal_stop": "w5Deletion.auditAction.renewalStop",
  "subscription.renewal_resume": "w5Deletion.auditAction.renewalResume",
  "coop.share.refund_details_requested": "w5Deletion.auditAction.refundDetailsRequested",
};
/** The catalogued label, or null when the action has none yet (the page then shows the code alone). */
export function auditActionLabel(action: string): string | null {
  const key = ACTION_LABEL[action];
  return key ? t(key) : null;
}
export const CATALOGUED_ACTIONS: readonly string[] = Object.keys(ACTION_LABEL);

/** Subject types the audit filter offers (the common staff ones; the id filter covers the rest). */
export const AUDIT_SUBJECT_TYPES = [
  "moderation_case",
  "report",
  "appeal",
  "user",
  "channel",
  "ncii_request",
  "dmca_notice",
  "ncmec_report",
  "payment",
  "oauth_app",
] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];
const SUBJECT_LABEL: Record<AuditSubjectType, MessageKey> = {
  moderation_case: "d7Admin.subject.moderation_case",
  report: "d7Admin.subject.report",
  appeal: "d7Admin.subject.appeal",
  user: "d7Admin.subject.user",
  channel: "d7Admin.subject.channel",
  ncii_request: "d7Admin.subject.ncii_request",
  dmca_notice: "d7Admin.subject.dmca_notice",
  ncmec_report: "d7Admin.subject.ncmec_report",
  payment: "d7Admin.subject.payment",
  oauth_app: "d7Admin.subject.oauth_app",
};
export const isAuditSubjectType = (v: string): v is AuditSubjectType =>
  (AUDIT_SUBJECT_TYPES as readonly string[]).includes(v);
export const subjectTypeLabel = (type: string): string => (isAuditSubjectType(type) ? t(SUBJECT_LABEL[type]) : type);

/** The first and last characters of an id, for compact display (the full id is in the link and CSV). */
export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);
