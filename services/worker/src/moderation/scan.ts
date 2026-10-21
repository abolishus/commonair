// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `moderation.scan`: classify one sampled live frame and act on T1/T2 (ADR 0006, e4c spec
 * "Classification", "T1 live", "T2 live"). T3 frames leave nothing but counters. A classifier
 * score never suspends or bans anyone: T1 blurs, delists and queues; T2 labels mature.
 */
import { KEYS, type ModerationScanJob, type ModerationScores } from "@commonair/contracts/internal";
import { schema, uuidv7, type Executor } from "@commonair/db";
import {
  encodeImage,
  MODERATION_CONSTANTS,
  reviewFrameKey,
  tierFor,
  type Classifier,
  type TierDecision,
} from "@commonair/moderation";
import { and, eq, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { audit, emit } from "./records.ts";
import { mediaStorage, moderationRuntime } from "./runtime.ts";
import { loadThresholds } from "./settings.ts";

const { moderationCases: cases, moderationFlags: flags, broadcasts, channels, contentLabels, categories } = schema;
const RGB_BYTES = MODERATION_CONSTANTS.CLASSIFIER_INPUT_SIZE ** 2 * 3;
const MINUTE = 60_000;

export type ScanOutcome =
  | { tier: "expired" | "invalid" | "t3" | "gone" }
  | { tier: "t1"; caseId: string; flagId: string; newCase: boolean }
  | { tier: "t2"; caseId: string; flagId: string; labelled: boolean };

/** Record per-category score histograms and the tier counter. Unscored categories are absent. */
export function recordScores(scores: ModerationScores, tier: string) {
  for (const [category, score] of Object.entries(scores))
    if (typeof score === "number") moderationMetrics.scores.record(score, { category });
  moderationMetrics.frames.add(1, { tier });
}

/** T3 when no tier fired; otherwise the decision. Kept separate so the glue is unit-testable. */
export const tierLabel = (d: TierDecision) => d.tier ?? "t3";

export async function classifyFrame(classifier: Classifier, rgb: Uint8Array, channelId: string) {
  const started = performance.now();
  const scores = await classifier.classify({ rgb, channelId });
  moderationMetrics.classifyDuration.record(performance.now() - started);
  return scores;
}

export async function scanFrame(ctx: WorkerContext, job: ModerationScanJob): Promise<ScanOutcome> {
  const rt = moderationRuntime(ctx);
  const key = KEYS.moderationFrame(job.frameId);
  const frame = await ctx.valkey.getBuffer(key);
  if (!frame) {
    moderationMetrics.framesExpired.add(1);
    return { tier: "expired" };
  }
  // Read once, then gone: an unflagged frame is never kept anywhere.
  await ctx.valkey.del(key).catch(() => {});
  const rgb = new Uint8Array(frame);
  if (rgb.length !== RGB_BYTES) {
    moderationMetrics.frames.add(1, { tier: "invalid" });
    ctx.logger.warn("moderation frame has the wrong size; skipped", { frameId: job.frameId, bytes: rgb.length });
    return { tier: "invalid" };
  }
  const [row] = await ctx.db
    .select({ channel: channels, broadcastId: broadcasts.id })
    .from(broadcasts)
    .innerJoin(channels, eq(channels.id, broadcasts.channelId))
    .where(and(eq(broadcasts.id, job.broadcastId), eq(broadcasts.channelId, job.channelId)));
  if (!row) return { tier: "gone" };

  const thresholds = await loadThresholds(ctx, ctx.db);
  const scores = await classifyFrame(rt.classifier, rgb, job.channelId);
  const decision = tierFor(scores, thresholds, { mature: row.channel.mature });
  recordScores(scores, tierLabel(decision));
  if (decision.tier === null) return { tier: "t3" };
  if (decision.tier === "t2" && row.channel.mature) return { tier: "t3" };

  const provider = { provider: rt.classifier.provider, providerVersion: rt.classifier.providerVersion };
  const storage = mediaStorage(ctx);
  const flagId = uuidv7();
  // The review frame is written first (under the case that is open now, or a new id) so the flag
  // never points at a frame that does not exist; a rolled-back transaction deletes it again.
  const candidateCaseId = (await openCase(ctx.db, decision.tier, job.broadcastId))?.id ?? uuidv7();
  const frameKey = reviewFrameKey(candidateCaseId, flagId);
  const jpeg = await encodeImage(
    rgb,
    {
      width: MODERATION_CONSTANTS.CLASSIFIER_INPUT_SIZE,
      height: MODERATION_CONSTANTS.CLASSIFIER_INPUT_SIZE,
      format: "rgb",
    },
    "jpeg",
    { ffmpegPath: rt.ffmpegPath },
  );
  await storage.put(ctx.mediaBucket, frameKey, Buffer.from(jpeg), { contentType: "image/jpeg" });
  try {
    const capturedAt = new Date(job.capturedAt);
    const input = { job, channel: row.channel, flagId, frameKey, candidateCaseId, capturedAt, ...provider };
    const out =
      decision.tier === "t1"
        ? await applyT1(ctx, { ...input, category: decision.category, score: decision.score })
        : await applyT2(ctx, { ...input, score: decision.score });
    if (out.tier === "t2" && !out.labelled) await storage.delete(ctx.mediaBucket, frameKey).catch(() => {});
    if (out.tier === "t1" || (out.tier === "t2" && out.labelled))
      ctx.logger.info("moderation flag recorded", {
        tier: out.tier,
        caseId: out.caseId,
        flagId,
        channelId: job.channelId,
        broadcastId: job.broadcastId,
        category: decision.category,
        score: decision.score,
        ...provider,
      });
    return out;
  } catch (err) {
    await storage.delete(ctx.mediaBucket, frameKey).catch(() => {});
    throw err;
  }
}

async function openCase(db: Executor, tier: "t1" | "t2", broadcastId: string) {
  const [c] = await db
    .select({ id: cases.id, status: cases.status })
    .from(cases)
    .where(
      and(
        eq(cases.subjectType, "broadcast"),
        eq(cases.subjectId, broadcastId),
        eq(cases.tier, tier),
        sql`${cases.status} in ('open', 'labelled')`,
      ),
    )
    .limit(1);
  return c;
}

interface ApplyInput {
  job: ModerationScanJob;
  channel: typeof channels.$inferSelect;
  flagId: string;
  frameKey: string;
  candidateCaseId: string;
  capturedAt: Date;
  provider: string;
  providerVersion: string;
}

const lockSubject = (tx: Executor, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

/** T1: flag, case (or the broadcast's open case), restriction, audit and events in one transaction. */
export async function applyT1(
  ctx: WorkerContext,
  i: ApplyInput & { category: NonNullable<typeof cases.$inferSelect.category>; score: number },
): Promise<Extract<ScanOutcome, { tier: "t1" }>> {
  const now = ctx.now();
  const out = await ctx.db.transaction(async (tx) => {
    await lockSubject(tx, `moderation:t1:${i.job.broadcastId}`);
    const existing = await openCase(tx, "t1", i.job.broadcastId);
    const caseId = existing?.id ?? i.candidateCaseId;
    if (!existing)
      await tx.insert(cases).values({
        id: caseId,
        tier: "t1",
        status: "open",
        origin: "classifier",
        subjectType: "broadcast",
        subjectId: i.job.broadcastId,
        channelId: i.channel.id,
        userId: i.channel.ownerId,
        category: i.category,
        priority: MODERATION_CONSTANTS.T1_PRIORITY,
        slaDueAt: new Date(now.getTime() + MODERATION_CONSTANTS.T1_SLA_MINUTES * MINUTE),
        createdAt: now,
        updatedAt: now,
      });
    await tx.insert(flags).values({
      id: i.flagId,
      tier: "t1",
      origin: "classifier",
      caseId,
      subjectType: "broadcast",
      subjectId: i.job.broadcastId,
      channelId: i.channel.id,
      userId: i.channel.ownerId,
      category: i.category,
      score: i.score,
      quality: i.job.quality,
      provider: i.provider,
      providerVersion: i.providerVersion,
      frameKey: i.frameKey,
      capturedAt: i.capturedAt,
      createdAt: now,
    });
    const restricted = await tx
      .update(broadcasts)
      .set({ restrictedAt: now, restrictedCaseId: caseId })
      .where(
        and(
          eq(broadcasts.id, i.job.broadcastId),
          sql`(${broadcasts.restrictedCaseId} is distinct from ${caseId}::uuid or ${broadcasts.restrictedAt} is null)`,
        ),
      )
      .returning({ id: broadcasts.id });
    const newRestriction = restricted.length > 0;
    await audit(
      tx,
      {
        action: existing ? "moderation.t1.flag" : "moderation.t1.restrict",
        subjectType: "moderation_case",
        subjectId: caseId,
        channelId: i.channel.id,
        reason: "classifier_t1",
        details: {
          caseId,
          flagId: i.flagId,
          broadcastId: i.job.broadcastId,
          frameId: i.job.frameId,
          tier: "t1",
          category: i.category,
          score: i.score,
          provider: i.provider,
          providerVersion: i.providerVersion,
          restricted: newRestriction,
        },
      },
      now,
    );
    await emit(
      tx,
      "moderation.flagged",
      i.channel.id,
      {
        case_id: caseId,
        flag_id: i.flagId,
        tier: "t1",
        origin: "classifier",
        subject_type: "broadcast",
        subject_id: i.job.broadcastId,
        channel_id: i.channel.id,
        category: i.category,
        list_category: null,
        provider: i.provider,
        provider_version: i.providerVersion,
      },
      now,
    );
    if (newRestriction)
      await emit(
        tx,
        "moderation.restriction",
        i.channel.id,
        { broadcast_id: i.job.broadcastId, channel_id: i.channel.id, case_id: caseId, restricted: true },
        now,
      );
    return { caseId, newCase: !existing };
  });
  moderationMetrics.actions.add(1, { kind: out.newCase ? "t1_restrict" : "t1_flag" });
  return { tier: "t1", caseId: out.caseId, flagId: i.flagId, newCase: out.newCase };
}

/** T2: flag, label, `channels.mature`, labelled case, owner notification, audit and events. */
export async function applyT2(
  ctx: WorkerContext,
  i: ApplyInput & { score: number },
): Promise<Extract<ScanOutcome, { tier: "t2" }>> {
  const now = ctx.now();
  const out = await ctx.db.transaction(async (tx) => {
    await lockSubject(tx, `moderation:t2:${i.channel.id}`);
    const [channel] = await tx.select().from(channels).where(eq(channels.id, i.channel.id)).for("update");
    if (!channel || channel.mature) return { caseId: "", labelled: false };
    const existing = await openCase(tx, "t2", i.job.broadcastId);
    const caseId = existing?.id ?? i.candidateCaseId;
    if (!existing)
      await tx.insert(cases).values({
        id: caseId,
        tier: "t2",
        status: "labelled",
        origin: "classifier",
        subjectType: "broadcast",
        subjectId: i.job.broadcastId,
        channelId: channel.id,
        userId: channel.ownerId,
        category: "sexual",
        priority: 0,
        createdAt: now,
        updatedAt: now,
      });
    await tx.insert(flags).values({
      id: i.flagId,
      tier: "t2",
      origin: "classifier",
      caseId,
      subjectType: "broadcast",
      subjectId: i.job.broadcastId,
      channelId: channel.id,
      userId: channel.ownerId,
      category: "sexual",
      score: i.score,
      quality: i.job.quality,
      provider: i.provider,
      providerVersion: i.providerVersion,
      frameKey: i.frameKey,
      capturedAt: i.capturedAt,
      createdAt: now,
    });
    const labelId = uuidv7(now.getTime());
    await tx
      .insert(contentLabels)
      .values({ id: labelId, channelId: channel.id, label: "mature", caseId, appliedAt: now });
    await tx.update(channels).set({ mature: true }).where(eq(channels.id, channel.id));
    await tx.insert(schema.notifications).values({
      id: uuidv7(now.getTime()),
      userId: channel.ownerId,
      type: "moderation",
      payload: { kind: "mature_label_applied", caseId, labelId, channelId: channel.id, label: "mature" },
      createdAt: now,
    });
    await audit(
      tx,
      {
        action: "moderation.t2.label",
        subjectType: "moderation_case",
        subjectId: caseId,
        channelId: channel.id,
        reason: "classifier_t2",
        details: {
          caseId,
          flagId: i.flagId,
          labelId,
          broadcastId: i.job.broadcastId,
          frameId: i.job.frameId,
          tier: "t2",
          category: "sexual",
          score: i.score,
          provider: i.provider,
          providerVersion: i.providerVersion,
        },
      },
      now,
    );
    const [category] = channel.categoryId
      ? await tx
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(eq(categories.id, channel.categoryId))
      : [];
    await emit(
      tx,
      "channel.update",
      channel.id,
      {
        broadcaster_user_id: channel.ownerId,
        broadcaster_user_login: channel.slug,
        broadcaster_user_name: channel.displayName,
        title: channel.title,
        language: channel.language,
        category_id: category?.id ?? null,
        category_name: category?.name ?? null,
        tags: channel.tags,
        mature: true,
      },
      now,
    );
    await emit(
      tx,
      "moderation.flagged",
      channel.id,
      {
        case_id: caseId,
        flag_id: i.flagId,
        tier: "t2",
        origin: "classifier",
        subject_type: "broadcast",
        subject_id: i.job.broadcastId,
        channel_id: channel.id,
        category: "sexual",
        list_category: null,
        provider: i.provider,
        provider_version: i.providerVersion,
      },
      now,
    );
    return { caseId, labelled: true };
  });
  if (out.labelled) moderationMetrics.actions.add(1, { kind: "t2_label" });
  return { tier: "t2", caseId: out.caseId, flagId: i.flagId, labelled: out.labelled };
}
