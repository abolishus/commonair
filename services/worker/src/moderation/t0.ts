// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The T0 transaction (e4c spec "T0 live", "T0 upload", "T0 VOD/clip"): the only implementation of
 * the automatic actions for a hash-list match. One transaction: flag, case, legal hold, sealed
 * evidence, user ban, channel suspension, the broadcast ended, the subject's VODs and clips hidden,
 * audit, events and (CSAM list) the NCMEC draft. It is retried until it lands. Idempotent: a
 * second job for the same subject finds the case and adds nothing. After commit: the user-control
 * `disconnect`, the live `offline` message and the `t0-media` job that moves media to evidence.
 */
import { BUS, UserControlMessage } from "@commonair/contracts/events";
import {
  KEYS,
  MODERATION_JOBS,
  QUEUES,
  type LiveEvent,
  type ModerationT0Job,
  type ModerationT0MediaJob,
} from "@commonair/contracts/internal";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { MODERATION_CONSTANTS } from "@commonair/moderation";
import { and, eq, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import {
  alert,
  audit,
  emit,
  endedBroadcastForCase,
  endBroadcast,
  hideContent,
  safeErrorCode,
  type EndedBroadcast,
  type HiddenContent,
} from "./records.ts";
import { retryWithBackoff } from "./retry.ts";
import { moderationRuntime } from "./runtime.ts";
import { buildSnapshot, sealSnapshot } from "./snapshot.ts";

const {
  moderationCases: cases,
  moderationFlags: flags,
  legalHolds,
  evidenceObjects,
  ncmecReports,
  users,
  channels,
} = schema;

export const T0_REASON = "t0_hash_match";
/** Sealed inline evidence may be at most this long (the table's check constraint). */
export const INLINE_SEALED_MAX = 1_049_600;
const DEFAULT_RETRY = { attempts: 5, baseMs: 500, maxMs: 8_000 };

export interface T0Result {
  caseId: string;
  holdId: string;
  userId: string;
  channelId: string;
  created: boolean;
  broadcastId: string | null;
  ended: EndedBroadcast | null;
  hidden: HiddenContent;
  ncmecReportId: string | null;
}

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
/** BullMQ refuses a custom id with `:` unless it has exactly three parts; these ids use `-`. */
export const t0MediaJobId = (caseId: string) => `t0-media-${caseId}`;

/** Advisory lock per subject so two jobs for one subject never interleave. */
export const lockKey = (subjectType: string, subjectId: string) => `moderation:t0:${subjectType}:${subjectId}`;

/** Which broadcast a subject belongs to (its VODs, clips and thumbnails go to evidence). */
async function subjectBroadcast(tx: Executor, job: Pick<ModerationT0Job, "subjectType" | "subjectId">) {
  if (job.subjectType === "broadcast") return job.subjectId;
  if (job.subjectType === "vod") {
    const [v] = await tx
      .select({ b: schema.vods.broadcastId })
      .from(schema.vods)
      .where(eq(schema.vods.id, job.subjectId));
    return v?.b ?? null;
  }
  if (job.subjectType === "clip") {
    const [c] = await tx
      .select({ b: schema.clips.broadcastId })
      .from(schema.clips)
      .where(eq(schema.clips.id, job.subjectId));
    return c?.b ?? null;
  }
  return null;
}

/** Ban the user and suspend the channel with the T0 reason (the database then keeps them so). */
export async function suspendForT0(tx: Executor, userId: string, channelId: string | null, now: Date) {
  await tx.update(users).set({ banned: true, banReason: T0_REASON, banExpires: null }).where(eq(users.id, userId));
  if (channelId)
    await tx
      .update(channels)
      .set({
        suspendedAt: sql`coalesce(${channels.suspendedAt}, ${now.toISOString()}::timestamptz)`,
        suspendedReason: T0_REASON,
      })
      .where(eq(channels.id, channelId));
}

/** End what is live and hide what the subject covers: the whole broadcast for live, else the subject. */
export async function endAndHide(
  tx: Executor,
  subject: { subjectType: ModerationT0Job["subjectType"]; subjectId: string },
  channel: typeof channels.$inferSelect | undefined,
  now: Date,
): Promise<{ ended: EndedBroadcast | null; hidden: HiddenContent }> {
  let ended: EndedBroadcast | null = null;
  if (subject.subjectType === "broadcast") ended = await endBroadcast(tx, subject.subjectId, now);
  // Whatever the subject, a channel that is live right now goes off air with the suspension.
  if (!ended && channel?.liveBroadcastId) ended = await endBroadcast(tx, channel.liveBroadcastId, now);
  let hidden: HiddenContent = { vodIds: [], clipIds: [] };
  if (subject.subjectType === "broadcast")
    hidden = await hideContent(tx, { broadcastId: subject.subjectId }, T0_REASON);
  else if (subject.subjectType === "vod") hidden = await hideContent(tx, { vodIds: [subject.subjectId] }, T0_REASON);
  else if (subject.subjectType === "clip") hidden = await hideContent(tx, { clipIds: [subject.subjectId] }, T0_REASON);
  // Stored thumbnails stop being referenced at once; t0-media moves the objects to evidence.
  const thumbs = subject.subjectType === "broadcast" ? subject.subjectId : ended?.broadcastId;
  if (thumbs) await tx.update(schema.broadcasts).set({ thumbnailKey: null }).where(eq(schema.broadcasts.id, thumbs));
  return { ended, hidden };
}

/** One attempt at the T0 transaction. */
export async function applyT0Once(ctx: WorkerContext, job: ModerationT0Job): Promise<T0Result> {
  const rt = moderationRuntime(ctx);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey(job.subjectType, job.subjectId)}))`);
    const [channel] = await tx.select().from(channels).where(eq(channels.id, job.channelId)).for("update");
    if (!channel && !job.userId) throw new Error("T0 job: channel not found and no user given");
    const userId = job.userId ?? channel!.ownerId;
    const broadcastId = await subjectBroadcast(tx, job);

    const [existing] = await tx
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.subjectType, job.subjectType),
          eq(cases.subjectId, job.subjectId),
          eq(cases.tier, "t0"),
          eq(cases.origin, "hash_list"),
        ),
      )
      .limit(1);
    if (existing) {
      const [hold] = await tx
        .select({ id: legalHolds.id })
        .from(legalHolds)
        .where(eq(legalHolds.caseId, existing.id))
        .limit(1);
      if (!hold) throw new Error("T0 case without its hold");
      return {
        caseId: existing.id,
        holdId: hold.id,
        userId,
        channelId: job.channelId,
        created: false,
        broadcastId,
        ended: await endedBroadcastForCase(tx, existing.id),
        hidden: { vodIds: [], clipIds: [] },
        ncmecReportId: null,
      };
    }

    const caseId = uuidv7(now.getTime());
    const holdId = uuidv7(now.getTime());
    const flagId = uuidv7(now.getTime());
    const capturedAt = new Date(job.capturedAt);
    await tx.insert(cases).values({
      id: caseId,
      tier: "t0",
      status: "open",
      origin: "hash_list",
      subjectType: job.subjectType,
      subjectId: job.subjectId,
      channelId: job.channelId,
      userId,
      listCategory: job.listCategory,
      priority: MODERATION_CONSTANTS.URGENT_REPORT_PRIORITY,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(legalHolds).values({
      id: holdId,
      userId,
      reasonCode: job.listCategory === "csam" ? "csam_match" : "ncii_match",
      reason: "automatic T0 hash-list match",
      caseId,
      createdAt: now,
    });
    const evidenceIds: string[] = [];
    for (const e of job.evidence) {
      const sealed = b64(e.sealedBase64);
      if (sealed.length > INLINE_SEALED_MAX) throw new Error("T0 evidence object exceeds the inline limit");
      if (e.keyId !== rt.sealing.keyId) throw new Error("T0 evidence key does not match the worker evidence key");
      const id = uuidv7(now.getTime());
      evidenceIds.push(id);
      await tx.insert(evidenceObjects).values({
        id,
        holdId,
        caseId,
        kind: e.kind,
        storage: "inline",
        sealed: Buffer.from(sealed),
        sha256: e.sha256,
        sizeBytes: e.sizeBytes,
        contentType: e.contentType,
        keyId: e.keyId,
        pdq: e.pdq,
        pdqQuality: e.pdqQuality,
        sourceSubjectType: job.subjectType,
        sourceSubjectId: job.subjectId,
        capturedAt: new Date(e.capturedAt),
        createdAt: now,
      });
    }
    await tx.insert(flags).values({
      id: flagId,
      tier: "t0",
      origin: "hash_list",
      caseId,
      subjectType: job.subjectType,
      subjectId: job.subjectId,
      channelId: job.channelId,
      userId,
      listCategory: job.listCategory,
      distance: job.distance,
      quality: job.quality,
      provider: job.provider,
      providerVersion: job.listVersion,
      evidenceId: evidenceIds[0] ?? null,
      capturedAt,
      createdAt: now,
    });
    await suspendForT0(tx, userId, channel ? channel.id : null, now);
    const { ended, hidden } = await endAndHide(tx, job, channel, now);

    let ncmecReportId: string | null = null;
    if (job.listCategory === "csam") {
      ncmecReportId = uuidv7(now.getTime());
      const matched = job.evidence.find((e) => e.pdq !== null);
      const snapshot = await buildSnapshot(tx, {
        userId,
        incidentAt: capturedAt,
        incidentType: "csam_hash_match",
        subject: { type: job.subjectType, id: job.subjectId, channelId: job.channelId },
        match: {
          listCategory: job.listCategory,
          provider: job.provider,
          listVersion: job.listVersion,
          distance: job.distance,
          pdq: matched?.pdq ?? "",
        },
        evidenceIds,
      });
      await tx.insert(ncmecReports).values({
        id: ncmecReportId,
        caseId,
        holdId,
        userId,
        channelId: job.channelId,
        status: "draft",
        incidentAt: capturedAt,
        listCategory: job.listCategory,
        snapshotSealed: Buffer.from(await sealSnapshot(rt.sealing, snapshot)),
        keyId: rt.sealing.keyId,
        evidenceIds,
        createdAt: now,
      });
    }

    await audit(
      tx,
      {
        action: "moderation.t0.match",
        subjectType: "moderation_case",
        subjectId: caseId,
        channelId: job.channelId,
        reason: T0_REASON,
        details: {
          caseId,
          flagId,
          holdId,
          userId,
          subjectType: job.subjectType,
          subjectId: job.subjectId,
          tier: "t0",
          listCategory: job.listCategory,
          distance: job.distance,
          quality: job.quality,
          provider: job.provider,
          providerVersion: job.listVersion,
          evidenceIds,
          broadcastEnded: ended?.broadcastId ?? null,
          hiddenVods: hidden.vodIds,
          hiddenClips: hidden.clipIds,
          ncmecReportId,
          ...(job.uploadPurpose ? { uploadPurpose: job.uploadPurpose } : {}),
        },
      },
      now,
    );
    await emit(
      tx,
      "moderation.flagged",
      job.channelId,
      {
        case_id: caseId,
        flag_id: flagId,
        tier: "t0",
        origin: "hash_list",
        subject_type: job.subjectType,
        subject_id: job.subjectId,
        channel_id: job.channelId,
        category: null,
        list_category: job.listCategory,
        provider: job.provider,
        provider_version: job.listVersion,
      },
      now,
    );
    await emit(
      tx,
      "legal.hold.placed",
      null,
      {
        hold_id: holdId,
        user_id: userId,
        reason_code: job.listCategory === "csam" ? "csam_match" : "ncii_match",
        case_id: caseId,
      },
      now,
    );
    if (ncmecReportId)
      await emit(tx, "ncmec.draft.created", null, { report_id: ncmecReportId, case_id: caseId, hold_id: holdId }, now);
    return {
      caseId,
      holdId,
      userId,
      channelId: job.channelId,
      created: true,
      broadcastId,
      ended,
      hidden,
      ncmecReportId,
    };
  });
}

/** After commit: tell media/origin the broadcast ended and drop its live keys; failures retry the job. */
export async function publishLiveEnded(ctx: WorkerContext, e: EndedBroadcast, now: Date) {
  await ctx.valkey.del(KEYS.viewers(e.channelId), KEYS.viewerCount(e.channelId), KEYS.renditions(e.channelId));
  const live: LiveEvent = {
    type: "offline",
    channelId: e.channelId,
    broadcastId: e.broadcastId,
    slug: e.slug,
    path: e.path,
    at: now.toISOString(),
  };
  await ctx.valkey.publish(BUS.live, JSON.stringify(live));
}

/** After commit: failures propagate so the queue retries and republishes from persisted T0 state. */
export async function publishAfterT0(
  ctx: WorkerContext,
  r: { userId: string; ended: EndedBroadcast | null },
  now: Date,
) {
  const msg = UserControlMessage.parse({ op: "disconnect", userId: r.userId, reason: "suspended" });
  await ctx.valkey.publish(BUS.userControl, JSON.stringify(msg));
  if (r.ended) await publishLiveEnded(ctx, r.ended, now);
}

export async function enqueueT0Media(ctx: WorkerContext, data: ModerationT0MediaJob) {
  await ctx.enqueue(QUEUES.moderation, MODERATION_JOBS.t0Media, data, { jobId: t0MediaJobId(data.caseId) });
}

/** The job handler: the transaction with in-process retries, then the after-commit steps. */
export async function handleT0(ctx: WorkerContext, job: ModerationT0Job, meta: { attemptsMade: number }) {
  const rt = moderationRuntime(ctx);
  let r: T0Result;
  try {
    r = await retryWithBackoff(() => applyT0Once(ctx, job), {
      ...(rt.t0Retry ?? DEFAULT_RETRY),
      onRetry: (err, attempt, delayMs) =>
        ctx.logger.error("T0 transaction failed; retrying", {
          subjectType: job.subjectType,
          subjectId: job.subjectId,
          channelId: job.channelId,
          attempt,
          delayMs,
          errorCode: safeErrorCode(err),
        }),
    });
  } catch (err) {
    // The job is retried by BullMQ with backoff; every exhausted round is a fatal alert.
    alert(
      ctx,
      "t0_transaction_failed",
      "T0 transaction could not be applied; the job will be retried",
      {
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        channelId: job.channelId,
        listCategory: job.listCategory,
        jobAttempts: meta.attemptsMade + 1,
        errorCode: safeErrorCode(err),
      },
      "fatal",
    );
    throw err;
  }
  await publishAfterT0(ctx, r, ctx.now());
  await enqueueT0Media(ctx, {
    caseId: r.caseId,
    holdId: r.holdId,
    channelId: r.channelId,
    broadcastId: r.broadcastId,
  });
  if (r.created) {
    moderationMetrics.actions.add(1, { kind: "t0" });
    ctx.logger.warn("T0 hash match applied", {
      caseId: r.caseId,
      holdId: r.holdId,
      userId: r.userId,
      channelId: r.channelId,
      subjectType: job.subjectType,
      subjectId: job.subjectId,
      listCategory: job.listCategory,
      distance: job.distance,
      provider: job.provider,
      providerVersion: job.listVersion,
      evidenceCount: job.evidence.length,
      broadcastEnded: r.ended !== null,
      hiddenVods: r.hidden.vodIds.length,
      hiddenClips: r.hidden.clipIds.length,
      ncmecDraft: r.ncmecReportId !== null,
    });
  }
  return { caseId: r.caseId, holdId: r.holdId, created: r.created };
}
