// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Automated moderation, evidence and takedowns (ADR 0006, docs/testing/e4c-selectors.md).
 * User and channel references here carry no foreign keys on purpose: account deletion and
 * channel removal must never cascade into held evidence. Triggers in
 * `0015_trust_safety_protections.sql` make flags and evidence append-only, protect NCMEC drafts,
 * enforce the two-reviewer T0 dismissal, the 48-hour NCII deadline and the mature-label lock.
 */
import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { channels } from "./channels.ts";
import { legalHolds } from "./safety.ts";
import {
  bytea,
  contentLabel,
  createdAt,
  evidenceKind,
  evidenceStorage,
  hashListCategory,
  id,
  moderationCaseOrigin,
  moderationCaseStatus,
  moderationCategory,
  moderationSubject,
  moderationTier,
  ncmecReportStatus,
  nciiRelationship,
  nciiStatus,
  ts,
  updatedAt,
} from "./_shared.ts";

/**
 * A queue item: one per subject and tier while it is undecided. T0 cases are visible only to
 * the `legal` role.
 */
export const moderationCases = pgTable(
  "moderation_cases",
  {
    id: id(),
    tier: moderationTier().notNull(),
    status: moderationCaseStatus().notNull().default("open"),
    origin: moderationCaseOrigin().notNull(),
    subjectType: moderationSubject().notNull(),
    subjectId: uuid().notNull(),
    channelId: uuid(),
    userId: uuid(),
    category: moderationCategory(),
    listCategory: hashListCategory(),
    priority: integer().notNull().default(0),
    /** T1: when a moderator should have decided (response SLA). */
    slaDueAt: ts(),
    /** T0 dismissal: the first of two `legal` reviewers. */
    firstReviewerId: uuid(),
    firstReviewedAt: ts(),
    firstReviewNote: text(),
    resolvedById: uuid(),
    resolvedAt: ts(),
    /** The decision code (`MODERATION_REVIEW_DECISIONS`, `confirmed`, `dismissed`, `overturned`). */
    resolution: text(),
    resolutionNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("moderation_cases_queue_idx").on(t.tier, t.status, t.priority, t.createdAt),
    index("moderation_cases_user_idx").on(t.userId),
    index("moderation_cases_subject_idx").on(t.subjectType, t.subjectId),
    uniqueIndex("moderation_cases_open_uq")
      .on(t.subjectType, t.subjectId, t.tier)
      .where(sql`${t.status} in ('open', 'labelled', 'dismissal_pending')`),
  ],
);

/** Every signal that crossed a threshold (T3 frames are never stored). Append-only. */
export const moderationFlags = pgTable(
  "moderation_flags",
  {
    id: id(),
    tier: moderationTier().notNull(),
    origin: moderationCaseOrigin().notNull(),
    caseId: uuid().notNull(),
    subjectType: moderationSubject().notNull(),
    subjectId: uuid().notNull(),
    channelId: uuid(),
    userId: uuid(),
    /** Classifier signals. */
    category: moderationCategory(),
    score: doublePrecision(),
    /** Hash-list signals. */
    listCategory: hashListCategory(),
    distance: integer(),
    quality: integer(),
    /** e.g. `pdq:operator-list`, `pdq:local`, `onnx:adamcodd-vit-nsfw`, `scripted`. */
    provider: text().notNull(),
    /** List version (sha256 of the file + entry count) or model revision that fired. */
    providerVersion: text().notNull(),
    evidenceId: uuid(),
    /** T1/T2 review frame in the media bucket (`moderation/<caseId>/<flagId>.jpg`), never public. */
    frameKey: text(),
    capturedAt: ts().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("moderation_flags_case_idx").on(t.caseId, t.createdAt),
    index("moderation_flags_subject_idx").on(t.subjectType, t.subjectId),
    check(
      "moderation_flags_signal",
      sql`(${t.origin} = 'human') or (${t.origin} = 'hash_list' and ${t.tier} = 't0' and ${t.listCategory} is not null and ${t.distance} is not null) or (${t.origin} = 'classifier' and ${t.tier} in ('t1', 't2') and ${t.category} is not null and ${t.score} is not null)`,
    ),
  ],
);

/** Moderation-applied labels. While one is active the channel cannot unset `mature` (trigger). */
export const contentLabels = pgTable(
  "content_labels",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    label: contentLabel().notNull(),
    caseId: uuid().notNull(),
    appliedAt: ts().notNull().defaultNow(),
    removedAt: ts(),
    removedById: uuid(),
    /** `appeal_overturned` or `moderator`. */
    removedReason: text(),
  },
  (t) => [
    uniqueIndex("content_labels_active_uq")
      .on(t.channelId, t.label)
      .where(sql`${t.removedAt} is null`),
  ],
);

/**
 * Sealed evidence (ADR 0006 Q4). Append-only for every role. `inline` objects (≤ 1 MiB) are the
 * sealed bytes themselves; `bucket` objects live in the evidence bucket and this row is their
 * manifest. `sha256` is of the plaintext, for the daily audit.
 */
