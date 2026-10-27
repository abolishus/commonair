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
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { evidenceKey, readObject, sealedDigestOf, sha256Hex, thumbnailPrefix } from "./objects.ts";
import { vodObjectPrefixes } from "../vod/prefixes.ts";
import { alert, audit, emit, safeErrorCode } from "./records.ts";
import { mediaStorage, moderationRuntime } from "./runtime.ts";
import { plaintextSha256 } from "@commonair/moderation";

const { moderationCases: cases, moderationFlags: flags, evidenceObjects, auditLog, vods, clips } = schema;

/** Re-run later: media may still flush objects after the initial T0 transaction. */
export const T0_MEDIA_SWEEP_DELAY_MS = 10 * 60_000;
export const t0MediaSweepJobId = (caseId: string, sweep = 1) => `t0-media-${caseId}-sweep-${sweep}`;
/** Repeated failures of one job raise an alert from this attempt on. */
export const T0_MEDIA_ALERT_AFTER_ATTEMPTS = 2;
export const T0_MEDIA_COMPLETE_AUDIT_ACTION = "moderation.t0.media_complete";

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
  // Both of a VOD's own prefixes, whatever its row says: a placement move in flight has copies
  // under each, and evidence must find every one (ADR 0009 amendment 1).
  for (const vodId of vodIds)
    for (const prefix of vodObjectPrefixes(vodId, null))
      for await (const o of storage.list(ctx.mediaBucket, prefix))
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
): Promise<boolean> {
  const rt = moderationRuntime(ctx);
  const media = mediaStorage(ctx);
  const res = await media.get(ctx.mediaBucket, t.key);
  if (!res) return false; // already moved (an earlier run) or never written
  const contentType = contentTypeOf(t.key, res.headers.get("content-type"));
  const plain = new Uint8Array(await res.arrayBuffer());
  const digest = await plaintextSha256(plain);
  // Serialize retries for this case/source/digest. The manifest, audit and event commit together;
  // deletion is deliberately after commit, so a crash can leave a public copy but never an
  // unrecorded deletion.
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${job.caseId}:${t.sourceId}:${digest}`}, 0))`,
    );
    const prior = await tx
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
    let preserved: (typeof prior)[number] | undefined;
    for (const candidate of prior)
      if (
        candidate.storageKey &&
        sealedDigestOf(candidate.storageKey) &&
        (await verifyEvidenceCopy(rt.evidenceStorage, rt.evidenceBucket, candidate.storageKey))
      ) {
        preserved = candidate;
        break;
      }
    let key: string;
    if (preserved?.storageKey) {
      key = preserved.storageKey;
      acc.alreadyPreserved++;
    } else {
      const sealed = await rt.sealing.seal(plain);
      const id = uuidv7();
      key = evidenceKey(job.caseId, id, await sha256Hex(sealed));
      await rt.evidenceStorage.put(rt.evidenceBucket, key, Buffer.from(sealed), {
        contentType: "application/octet-stream",
      });
      if (!(await verifyEvidenceCopy(rt.evidenceStorage, rt.evidenceBucket, key)))
        throw new Error("evidence copy could not be verified; the public copy was kept");
      await tx.insert(evidenceObjects).values({
        id,
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
      acc.evidenceIds.push(id);
      preserved = { id, storageKey: key };
    }
    const [flag] = await tx
      .select({ listCategory: flags.listCategory, provider: flags.provider, providerVersion: flags.providerVersion })
      .from(flags)
      .where(and(eq(flags.caseId, job.caseId), eq(flags.tier, "t0")))
      .limit(1);
    const now = ctx.now();
    const priorAudit = await tx
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "moderation.t0.media_preserved"), eq(auditLog.subjectId, job.caseId)));
    const recorded = priorAudit.some(
      (row) =>
        typeof row.details === "object" &&
        row.details !== null &&
        "evidenceId" in row.details &&
        row.details.evidenceId === preserved.id,
    );
    if (!recorded)
      await audit(
        tx,
        {
          action: "moderation.t0.media_preserved",
          subjectType: "moderation_case",
          subjectId: job.caseId,
          channelId: job.channelId,
          reason: "t0_hash_match",
          details: {
            caseId: job.caseId,
            holdId: job.holdId,
            evidenceId: preserved.id,
            sourceSubjectType: t.sourceType,
            sourceSubjectId: t.sourceId,
            kind: t.kind,
            provider: flag?.provider ?? "unknown",
            providerVersion: flag?.providerVersion ?? "unknown",
            listCategory: flag?.listCategory ?? null,
          },
        },
        now,
      );
    if (!recorded)
      await emit(
        tx,
        "moderation.t0.media_preserved",
        job.channelId,
        {
          case_id: job.caseId,
          hold_id: job.holdId,
          source_subject_type: t.sourceType,
          source_subject_id: t.sourceId,
          evidence_id: preserved.id,
          kind: t.kind,
          status: "object_preserved",
        },
        now,
      );
  });
  await media.delete(ctx.mediaBucket, t.key);
  acc.deleted++;
  return true;
}

