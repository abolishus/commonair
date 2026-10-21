// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `moderation.t0-escalated`: a `legal` user confirmed a human-escalated case (e4c spec "T0
 * confirm"). The worker applies the full T0 actions: hold `csam_confirmed`, user banned and channel
 * suspended (the T0 reason, so the database keeps them), the broadcast ended and the subject's
 * media hidden, the case's review frames sealed into inline evidence (their PDQ hashes go into the
 * local block list), the NCMEC draft if the API has not created one, audit and events, then
 * `t0-media`. Idempotent: the audit row `moderation.t0.escalated` marks a case as applied.
 */
import type { ModerationT0EscalatedJob } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { decodeImage, MODERATION_CONSTANTS, pdqHash, plaintextSha256 } from "@commonair/moderation";
import { and, eq, isNotNull } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { readObject } from "./objects.ts";
import { audit, emit, endedBroadcastForCase, safeErrorCode } from "./records.ts";
import { mediaStorage, moderationRuntime } from "./runtime.ts";
import { buildSnapshot, sealSnapshot } from "./snapshot.ts";
import { endAndHide, enqueueT0Media, INLINE_SEALED_MAX, publishAfterT0, suspendForT0, T0_REASON } from "./t0.ts";

const { moderationCases: cases, moderationFlags: flags, legalHolds, evidenceObjects, ncmecReports, channels } = schema;
export const ESCALATED_AUDIT_ACTION = "moderation.t0.escalated";

interface Frame {
  flagId: string;
  sealed: Uint8Array;
  sha256: string;
  size: number;
  pdq: string | null;
  quality: number | null;
  capturedAt: Date;
}

/** Read, hash and seal the case's review frames (outside the transaction: object storage is slow). */
async function sealReviewFrames(ctx: WorkerContext, caseId: string): Promise<Frame[]> {
  const rt = moderationRuntime(ctx);
  const media = mediaStorage(ctx);
  const rows = await ctx.db
    .select({ id: flags.id, frameKey: flags.frameKey, capturedAt: flags.capturedAt })
    .from(flags)
    .where(and(eq(flags.caseId, caseId), isNotNull(flags.frameKey)));
  const out: Frame[] = [];
  for (const r of rows) {
    if (!r.frameKey) continue;
    const bytes = await readObject(media, ctx.mediaBucket, r.frameKey);
    if (!bytes) continue;
    let pdq: string | null = null;
    let quality: number | null = null;
    try {
      const d = await decodeImage(bytes, { ffmpegPath: rt.ffmpegPath });
      const h = pdqHash(d.luma, MODERATION_CONSTANTS.PDQ_LUMA_SIZE, MODERATION_CONSTANTS.PDQ_LUMA_SIZE);
      pdq = h.hash;
      quality = h.quality;
    } catch (err) {
      ctx.logger.warn("review frame could not be hashed; kept without PDQ", {
        caseId,
        flagId: r.id,
        errorCode: safeErrorCode(err),
      });
    }
    const sealed = await rt.sealing.seal(bytes);
    if (sealed.length > INLINE_SEALED_MAX) continue;
    out.push({
      flagId: r.id,
      sealed,
      sha256: await plaintextSha256(bytes),
      size: bytes.length,
      pdq,
      quality,
      capturedAt: r.capturedAt,
    });
  }
  return out;
}