export const evidenceObjects = pgTable(
  "evidence_objects",
  {
    id: id(),
    holdId: uuid()
      .notNull()
      .references(() => legalHolds.id, { onDelete: "restrict" }),
    caseId: uuid().notNull(),
    kind: evidenceKind().notNull(),
    storage: evidenceStorage().notNull(),
    sealed: bytea(),
    storageKey: text(),
    sha256: text().notNull(),
    sizeBytes: integer().notNull(),
    contentType: text().notNull(),
    /** Fingerprint of the evidence public key the object is sealed to. */
    keyId: text().notNull(),
    /** PDQ of the plaintext image (hex) and its quality, for the local block list on confirm. */
    pdq: text(),
    pdqQuality: integer(),
    sourceSubjectType: moderationSubject().notNull(),
    sourceSubjectId: uuid().notNull(),
    capturedAt: ts().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidence_objects_case_idx").on(t.caseId),
    index("evidence_objects_hold_idx").on(t.holdId),
    check(
      "evidence_objects_storage",
      sql`(${t.storage} = 'inline' and ${t.sealed} is not null and ${t.storageKey} is null and octet_length(${t.sealed}) <= 1049600) or (${t.storage} = 'bucket' and ${t.storageKey} is not null and ${t.sealed} is null)`,
    ),
    check("evidence_objects_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** One run of the daily evidence audit. */
export const evidenceAuditRuns = pgTable("evidence_audit_runs", {
  id: id(),
  startedAt: ts().notNull().defaultNow(),
  finishedAt: ts(),
  checked: integer().notNull().default(0),
  missing: uuid()
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  mismatched: uuid()
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  incidentId: uuid(),
});

/**
 * NCMEC CyberTipline report drafts (ADR 0006 Q3). The platform drafts, a `legal` user files.
 * `snapshotSealed` holds the account and session data the report needs, sealed to the evidence
 * key: the one deliberate exception to "no personal data in retained rows", because the legal
 * duty to report and preserve outranks deletion. Never deleted; the snapshot is immutable.
 */
export const ncmecReports = pgTable(
  "ncmec_reports",
  {
    id: id(),
    caseId: uuid().notNull(),
    holdId: uuid()
      .notNull()
      .references(() => legalHolds.id, { onDelete: "restrict" }),
    userId: uuid(),
    channelId: uuid(),
    status: ncmecReportStatus().notNull().default("draft"),
    incidentAt: ts().notNull(),
    listCategory: hashListCategory(),
    snapshotSealed: bytea().notNull(),
    keyId: text().notNull(),
    evidenceIds: uuid().array().notNull(),
    /** `ncmec`, or the operator's national body. */
    target: text().notNull().default("ncmec"),
    externalReportId: text(),
    filedAt: ts(),
    filedById: uuid(),
    withdrawnAt: ts(),
    withdrawnById: uuid(),
    withdrawnReason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ncmec_reports_case_uq").on(t.caseId),
    index("ncmec_reports_status_idx").on(t.status, t.createdAt),
  ],
);

/** Hashes of content staff removed as CSAM or NCII; always loaded next to the operator lists. */
export const localHashList = pgTable(
  "local_hash_list",
  {
    id: id(),
    category: hashListCategory().notNull(),
    /** PDQ, 64 hex characters. */
    pdq: text().notNull(),
    /** `moderation_case` or `ncii_request`. */
    sourceType: text().notNull(),
    sourceId: uuid().notNull(),
    addedById: uuid(),
    createdAt: createdAt(),
    revokedAt: ts(),
    revokedById: uuid(),
  },
  (t) => [
    uniqueIndex("local_hash_list_active_uq")
      .on(t.category, t.pdq)
      .where(sql`${t.revokedAt} is null`),
    check("local_hash_list_pdq", sql`${t.pdq} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Public NCII takedown requests (TAKE IT DOWN Act). `receivedAt` and `deadlineAt` are set by
 * the database (receivedAt + 48 hours) and immutable.
 */
export const nciiRequests = pgTable(
  "ncii_requests",
  {
    id: id(),
    status: nciiStatus().notNull().default("received"),
    requesterName: text().notNull(),
    requesterEmail: text().notNull(),
    relationship: nciiRelationship().notNull(),
    contentUrls: text().array().notNull(),
    description: text().notNull(),
    goodFaith: boolean().notNull(),
    signature: text().notNull(),
    receivedAt: ts().notNull().defaultNow(),
    deadlineAt: ts().notNull(),
    escalated24At: ts(),
    escalated36At: ts(),
    autoHiddenAt: ts(),
    decidedAt: ts(),
    decidedById: uuid(),
    decisionNote: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ncii_requests_open_idx")
      .on(t.deadlineAt)
      .where(sql`${t.decidedAt} is null`),
    check("ncii_requests_good_faith", sql`${t.goodFaith}`),
  ],
);

/** The content a request names, resolved to subjects where the URL is on this instance. */
export const nciiRequestItems = pgTable(
  "ncii_request_items",
  {
    id: id(),
    requestId: uuid()
      .notNull()
      .references(() => nciiRequests.id, { onDelete: "cascade" }),
    url: text().notNull(),
    subjectType: moderationSubject(),
    subjectId: uuid(),
    /** For uploads: the media key the URL resolved to. */
    uploadKey: text(),
    hiddenAt: ts(),
    /** Set when staff decide `removed` (the API unpublishes in that transaction). */
    removedAt: ts(),
    /** Set by the worker's `ncii-hash` job once the content is hashed and its objects deleted. */
    hashedAt: ts(),
  },
  (t) => [
    index("ncii_request_items_request_idx").on(t.requestId),
    index("ncii_request_items_subject_idx").on(t.subjectType, t.subjectId),
  ],
);
