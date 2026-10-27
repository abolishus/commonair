// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Integrity, trust & safety, compliance, and the audit log. */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EnforcementFacts } from "@commonair/contracts/dto";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import {
  accountAction,
  accountActionReversal,
  actorType,
  appealKind,
  appealStatus,
  createdAt,
  deletionStatus,
  dmcaItemSubject,
  dmcaStatus,
  enforcementAutomatedDecision,
  enforcementContentType,
  enforcementDeliveryChannel,
  enforcementGround,
  enforcementRestrictionDetail,
  enforcementRestrictionKind,
  enforcementSource,
  exportKind,
  id,
  incidentStatus,
  integrityDecision,
  integritySubject,
  jobStatus,
  legalDocumentKind,
  legalHoldReason,
  modAction,
  modScope,
  reportReason,
  reportStatus,
  reportSubject,
  ts,
} from "./_shared.ts";

/** Every integrity signal that fired. Excluded traffic is flagged, never deleted. */
export const integrityFlags = pgTable(
  "integrity_flags",
  {
    id: id(),
    subjectType: integritySubject().notNull(),
    subjectId: uuid().notNull(),
    channelId: uuid().references(() => channels.id, { onDelete: "restrict" }),
    signal: text().notNull(),
    score: doublePrecision().notNull(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    decision: integrityDecision().notNull().default("pending_review"),
    decidedById: uuid(),
    decidedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index("integrity_flags_subject_idx").on(t.subjectType, t.subjectId),
    index("integrity_flags_channel_idx").on(t.channelId, t.createdAt),
    // The staff review list pages newest first (services/api/src/admin). NULLS FIRST is the
    // default for DESC, so `order by created_at desc, id desc` can use it (NULLS LAST would not).
    index("integrity_flags_created_idx").on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
  ],
);

/** Append-only (trigger-enforced) record of every moderation, integrity, admin and governance action. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorType: actorType().notNull(),
    actorId: uuid(),
    action: text().notNull(),
    subjectType: text().notNull(),
    subjectId: text().notNull(),
    channelId: uuid(),
    reason: text().notNull().default(""),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_subject_idx").on(t.subjectType, t.subjectId),
    index("audit_log_channel_idx").on(t.channelId, t.createdAt),
    index("audit_log_actor_idx").on(t.actorId, t.createdAt),
    // The statements-of-reasons builder and coverage sweep select by action (ADR 0019 decision 5).
    index("audit_log_action_idx").on(t.action, t.createdAt),
  ],
);

/**
 * Statements of reasons (ADR 0019 decisions 4 and 6, DSA Art. 17), built by the worker from the
 * `audit_log` row that applied the action. Append-only for every role (trigger), and ids, enums,
 * times and catalog codes only, so account deletion has nothing to rewrite. No foreign keys to
 * `users` or `channels`: deleting an account never reaches the record.
 */
export const enforcementStatements = pgTable(
  "enforcement_statements",
  {
    id: id(),
    sourceAuditId: uuid()
      .notNull()
      .references(() => auditLog.id, { onDelete: "restrict" }),
    /** The audit action, one of `ENFORCEMENT_SOURCE_ACTIONS`. */
    sourceAction: text().notNull(),
    recipientUserId: uuid().notNull(),
    channelId: uuid(),
    contentType: enforcementContentType().notNull(),
    contentId: uuid().notNull(),
    restrictionKind: enforcementRestrictionKind().notNull(),
    restrictionDetail: enforcementRestrictionDetail().notNull(),
    /** Null: indefinite, or not applicable. */
    restrictionEndsAt: ts(),
    /** No geo-scoped actions exist; the column records that it was considered. */
    territorialScope: text().notNull().default("all"),
    /** `EnforcementFacts` (validated by the shared Zod schema before insert). */
    facts: jsonb().$type<EnforcementFacts>().notNull(),
    source: enforcementSource().notNull(),
    automatedDetection: boolean().notNull(),
    automatedDecision: enforcementAutomatedDecision().notNull(),
    groundKind: enforcementGround().notNull(),
    clauseId: text().notNull(),
    clauseVersion: integer().notNull(),
    /** A catalog code; illegal grounds only. */
    legalBasis: text(),
    guidelinesDocumentId: uuid()
      .notNull()
      .references(() => legalDocuments.id, { onDelete: "restrict" }),
    noticeDocumentId: uuid()
      .notNull()
      .references(() => legalDocuments.id, { onDelete: "restrict" }),
    /** What to pass to `appeals.create` (kind `moderation`); both null when no internal appeal applies. */
    appealSubjectType: text(),
    appealSubjectId: uuid(),
    /** The audit row's time: when the restriction applied. */
    createdAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex("enforcement_statements_source_recipient_uq").on(t.sourceAuditId, t.recipientUserId),
    index("enforcement_statements_recipient_idx").on(t.recipientUserId, t.createdAt, t.id),
    check("enforcement_statements_territorial_scope_ck", sql`${t.territorialScope} = 'all'`),
    check("enforcement_statements_clause_version_ck", sql`${t.clauseVersion} >= 1`),
    check("enforcement_statements_legal_basis_ck", sql`${t.legalBasis} is null or ${t.groundKind} = 'illegal'`),
    check("enforcement_statements_appeal_ck", sql`(${t.appealSubjectType} is null) = (${t.appealSubjectId} is null)`),
    check(
      "enforcement_statements_facts_ck",
      sql`jsonb_typeof(${t.facts}) = 'object' and ${t.facts} ->> 'code' is not null`,
    ),
  ],
);

/** Delivery state of a statement per channel (mutable, unlike the statement). Codes only, never provider text. */
export const enforcementStatementDeliveries = pgTable(
  "enforcement_statement_deliveries",
  {
    id: id(),
    statementId: uuid()
      .notNull()
      .references(() => enforcementStatements.id, { onDelete: "restrict" }),
    channel: enforcementDeliveryChannel().notNull(),
    sentAt: ts(),
    attempts: integer().notNull().default(0),
    /** Why the last attempt failed or was skipped (`no_email`, `account_deleted`, `smtp_rejected`, …). */
    lastErrorCode: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("enforcement_statement_deliveries_uq").on(t.statementId, t.channel),
    // The builder retries unsent deliveries.
    index("enforcement_statement_deliveries_unsent_idx")
      .on(t.createdAt)
      .where(sql`${t.sentAt} is null`),
  ],
);

export const modActions = pgTable(
  "mod_actions",
  {
    id: id(),
    scope: modScope().notNull(),
    channelId: uuid().references(() => channels.id, { onDelete: "cascade" }),
    moderatorId: uuid().references(() => users.id, { onDelete: "set null" }),
    targetUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: modAction().notNull(),
    reason: text().notNull().default(""),
    durationSeconds: integer(),
    subjectType: text(),
    subjectId: uuid(),
    reportId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("mod_actions_channel_idx").on(t.channelId, t.createdAt),
    index("mod_actions_target_idx").on(t.targetUserId),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: id(),
    reporterId: uuid().references(() => users.id, { onDelete: "set null" }),
    subjectType: reportSubject().notNull(),
    subjectId: uuid().notNull(),
    channelId: uuid().references(() => channels.id, { onDelete: "cascade" }),
    reason: reportReason().notNull(),
    details: text().notNull().default(""),
    /** Evidence captured at report time (message text, thumbnail key), in case the subject is deleted. */
    evidence: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: reportStatus().notNull().default("open"),
    priority: integer().notNull().default(0),
    assigneeId: uuid(),
    resolution: text(),
    resolvedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("reports_queue_idx").on(t.status, t.priority, t.createdAt)],
);

export const appeals = pgTable(
  "appeals",
  {
    id: id(),
    appellantId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: appealKind().notNull(),
    /** The decision being appealed: an integrity flag, mod action, DMCA notice, or account action. */
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),
    body: text().notNull(),
    status: appealStatus().notNull().default("open"),
    resolverId: uuid(),
    resolution: text(),
    resolvedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index("appeals_queue_idx").on(t.status, t.createdAt),
    // Integrity allowance lookups: overturned appeals for a session, user or flag.
    index("appeals_subject_idx").on(t.subjectType, t.subjectId),
    uniqueIndex("appeals_open_uq")
      .on(t.appellantId, t.subjectType, t.subjectId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/** Platform decisions about an account outside `mod_actions` (DMCA strikes, repeat-infringer suspension). */
export const accountActions = pgTable(
  "account_actions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: accountAction().notNull(),
    sourceType: text(),
    sourceId: uuid(),
    actorType: actorType().notNull(),
    actorId: uuid(),
    createdAt: createdAt(),
    reversedAt: ts(),
    reversedById: uuid(),
    reversedReason: accountActionReversal(),
    reversalAppealId: uuid(),
  },
  (t) => [
    index("account_actions_user_idx").on(t.userId, t.createdAt),
    index("account_actions_source_idx").on(t.sourceType, t.sourceId),
    index("account_actions_active_idx")
      .on(t.userId, t.action)
      .where(sql`${t.reversedAt} is null`),
    // At most one live termination per user, so reversing "the" termination lifts it for good.
    uniqueIndex("account_actions_active_termination_uq")
      .on(t.userId)
      .where(sql`${t.action} = 'dmca_termination' and ${t.reversedAt} is null`),
    check("account_actions_reversal_ck", sql`(${t.reversedAt} is null) = (${t.reversedReason} is null)`),
  ],
);

export const dmcaNotices = pgTable(
  "dmca_notices",
  {
    id: id(),
    claimantName: text().notNull(),
    claimantEmail: text().notNull(),
    claimantAddress: text().notNull(),
    claimantPhone: text(),
    copyrightedWork: text().notNull(),
    infringingUrls: text().array().notNull(),
    goodFaithStatement: boolean().notNull(),
    accuracyStatement: boolean().notNull(),
    signature: text().notNull(),
    status: dmcaStatus().notNull().default("received"),
    handledById: uuid(),
    /** The moderator's `action` note (mutable row only, never copied into audit or events). */
    decisionNote: text(),
    createdAt: createdAt(),
    actionedAt: ts(),
  },
  (t) => [index("dmca_notices_status_idx").on(t.status, t.createdAt)],
);

export const dmcaCounterNotices = pgTable(
  "dmca_counter_notices",
  {
    id: id(),
    noticeId: uuid()
      .notNull()
      .references(() => dmcaNotices.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text().notNull(),
    address: text().notNull(),
    phone: text().notNull(),
    /** The `dmca_notice_items` this counter-notice covers (§ 512(g)(3)(B)). */
    itemIds: uuid().array().notNull(),
    statement: text().notNull(),
    goodFaithStatement: boolean().notNull(),
    consentToJurisdiction: boolean().notNull(),
    signature: text().notNull(),
    /** Content is restored after this date (10–14 business days) unless the claimant files suit. */
    restoreAfter: ts().notNull(),
    restoredAt: ts(),
    /** The claimant filed suit (§ 512(g)(2)(C)): the content stays down. */
    suitFiledAt: ts(),
    suitRecordedById: uuid(),
    suitNote: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("dmca_counter_notices_notice_user_uq").on(t.noticeId, t.userId),
    // The dmca-restore job's due scan.
    index("dmca_counter_notices_due_idx")
      .on(t.restoreAfter)
      .where(sql`${t.restoredAt} is null and ${t.suitFiledAt} is null`),
  ],
);

/** One infringing URL of a notice and what it resolved to; removal and restore are set once each. */
export const dmcaNoticeItems = pgTable(
  "dmca_notice_items",
  {
    id: id(),
    noticeId: uuid()
      .notNull()
      .references(() => dmcaNotices.id, { onDelete: "restrict" }),
    url: text().notNull(),
    subjectType: dmcaItemSubject(),
    subjectId: uuid(),
    /** The channel owner (the uploader for the purposes of § 512(g)). */
    ownerId: uuid().references(() => users.id, { onDelete: "restrict" }),
    channelId: uuid().references(() => channels.id, { onDelete: "restrict" }),
    removedAt: ts(),
    /** Objects moved to the private DMCA prefix (worker `dmca-disable`). */
    objectsHiddenAt: ts(),
    restoredAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index("dmca_notice_items_notice_idx").on(t.noticeId),
    index("dmca_notice_items_owner_idx").on(t.ownerId, t.createdAt),
    index("dmca_notice_items_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: id(),
    kind: legalDocumentKind().notNull(),
    version: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    /** Drafts pending lawyer review are clearly labeled in the UI. */
    isDraft: boolean().notNull().default(true),
    requiresAcceptance: boolean().notNull().default(true),
    publishedAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex("legal_documents_version_uq").on(t.kind, t.version)],
);

export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid()
      .notNull()
      .references(() => legalDocuments.id, { onDelete: "restrict" }),
    acceptedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.documentId] })],
);

