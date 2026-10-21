// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Row → DTO mapping for moderation cases, flags, history, evidence metadata, holds and NCMEC
 * drafts. Evidence metadata never carries a storage key or URL, and flags never carry a frame
 * location (`hasFrame` only; the frame comes through `moderation.frame`).
 */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { schema, type Executor } from "@commonair/db";
import { iso, isoOrNull } from "../lib/dto.ts";

const { moderationCases, moderationFlags, auditLog, users, channels, evidenceObjects, legalHolds, ncmecReports } =
  schema;
type CaseRow = typeof moderationCases.$inferSelect;
type FlagRow = typeof moderationFlags.$inferSelect;
type HoldRow = typeof legalHolds.$inferSelect;
type NcmecRow = typeof ncmecReports.$inferSelect;
type EvidenceRow = typeof evidenceObjects.$inferSelect;

export type ModerationCaseDto = z.infer<typeof dto.ModerationCase>;
export type LegalCaseDto = z.infer<typeof dto.LegalCase>;

/** Users and channels referenced by a set of cases, in two queries. */
export async function refsFor(db: Executor, cases: readonly CaseRow[]) {
  const userIds = [...new Set(cases.map((c) => c.userId).filter((x): x is string => x !== null))];
  const channelIds = [...new Set(cases.map((c) => c.channelId).filter((x): x is string => x !== null))];
  const [us, cs] = await Promise.all([
    userIds.length
      ? db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
      : [],
    channelIds.length
      ? db
          .select({ id: channels.id, slug: channels.slug, displayName: channels.displayName })
          .from(channels)
          .where(inArray(channels.id, channelIds))
      : [],
  ]);
  return { users: new Map(us.map((u) => [u.id, u])), channels: new Map(cs.map((c) => [c.id, c])) };
}

export function toCase(c: CaseRow, refs: Awaited<ReturnType<typeof refsFor>>): ModerationCaseDto {
  return {
    id: c.id,
    tier: c.tier,
    status: c.status,
    origin: c.origin,
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    channel: (c.channelId && refs.channels.get(c.channelId)) || null,
    user: (c.userId && refs.users.get(c.userId)) || null,
    category: c.category,
    priority: c.priority,
    slaDueAt: isoOrNull(c.slaDueAt),
    createdAt: iso(c.createdAt),
    resolvedAt: isoOrNull(c.resolvedAt),
    resolution: c.resolution,
    resolutionNote: c.resolutionNote,
  };
}

export const toFlag = (f: FlagRow) => ({
  id: f.id,
  tier: f.tier,
  origin: f.origin,
  category: f.category,
  score: f.score,
  listCategory: f.listCategory,
  distance: f.distance,
  provider: f.provider,
  providerVersion: f.providerVersion,
  // T0 flags never expose a frame, even if one were recorded.
  hasFrame: f.tier !== "t0" && f.frameKey !== null,
  capturedAt: iso(f.capturedAt),
});

export async function flagsOf(db: Executor, caseId: string) {
  return db
    .select()
    .from(moderationFlags)
    .where(eq(moderationFlags.caseId, caseId))
    .orderBy(asc(moderationFlags.createdAt));
}

/**
 * The case's audit trail: rows about the case itself, and rows whose ids-only details name it
 * (the worker's automated steps), oldest first.
 */
export async function historyOf(db: Executor, caseId: string) {
  const rows = await db
    .select({ a: auditLog, username: users.username })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(
      or(
        and(eq(auditLog.subjectType, "moderation_case"), eq(auditLog.subjectId, caseId)),
        sql`${auditLog.details}->>'caseId' = ${caseId}`,
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
    .limit(500);
  return rows.map(({ a, username }) => ({
    id: a.id,
    action: a.action,
    actorType: a.actorType,
    actor: a.actorId && username ? { id: a.actorId, username } : null,
    reason: a.reason,
    createdAt: iso(a.createdAt),
  }));
}

export const toEvidence = (e: EvidenceRow) => ({
  id: e.id,
  caseId: e.caseId,
  kind: e.kind,
  storage: e.storage,
  contentType: e.contentType,
  sizeBytes: e.sizeBytes,
  sha256: e.sha256,
  sourceSubjectType: e.sourceSubjectType,
  sourceSubjectId: e.sourceSubjectId,
  capturedAt: iso(e.capturedAt),
});

export const toHold = (h: HoldRow) => ({
  id: h.id,
  userId: h.userId,
  reasonCode: h.reasonCode,
  // Automatic holds carry a system reason code only; staff words for manual ones.
  reason: h.createdById ? h.reason : "",
  caseId: h.caseId,
  createdAt: iso(h.createdAt),
  filedAt: isoOrNull(h.filedAt),
  eligibleForReleaseAt: isoOrNull(h.eligibleForReleaseAt),
  releasedAt: isoOrNull(h.releasedAt),
});

export const toNcmec = (r: NcmecRow) => ({
  id: r.id,
  caseId: r.caseId,
  holdId: r.holdId,
  userId: r.userId,
  status: r.status,
  incidentAt: iso(r.incidentAt),
  listCategory: r.listCategory,
  target: r.target,
  evidenceIds: r.evidenceIds,
  externalReportId: r.externalReportId,
  filedAt: isoOrNull(r.filedAt),
  createdAt: iso(r.createdAt),
});

/** A T0 case with everything the legal view shows (metadata only, never evidence bytes). */
export async function toLegalCase(db: Executor, c: CaseRow): Promise<LegalCaseDto> {
  const [refs, flags, history, evidence, holds, reports] = await Promise.all([
    refsFor(db, [c]),
    flagsOf(db, c.id),
    historyOf(db, c.id),
    db.select().from(evidenceObjects).where(eq(evidenceObjects.caseId, c.id)).orderBy(asc(evidenceObjects.createdAt)),
    db.select().from(legalHolds).where(eq(legalHolds.caseId, c.id)).orderBy(asc(legalHolds.createdAt)).limit(1),
    db.select({ id: ncmecReports.id }).from(ncmecReports).where(eq(ncmecReports.caseId, c.id)).limit(1),
  ]);
  const firstReviewer = c.firstReviewerId
    ? ((
        await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, c.firstReviewerId))
      )[0] ?? null)
    : null;
  return {
    ...toCase(c, refs),
    list: c.origin === "human" ? "human" : (c.listCategory ?? "csam"),
    firstReviewer,
    firstReviewedAt: isoOrNull(c.firstReviewedAt),
    firstReviewNote: c.firstReviewNote,
    evidence: evidence.map(toEvidence),
    holdId: holds[0]?.id ?? null,
    ncmecReportId: reports[0]?.id ?? null,
    flags: flags.map(toFlag),
    history,
  };
}
