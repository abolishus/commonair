// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `moderation.t0-media`: after a T0 transaction, every VOD object, clip file and stored thumbnail
 * of the subject is sealed into the evidence bucket (one `evidence_objects` manifest row each) and
 * only then is the public copy deleted. A public copy is never deleted unless its evidence copy was
 * re-read and its digest verified. Objects are sealed one at a time (HLS segments are small), so a
 * whole VOD is never held in memory. Idempotent: an object whose evidence copy already exists and
 * verifies is only deleted from the public bucket.
 */
import { MODERATION_JOBS, QUEUES, type ModerationT0MediaJob } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import type { ObjectStorage } from "@commonair/storage";
import { and, eq, inArray, or } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { evidenceKey, readObject, sealedDigestOf, sha256Hex, thumbnailPrefix, vodPrefix } from "./objects.ts";
import { alert, audit, safeErrorCode } from "./records.ts";
import { mediaStorage, moderationRuntime } from "./runtime.ts";
import { plaintextSha256 } from "@commonair/moderation";

const { moderationCases: cases, evidenceObjects, vods, clips } = schema;

/** Re-run once later: media may still flush recording segments after the T0 transaction. */
export const T0_MEDIA_SWEEP_DELAY_MS = 10 * 60_000;
export const t0MediaSweepJobId = (caseId: string) => `t0-media:${caseId}:sweep`;
/** Repeated failures of one job raise an alert from this attempt on. */
export const T0_MEDIA_ALERT_AFTER_ATTEMPTS = 2;

type Kind = "vod_object" | "clip_object" | "thumbnail";
type SourceType = "broadcast" | "vod" | "clip";

export interface MediaTarget {
  key: string;
  kind: Kind;
  sourceType: SourceType;
  sourceId: string;
}

function clipKindForKey(key: string): Kind | null {
  if (/\.mp4$/i.test(key)) return "clip_object";
  if (/\.(?:png|jpe?g|webp)$/i.test(key)) return "thumbnail";
  return null;
}

/** Include conventional media-bucket objects even when clip generation failed before saving DB keys. */
export async function collectClipTargets(
  storage: ObjectStorage,
  bucket: string,
  rows: readonly { id: string; storageKey: string | null; thumbnailKey: string | null }[],
): Promise<MediaTarget[]> {
  const targets = new Map<string, MediaTarget>();
  for (const clip of rows) {
    if (clip.storageKey)
      targets.set(clip.storageKey, {
        key: clip.storageKey,
        kind: "clip_object",
        sourceType: "clip",
        sourceId: clip.id,
      });
    if (clip.thumbnailKey)
      targets.set(clip.thumbnailKey, {
        key: clip.thumbnailKey,
        kind: "thumbnail",
        sourceType: "clip",
        sourceId: clip.id,
      });
    for await (const object of storage.list(bucket, `clips/${clip.id}.`)) {
      const kind = clipKindForKey(object.key);
      if (kind) targets.set(object.key, { key: object.key, kind, sourceType: "clip", sourceId: clip.id });
    }
  }
  return [...targets.values()];
}

/** The objects a T0 case's subject owns, by listing prefixes and reading clip keys. */
export async function collectTargets(
  ctx: WorkerContext,
  storage: ObjectStorage,
  subject: { type: string; id: string },
): Promise<MediaTarget[]> {
  const out: MediaTarget[] = [];
  let vodIds: string[] = [];
  let clipRows: { id: string; storageKey: string | null; thumbnailKey: string | null }[] = [];
  if (subject.type === "broadcast") {
    vodIds = (await ctx.db.select({ id: vods.id }).from(vods).where(eq(vods.broadcastId, subject.id))).map((v) => v.id);
    clipRows = await ctx.db
      .select({ id: clips.id, storageKey: clips.storageKey, thumbnailKey: clips.thumbnailKey })
      .from(clips)
      .where(or(eq(clips.broadcastId, subject.id), ...(vodIds.length ? [inArray(clips.vodId, vodIds)] : [])));
    for await (const o of storage.list(ctx.mediaBucket, thumbnailPrefix(subject.id)))
      out.push({ key: o.key, kind: "thumbnail", sourceType: "broadcast", sourceId: subject.id });
  } else if (subject.type === "vod") {
    vodIds = [subject.id];
    clipRows = await ctx.db
      .select({ id: clips.id, storageKey: clips.storageKey, thumbnailKey: clips.thumbnailKey })
      .from(clips)
      .where(eq(clips.vodId, subject.id));
  } else if (subject.type === "clip") {
    clipRows = await ctx.db
      .select({ id: clips.id, storageKey: clips.storageKey, thumbnailKey: clips.thumbnailKey })
      .from(clips)
      .where(eq(clips.id, subject.id));
  }
  for (const vodId of vodIds)
    for await (const o of storage.list(ctx.mediaBucket, vodPrefix(vodId)))
      out.push({
        key: o.key,
        kind: /thumbnail\.[a-z]+$/.test(o.key) ? "thumbnail" : "vod_object",
        sourceType: "vod",
        sourceId: vodId,
      });
  out.push(...(await collectClipTargets(storage, ctx.mediaBucket, clipRows)));
  return out;
}

const contentTypeOf = (key: string, header: string | null) =>
  header ??
  (key.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : key.endsWith(".mp4") || key.endsWith(".m4s")
      ? "video/mp4"
      : key.endsWith(".ts")
        ? "video/mp2t"
        : "application/octet-stream");

