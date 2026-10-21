// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recurring trust & safety housekeeping: unfiled NCMEC drafts (alert at 24 h, incident at 72 h,
 * once each), hold release eligibility (one year after filing; release itself needs the owner
 * CLI), review-frame retention (30 days after a case closed) and the incoming upload prefix (24 h).
 * "Once" markers are audit rows, so they survive restarts and are visible in the case history.
 */
import { schema, uuidv7 } from "@commonair/db";
import { MODERATION_JOBS, QUEUES, type ModerationT0MediaJob } from "@commonair/contracts/internal";
import { INCOMING_PREFIX, MODERATION_CONSTANTS } from "@commonair/moderation";
import { and, eq, gt, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { alert, audit } from "./records.ts";
import { mediaStorage } from "./runtime.ts";
import { T0_MEDIA_COMPLETE_AUDIT_ACTION } from "./t0-media.ts";

const { ncmecReports, legalHolds, auditLog, moderationCases: cases, moderationFlags: flags, incidents } = schema;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const t0MediaReconcileJobId = (caseId: string, scheduledAt: number) =>
  `t0-media:${caseId}:reconcile:${scheduledAt}`;

const markerMissing = (action: string, subjectId: ReturnType<typeof sql>) =>
  notExists(
    sql`(select 1 from ${auditLog} where ${auditLog.action} = ${action} and ${auditLog.subjectId} = ${subjectId})`,
  );

export async function ncmecUnfiled(ctx: WorkerContext) {
  const now = ctx.now();
  const alertBefore = new Date(now.getTime() - MODERATION_CONSTANTS.NCMEC_UNFILED_ALERT_HOURS * HOUR);
  const incidentBefore = new Date(now.getTime() - MODERATION_CONSTANTS.NCMEC_UNFILED_INCIDENT_HOURS * HOUR);
  const idText = sql`${ncmecReports.id}::text`;
  const toAlert = await ctx.db
    .select({ id: ncmecReports.id, caseId: ncmecReports.caseId, createdAt: ncmecReports.createdAt })
    .from(ncmecReports)
    .where(
      and(
        eq(ncmecReports.status, "draft"),
        lt(ncmecReports.createdAt, alertBefore),
        markerMissing("ncmec.unfiled_alert", idText),
      ),
    );
  for (const r of toAlert) {
    await audit(
      ctx.db,
      {
        action: "ncmec.unfiled_alert",
        subjectType: "ncmec_report",
        subjectId: r.id,
        details: { reportId: r.id, caseId: r.caseId, hours: MODERATION_CONSTANTS.NCMEC_UNFILED_ALERT_HOURS },
      },
      now,
    );
    alert(ctx, "ncmec_unfiled_24h", "an NCMEC draft has not been filed within 24 hours", {
      reportId: r.id,
      caseId: r.caseId,
    });
  }
  const toIncident = await ctx.db
    .select({ id: ncmecReports.id, caseId: ncmecReports.caseId })
    .from(ncmecReports)
    .where(
      and(
        eq(ncmecReports.status, "draft"),
        lt(ncmecReports.createdAt, incidentBefore),
        markerMissing("ncmec.unfiled_incident", idText),
      ),
    );
  for (const r of toIncident) {
    const incidentId = uuidv7(now.getTime());
    await ctx.db.transaction(async (tx) => {
      await tx.insert(incidents).values({
        id: incidentId,
        title: "Legal report overdue",
        status: "investigating",
        components: ["trust-safety"],
        body: `A required report draft (${r.id}) has not been filed within ${MODERATION_CONSTANTS.NCMEC_UNFILED_INCIDENT_HOURS} hours.`,
        startedAt: now,
      });
      await audit(
        tx,
        {
          action: "ncmec.unfiled_incident",
          subjectType: "ncmec_report",
          subjectId: r.id,
          details: { reportId: r.id, caseId: r.caseId, incidentId },
        },
        now,
      );
    });
    alert(
      ctx,
      "ncmec_unfiled_72h",
      "an NCMEC draft has not been filed within 72 hours",
      { reportId: r.id, caseId: r.caseId, incidentId },
      "fatal",
    );
  }
  return { alerted: toAlert.length, incidents: toIncident.length };
}

/** Requeue T0 media cases that have not yet completed a clean preservation sweep. */
export async function reconcileT0Media(ctx: WorkerContext, batch = 200) {
  let cursor: string | undefined;
  let selected = 0;
  let enqueued = 0;
  while (true) {
    const due = await ctx.db
      .select({
        caseId: cases.id,
        holdId: legalHolds.id,
        channelId: cases.channelId,
        subjectType: cases.subjectType,
        subjectId: cases.subjectId,
      })
      .from(cases)
      .innerJoin(legalHolds, eq(legalHolds.caseId, cases.id))
      .where(
        and(
          eq(cases.tier, "t0"),
          markerMissing(T0_MEDIA_COMPLETE_AUDIT_ACTION, sql`${cases.id}::text`),
          ...(cursor ? [gt(cases.id, cursor)] : []),
        ),
      )
      .orderBy(cases.id)
      .limit(batch);
    if (due.length === 0) break;
    selected += due.length;
    for (const c of due) {
      const [flag] = c.channelId
        ? []
        : await ctx.db.select({ channelId: flags.channelId }).from(flags).where(eq(flags.caseId, c.caseId)).limit(1);
      const channelId = c.channelId ?? flag?.channelId;
      if (!channelId) {
        ctx.logger.error("T0 media reconciliation has no channel reference", { caseId: c.caseId });
        throw new Error("T0 media reconciliation missing channel");
      }
      const job: ModerationT0MediaJob = {
        caseId: c.caseId,
        holdId: c.holdId,
        channelId,
        broadcastId: c.subjectType === "broadcast" ? c.subjectId : null,
      };
      // A fresh timestamp id escapes any exhausted finite-attempt job while deduping this run.
      await ctx.enqueue(QUEUES.moderation, MODERATION_JOBS.t0Media, job, {
        jobId: t0MediaReconcileJobId(c.caseId, ctx.now().getTime()),
      });
      enqueued++;
    }
    // `due` is nonempty here; its final id is the next keyset cursor.
    cursor = due[due.length - 1]?.caseId;
    if (!cursor) throw new Error("T0 media reconciliation page is missing its last case id");
  }
  return { selected, enqueued };
}

/** Holds whose report was filed at least a year ago become eligible for release (never released here). */
export async function holdEligibility(ctx: WorkerContext) {
  const now = ctx.now();
  // The trigger requires ≥ filed_at + 1 year; 365 days is shorter across a leap day, so take the later.
  const eligibleAt = sql`greatest(${legalHolds.filedAt} + interval '1 year', ${legalHolds.filedAt} + make_interval(days => ${MODERATION_CONSTANTS.HOLD_PRESERVATION_DAYS}))`;
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(legalHolds)
      .set({ eligibleForReleaseAt: sql`${eligibleAt}` })
      .where(
        and(
          isNotNull(legalHolds.filedAt),
          isNull(legalHolds.eligibleForReleaseAt),
          isNull(legalHolds.releasedAt),
          sql`${eligibleAt} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: legalHolds.id, caseId: legalHolds.caseId, at: legalHolds.eligibleForReleaseAt });
    for (const h of rows)
      await audit(
        tx,
        {
          action: "legal.hold.eligible",
          subjectType: "legal_hold",
          subjectId: h.id,
          details: { holdId: h.id, caseId: h.caseId, eligibleForReleaseAt: h.at?.toISOString() ?? null },
        },
        now,
      );
    return { eligible: rows.length };
  });
}

/**
 * Review frames (`moderation/<caseId>/<flagId>.jpg`) are deleted 30 days after their case closed.
 * T1/T2 cases close as cleared or actioned; escalated (T0) cases only once confirmed (their frames
 * are already sealed into evidence) or dismissed.
 */
export async function frameRetention(ctx: WorkerContext, batch = 200) {
  const storage = mediaStorage(ctx);
  const now = ctx.now();
  const before = new Date(now.getTime() - MODERATION_CONSTANTS.REVIEW_FRAME_RETENTION_DAYS * DAY);
  const due = await ctx.db
    .select({ id: cases.id, tier: cases.tier, status: cases.status })
    .from(cases)
    .where(
      and(
        isNotNull(cases.resolvedAt),
        lt(cases.resolvedAt, before),
        sql`((${cases.tier} in ('t1', 't2') and ${cases.status} in ('cleared', 'actioned'))
            or (${cases.tier} = 't0' and ${cases.origin} = 'human' and ${cases.status} in ('confirmed', 'dismissed')))`,
        markerMissing("moderation.frames.purge", sql`${cases.id}::text`),
        sql`exists (select 1 from ${flags} where ${flags.caseId} = ${cases.id} and ${flags.frameKey} is not null)`,
      ),
    )
    .limit(batch);
  let objects = 0;
  for (const c of due) {
    if (c.tier === "t0" && c.status === "confirmed") {
      // Never delete a frame of a confirmed case before its sealed copy exists.
      const [copy] = await ctx.db
        .select({ id: schema.evidenceObjects.id })
        .from(schema.evidenceObjects)
        .where(and(eq(schema.evidenceObjects.caseId, c.id), eq(schema.evidenceObjects.kind, "frame")))
        .limit(1);
      if (!copy) continue;
    }
    const keys = await ctx.db
      .select({ key: flags.frameKey })
      .from(flags)
      .where(and(eq(flags.caseId, c.id), isNotNull(flags.frameKey)));
    for (const k of keys)
      if (k.key) {
        await storage.delete(ctx.mediaBucket, k.key);
        objects++;
      }
    await audit(
      ctx.db,
      {
        action: "moderation.frames.purge",
        subjectType: "moderation_case",
        subjectId: c.id,
        details: { caseId: c.id, frames: keys.length, retentionDays: MODERATION_CONSTANTS.REVIEW_FRAME_RETENTION_DAYS },
      },
      now,
    );
  }
  return { cases: due.length, objects };
}

/** Unflagged objects under the incoming prefix are never served; delete them after 24 h. */
export async function incomingCleanup(ctx: WorkerContext) {
  const storage = mediaStorage(ctx);
  const before = ctx.now().getTime() - MODERATION_CONSTANTS.INCOMING_UPLOAD_TTL_HOURS * HOUR;
  let deleted = 0;
  const stale: string[] = [];
  for await (const o of storage.list(ctx.mediaBucket, INCOMING_PREFIX))
    if (o.lastModified.getTime() < before) stale.push(o.key);
  for (const key of stale) {
    await storage.delete(ctx.mediaBucket, key);
    deleted++;
  }
  if (deleted > 0) ctx.logger.info("incoming uploads expired", { deleted });
  return { deleted };
}
