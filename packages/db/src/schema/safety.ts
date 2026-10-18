// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Integrity, trust & safety, compliance, and the audit log. */
import { sql } from "drizzle-orm";
import {
  boolean,
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
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import {
  actorType,
  appealKind,
  appealStatus,
  createdAt,
  deletionStatus,
  dmcaStatus,
  exportKind,
  id,
  incidentStatus,
  integrityDecision,
  integritySubject,
  jobStatus,
  legalDocumentKind,
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

export const dmcaNotices = pgTable(
  "dmca_notices",
  {
    id: id(),
    claimantName: text().notNull(),
    claimantEmail: text().notNull(),
    claimantAddress: text().notNull(),
    copyrightedWork: text().notNull(),
    infringingUrls: text().array().notNull(),
    subjectType: text(),
    subjectId: uuid(),
    goodFaithStatement: boolean().notNull(),
    accuracyStatement: boolean().notNull(),
    signature: text().notNull(),
    status: dmcaStatus().notNull().default("received"),
    handledById: uuid(),
    createdAt: createdAt(),
    actionedAt: ts(),
  },
  (t) => [index("dmca_notices_status_idx").on(t.status, t.createdAt)],
);

export const dmcaCounterNotices = pgTable("dmca_counter_notices", {
  id: id(),
  noticeId: uuid()
    .notNull()
    .references(() => dmcaNotices.id, { onDelete: "cascade" }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text().notNull(),
  address: text().notNull(),
  statement: text().notNull(),
  consentToJurisdiction: boolean().notNull(),
  signature: text().notNull(),
  /** Content is restored after this date (10–14 business days) unless the claimant files suit. */
  restoreAfter: ts().notNull(),
  restoredAt: ts(),
  createdAt: createdAt(),
});

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
  (t) => [index("consent_records_user_idx").on(t.userId), index("consent_records_anon_idx").on(t.anonymousId)],
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
  (t) => [index("data_exports_user_idx").on(t.userId, t.createdAt)],
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
  },
  (t) => [index("account_deletions_due_idx").on(t.status, t.scheduledFor)],
);

export const legalHolds = pgTable("legal_holds", {
  id: id(),
  userId: uuid().notNull(),
  reason: text().notNull(),
  createdById: uuid(),
  createdAt: createdAt(),
  releasedAt: ts(),
});

export const incidents = pgTable("incidents", {
  id: id(),
  title: text().notNull(),
  status: incidentStatus().notNull().default("investigating"),
  components: text().array().notNull(),
  body: text().notNull().default(""),
  startedAt: ts().notNull().defaultNow(),
  resolvedAt: ts(),
});