/** True when the evidence object exists and its bytes match the digest in its key. */
export async function verifyEvidenceCopy(storage: ObjectStorage, bucket: string, key: string): Promise<boolean> {
  const expected = sealedDigestOf(key);
  if (!expected) return false;
  const bytes = await readObject(storage, bucket, key);
  return bytes !== null && (await sha256Hex(bytes)) === expected;
}

export interface PreserveResult {
  copied: number;
  alreadyPreserved: number;
  deleted: number;
  evidenceIds: string[];
}

/** Seal, store, verify, record and only then delete the public copy of one object. */
export async function preserveOne(
  ctx: WorkerContext,
  job: ModerationT0MediaJob,
  t: MediaTarget,
  acc: PreserveResult,
): Promise<void> {
  const rt = moderationRuntime(ctx);
  const media = mediaStorage(ctx);
  const res = await media.get(ctx.mediaBucket, t.key);
  if (!res) return; // already moved (an earlier run) or never written
  const contentType = contentTypeOf(t.key, res.headers.get("content-type"));
  const plain = new Uint8Array(await res.arrayBuffer());
  const digest = await plaintextSha256(plain);
  const prior = await ctx.db
    .select({ id: evidenceObjects.id, storageKey: evidenceObjects.storageKey })
    .from(evidenceObjects)
    .where(
      and(
        eq(evidenceObjects.caseId, job.caseId),
        eq(evidenceObjects.sha256, digest),
        eq(evidenceObjects.sourceSubjectId, t.sourceId),
        eq(evidenceObjects.storage, "bucket"),
      ),
    );
  let preserved = false;
  for (const p of prior)
    if (p.storageKey && (await verifyEvidenceCopy(rt.evidenceStorage, rt.evidenceBucket, p.storageKey))) {
      preserved = true;
      acc.alreadyPreserved++;
      break;
    }
  if (!preserved) {
    const sealed = await rt.sealing.seal(plain);
    const evidenceId = uuidv7();
    const key = evidenceKey(job.caseId, evidenceId, await sha256Hex(sealed));
    await rt.evidenceStorage.put(rt.evidenceBucket, key, Buffer.from(sealed), {
      contentType: "application/octet-stream",
    });
    if (!(await verifyEvidenceCopy(rt.evidenceStorage, rt.evidenceBucket, key)))
      throw new Error("evidence copy could not be verified; the public copy was kept");
    await ctx.db.insert(evidenceObjects).values({
      id: evidenceId,
      holdId: job.holdId,
      caseId: job.caseId,
      kind: t.kind,
      storage: "bucket",
      storageKey: key,
      sha256: digest,
      sizeBytes: plain.length,
      contentType,
      keyId: rt.sealing.keyId,
      sourceSubjectType: t.sourceType,
      sourceSubjectId: t.sourceId,
      capturedAt: ctx.now(),
    });
    moderationMetrics.evidenceObjects.add(1, { kind: t.kind, storage: "bucket" });
    acc.copied++;
    acc.evidenceIds.push(evidenceId);
  }
  await media.delete(ctx.mediaBucket, t.key);
  acc.deleted++;
}

export async function preserveT0Media(
  ctx: WorkerContext,
  job: ModerationT0MediaJob,
  meta: { id?: string; attemptsMade: number } = { attemptsMade: 0 },
): Promise<PreserveResult & { targets: number }> {
  moderationRuntime(ctx);
  const media = mediaStorage(ctx);
  const [c] = await ctx.db
    .select({ id: cases.id, tier: cases.tier, subjectType: cases.subjectType, subjectId: cases.subjectId })
    .from(cases)
    .where(eq(cases.id, job.caseId));
  if (!c || c.tier !== "t0") throw new Error("t0-media: case not found or not T0");
  const acc: PreserveResult = { copied: 0, alreadyPreserved: 0, deleted: 0, evidenceIds: [] };
  let targets: MediaTarget[] = [];
  try {
    targets = await collectTargets(ctx, media, { type: c.subjectType, id: c.subjectId });
    for (const t of targets) await preserveOne(ctx, job, t, acc);
  } catch (err) {
    if (meta.attemptsMade + 1 >= T0_MEDIA_ALERT_AFTER_ATTEMPTS)
      alert(ctx, "t0_media_failed", "T0 media could not be moved to evidence; retrying", {
        caseId: job.caseId,
        attempts: meta.attemptsMade + 1,
        copied: acc.copied,
        errorCode: safeErrorCode(err),
      });
    throw err;
  }
  if (acc.copied > 0 || acc.deleted > 0)
    await audit(
      ctx.db,
      {
        action: "moderation.t0.media_preserved",
        subjectType: "moderation_case",
        subjectId: job.caseId,
        channelId: job.channelId,
        reason: "t0_hash_match",
        details: {
          caseId: job.caseId,
          holdId: job.holdId,
          broadcastId: job.broadcastId,
          copied: acc.copied,
          alreadyPreserved: acc.alreadyPreserved,
          publicDeleted: acc.deleted,
          evidenceIds: acc.evidenceIds,
        },
      },
      ctx.now(),
    );
  // One later sweep catches segments media flushed after the T0 transaction.
  if (meta.id !== t0MediaSweepJobId(job.caseId) && c.subjectType !== "upload")
    await ctx.enqueue(QUEUES.moderation, MODERATION_JOBS.t0Media, job, {
      jobId: t0MediaSweepJobId(job.caseId),
      delayMs: T0_MEDIA_SWEEP_DELAY_MS,
    });
  ctx.logger.info("T0 media preserved", {
    caseId: job.caseId,
    targets: targets.length,
    copied: acc.copied,
    alreadyPreserved: acc.alreadyPreserved,
    publicDeleted: acc.deleted,
  });
  return { ...acc, targets: targets.length };
}