export function nextT0MediaSweep(
  caseId: string,
  currentJobId: string | undefined,
  foundPublicObjects: number,
): { jobId: string; delayMs: number } | null {
  const base = `t0-media-${caseId}`;
  const sweepPrefix = `${base}-sweep-`;
  const reconcilePrefix = `${base}-reconcile-`;
  const recoveryMatch = currentJobId?.startsWith(reconcilePrefix)
    ? /^(\d+)(?:-sweep-(\d+))?$/.exec(currentJobId.slice(reconcilePrefix.length))
    : null;
  const sweepMatch = currentJobId?.startsWith(sweepPrefix)
    ? /^\d+$/.exec(currentJobId.slice(sweepPrefix.length))
    : null;
  if ((recoveryMatch?.[2] || sweepMatch) && foundPublicObjects === 0) return null;
  if (recoveryMatch) {
    const token = recoveryMatch[1];
    const next = recoveryMatch[2] ? Number(recoveryMatch[2]) + 1 : 1;
    return { jobId: `${reconcilePrefix}${token}-sweep-${next}`, delayMs: T0_MEDIA_SWEEP_DELAY_MS };
  }
  if (sweepMatch) {
    const sweepNumber = Number(sweepMatch[0]) + 1;
    return { jobId: `${sweepPrefix}${sweepNumber}`, delayMs: T0_MEDIA_SWEEP_DELAY_MS };
  }
  return { jobId: `${sweepPrefix}1`, delayMs: T0_MEDIA_SWEEP_DELAY_MS };
}

/** Record a clean, empty pass once; this marker drives the daily durable reconciler. */
export async function markT0MediaComplete(
  ctx: WorkerContext,
  job: ModerationT0MediaJob,
  subject: { type: "broadcast" | "vod" | "clip" | "upload"; id: string },
) {
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${job.caseId}, 0))`);
    const [complete] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, T0_MEDIA_COMPLETE_AUDIT_ACTION),
          eq(auditLog.subjectType, "moderation_case"),
          eq(auditLog.subjectId, job.caseId),
        ),
      )
      .limit(1);
    if (complete) return;
    const [flag] = await tx
      .select({ listCategory: flags.listCategory, provider: flags.provider, providerVersion: flags.providerVersion })
      .from(flags)
      .where(and(eq(flags.caseId, job.caseId), eq(flags.tier, "t0")))
      .limit(1);
    const now = ctx.now();
    await audit(
      tx,
      {
        action: T0_MEDIA_COMPLETE_AUDIT_ACTION,
        subjectType: "moderation_case",
        subjectId: job.caseId,
        channelId: job.channelId,
        reason: "t0_hash_match",
        details: {
          caseId: job.caseId,
          holdId: job.holdId,
          reconciled: true,
          provider: flag?.provider ?? "unknown",
          providerVersion: flag?.providerVersion ?? "unknown",
          listCategory: flag?.listCategory ?? null,
        },
      },
      now,
    );
    await emit(
      tx,
      "moderation.t0.media_preserved",
      job.channelId,
      {
        case_id: job.caseId,
        hold_id: job.holdId,
        source_subject_type: subject.type,
        source_subject_id: subject.id,
        evidence_id: null,
        kind: null,
        status: "reconciliation_complete",
      },
      now,
    );
  });
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
  let foundPublicObjects = 0;
  try {
    targets = await collectTargets(ctx, media, { type: c.subjectType, id: c.subjectId });
    for (const t of targets) if (await preserveOne(ctx, job, t, acc)) foundPublicObjects++;
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
  // Keep sweeping until a pass finds no public objects; every pass has a distinct durable id.
  const nextSweep = nextT0MediaSweep(job.caseId, meta.id, foundPublicObjects);
  if (nextSweep) await ctx.enqueue(QUEUES.moderation, MODERATION_JOBS.t0Media, job, nextSweep);
  else await markT0MediaComplete(ctx, job, { type: c.subjectType, id: c.subjectId });
  ctx.logger.info("T0 media preserved", {
    caseId: job.caseId,
    targets: targets.length,
    copied: acc.copied,
    alreadyPreserved: acc.alreadyPreserved,
    publicDeleted: acc.deleted,
  });
  return { ...acc, targets: targets.length };
}