export async function applyT0Escalated(ctx: WorkerContext, job: ModerationT0EscalatedJob) {
  const rt = moderationRuntime(ctx);
  const frames = await sealReviewFrames(ctx, job.caseId);
  const now = ctx.now();
  const r = await ctx.db.transaction(async (tx) => {
    const [c] = await tx.select().from(cases).where(eq(cases.id, job.caseId)).for("update");
    if (!c || c.tier !== "t0" || c.origin !== "human" || c.status !== "confirmed")
      return { applied: false as const, reason: "not_a_confirmed_escalation" };
    const [done] = await tx
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, ESCALATED_AUDIT_ACTION), eq(schema.auditLog.subjectId, c.id)))
      .limit(1);
    const [existingHold] = await tx.select().from(legalHolds).where(eq(legalHolds.caseId, c.id)).limit(1);
    if (done && existingHold)
      return {
        applied: false as const,
        reason: "already_applied",
        holdId: existingHold.id,
        userId: c.userId,
        ended: await endedBroadcastForCase(tx, c.id),
        caseRow: c,
      };
    const [channel] = c.channelId
      ? await tx.select().from(channels).where(eq(channels.id, c.channelId)).for("update")
      : [];
    const userId = c.userId ?? channel?.ownerId;
    if (!userId) throw new Error("escalated case has no subject user");

    let holdId = existingHold?.id;
    let holdCreated = false;
    if (!holdId) {
      holdId = uuidv7(now.getTime());
      holdCreated = true;
      await tx.insert(legalHolds).values({
        id: holdId,
        userId,
        reasonCode: "csam_confirmed",
        reason: "confirmed by legal review",
        caseId: c.id,
        createdById: job.confirmedById,
        createdAt: now,
      });
    }
    const evidenceIds: string[] = [];
    for (const f of frames) {
      const id = uuidv7(now.getTime());
      evidenceIds.push(id);
      await tx.insert(evidenceObjects).values({
        id,
        holdId,
        caseId: c.id,
        kind: "frame",
        storage: "inline",
        sealed: Buffer.from(f.sealed),
        sha256: f.sha256,
        sizeBytes: f.size,
        contentType: "image/jpeg",
        keyId: rt.sealing.keyId,
        pdq: f.pdq,
        pdqQuality: f.quality,
        sourceSubjectType: c.subjectType,
        sourceSubjectId: c.subjectId,
        capturedAt: f.capturedAt,
        createdAt: now,
      });
      if (f.pdq && (f.quality ?? 0) >= MODERATION_CONSTANTS.PDQ_MIN_QUALITY)
        await tx
          .insert(schema.localHashList)
          .values({
            id: uuidv7(now.getTime()),
            category: "csam",
            pdq: f.pdq,
            sourceType: "moderation_case",
            sourceId: c.id,
            addedById: job.confirmedById,
            createdAt: now,
          })
          .onConflictDoNothing();
    }
    const flagId = uuidv7(now.getTime());
    await tx.insert(flags).values({
      id: flagId,
      tier: "t0",
      origin: "human",
      caseId: c.id,
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      channelId: c.channelId,
      userId,
      provider: "human:legal",
      providerVersion: "t0-confirm-v1",
      evidenceId: evidenceIds[0] ?? null,
      capturedAt: now,
      createdAt: now,
    });
    await suspendForT0(tx, userId, channel?.id ?? null, now);
    const { ended, hidden } = await endAndHide(tx, c, channel, now);
    let ncmecReportId: string | null = null;
    const [draft] = await tx.select({ id: ncmecReports.id }).from(ncmecReports).where(eq(ncmecReports.caseId, c.id));
    if (!draft) {
      ncmecReportId = uuidv7(now.getTime());
      const allEvidence = (
        await tx.select({ id: evidenceObjects.id }).from(evidenceObjects).where(eq(evidenceObjects.caseId, c.id))
      ).map((e) => e.id);
      const snapshot = await buildSnapshot(tx, {
        userId,
        incidentAt: c.createdAt,
        incidentType: "csam_confirmed",
        subject: { type: c.subjectType, id: c.subjectId, channelId: c.channelId },
        match: null,
        evidenceIds: allEvidence,
      });
      const inserted = await tx
        .insert(ncmecReports)
        .values({
          id: ncmecReportId,
          caseId: c.id,
          holdId,
          userId,
          channelId: c.channelId,
          status: "draft",
          incidentAt: c.createdAt,
          listCategory: null,
          snapshotSealed: Buffer.from(await sealSnapshot(rt.sealing, snapshot)),
          keyId: rt.sealing.keyId,
          evidenceIds: allEvidence,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: ncmecReports.id });
      if (inserted.length === 0) ncmecReportId = null;
    }
    await audit(
      tx,
      {
        action: ESCALATED_AUDIT_ACTION,
        subjectType: "moderation_case",
        subjectId: c.id,
        channelId: c.channelId,
        reason: T0_REASON,
        details: {
          caseId: c.id,
          flagId,
          holdId,
          userId,
          confirmedById: job.confirmedById,
          subjectType: c.subjectType,
          subjectId: c.subjectId,
          tier: "t0",
          provider: "human:legal",
          providerVersion: "t0-confirm-v1",
          evidenceIds,
          broadcastEnded: ended?.broadcastId ?? null,
          hiddenVods: hidden.vodIds,
          hiddenClips: hidden.clipIds,
          ncmecReportId,
        },
      },
      now,
    );
    await emit(
      tx,
      "moderation.flagged",
      c.channelId,
      {
        case_id: c.id,
        flag_id: flagId,
        tier: "t0",
        origin: "human",
        subject_type: c.subjectType,
        subject_id: c.subjectId,
        channel_id: c.channelId,
        category: c.category,
        list_category: null,
        provider: "human:legal",
        provider_version: "t0-confirm-v1",
      },
      now,
    );
    if (holdCreated)
      await emit(
        tx,
        "legal.hold.placed",
        null,
        { hold_id: holdId, user_id: userId, reason_code: "csam_confirmed", case_id: c.id },
        now,
      );
    if (ncmecReportId)
      await emit(tx, "ncmec.draft.created", null, { report_id: ncmecReportId, case_id: c.id, hold_id: holdId }, now);
    return { applied: true as const, holdId, userId, ended, caseRow: c };
  });
  if (r.applied || r.reason === "already_applied") {
    if (r.applied) moderationMetrics.actions.add(1, { kind: "t0_escalated" });
    if (!r.userId) throw new Error("already-applied T0 case has no subject user");
    await publishAfterT0(ctx, { userId: r.userId, ended: r.ended }, now);
  }
  if ((r.applied || r.reason === "already_applied") && r.caseRow) {
    const c = r.caseRow;
    const broadcastId = c.subjectType === "broadcast" ? c.subjectId : null;
    if (r.holdId && c.channelId)
      await enqueueT0Media(ctx, { caseId: c.id, holdId: r.holdId, channelId: c.channelId, broadcastId });
  }
  ctx.logger.info("escalated T0 case processed", {
    caseId: job.caseId,
    applied: r.applied,
    ...(r.applied ? {} : { reason: r.reason }),
  });
  return { applied: r.applied };
}