export const consentRecords = pgTable(
  "consent_records",
  {
    id: id(),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    /** Random id stored in a first-party cookie for signed-out visitors. */
    anonymousId: text(),
    choices: jsonb().$type<Record<string, boolean>>().notNull(),
    policyVersion: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("consent_records_user_idx").on(t.userId),
    index("consent_records_anon_idx").on(t.anonymousId),
    // The legal consent-retention job deletes old anonymous rows in batches; without this every run scans the table.
    index("consent_records_anon_created_idx")
      .on(t.createdAt)
      .where(sql`${t.userId} is null`),
  ],
);

export const dataExports = pgTable(
  "data_exports",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: exportKind().notNull(),
    status: jobStatus().notNull().default("queued"),
    storageKey: text(),
    sizeBytes: integer(),
    error: text(),
    expiresAt: ts(),
    createdAt: createdAt(),
    completedAt: ts(),
  },
  (t) => [
    index("data_exports_user_idx").on(t.userId, t.createdAt),
    // The cleanup job finds ready exports past their expiry (ADR 0021: 7 days).
    index("data_exports_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'ready'`),
  ],
);

export const accountDeletions = pgTable(
  "account_deletions",
  {
    id: id(),
    userId: uuid().notNull(),
    status: deletionStatus().notNull().default("scheduled"),
    requestedAt: ts().notNull().defaultNow(),
    /** Grace period end; the user may cancel before this. */
    scheduledFor: ts().notNull(),
    completedAt: ts(),
    /** Stable pseudonym substituted into retained records (ledger, audit). */
    pseudonym: text(),
    /** What was retained and why (ledger records, legal holds), for the user's receipt. */
    retained: jsonb().$type<{ table: string; reason: string; rows: number }[]>().notNull().default([]),
    /**
     * Objects still to delete after completion (E6): media prefixes/keys and export archive keys,
     * ids only. Written in the completion transaction and cleared once they are gone, so a failed
     * or hold-deferred cleanup is retried by the deletion job (media waits while a hold is active).
     */
    pendingObjects: jsonb().$type<{ mediaPrefixes: string[]; mediaKeys: string[]; exportKeys: string[] }>(),
  },
  (t) => [
    index("account_deletions_due_idx").on(t.status, t.scheduledFor),
    index("account_deletions_pending_idx")
      .on(t.completedAt)
      .where(sql`${t.pendingObjects} is not null`),
  ],
);

/**
 * Legal holds (ADR 0006 decision 6). Rows are never deleted, and only the database owner can
 * release one (`bun run --filter @commonair/db hold -- release`); triggers in
 * `0015_trust_safety_protections.sql` enforce both for every other role. A hold keeps its
 * evidence, flags, cases and NCMEC drafts through account deletion. `userId` has no foreign key
 * on purpose: deleting or pseudonymizing the user must never reach the hold.
 */
export const legalHolds = pgTable(
  "legal_holds",
  {
    id: id(),
    userId: uuid().notNull(),
    reasonCode: legalHoldReason().notNull().default("law_enforcement"),
    /** Staff's own words for manual holds; never personal data of the subject. */
    reason: text().notNull(),
    caseId: uuid(),
    createdById: uuid(),
    createdAt: createdAt(),
    /** When the NCMEC report (if any) was filed: the one-year preservation clock starts here. */
    filedAt: ts(),
    /** Set by the worker one year after `filedAt`; release still needs the owner CLI. */
    eligibleForReleaseAt: ts(),
    releasedAt: ts(),
    releaseReason: text(),
  },
  (t) => [
    index("legal_holds_user_idx").on(t.userId),
    index("legal_holds_case_idx").on(t.caseId),
    index("legal_holds_active_idx")
      .on(t.createdAt)
      .where(sql`${t.releasedAt} is null`),
  ],
);

export const incidents = pgTable("incidents", {
  id: id(),
  title: text().notNull(),
  status: incidentStatus().notNull().default("investigating"),
  components: text().array().notNull(),
  body: text().notNull().default(""),
  startedAt: ts().notNull().defaultNow(),
  resolvedAt: ts(),
});
