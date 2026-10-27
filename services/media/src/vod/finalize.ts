// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `QUEUES.vodFinalize` consumer: after a broadcast ends, PDQ-check frames sampled every effective
 * sample interval over the **whole** recording (all of them, before publishing), close the VOD
 * playlist (`#EXT-X-ENDLIST`), record duration/size, mark it `ready` and set its expiry from the
 * channel's retention. A hash match → `moderation.t0` for the VOD, which is never published. A
 * scan that cannot complete throws, so the job retries and nothing is published (fail closed).
 * Idempotent: a finished VOD is left alone.
 *
 * Placement (ADR 0009 amendment 1): the recording lives under the private `recordings/<id>/`.
 * Once the scan passes, the VOD's placement as it will be once ready decides where it ends up: a
 * public VOD is copied to `vods/<id>/` before the `ready` transaction (which also switches
 * `storage_prefix`), and the private copy is deleted after commit; anything else stays private. A
 * crash between copy and commit leaves both copies; the rerun finishes the move.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { isVodOwnPrefix, vodPlacement, vodPrefix, type VodPlacementState } from "@commonair/contracts/storage";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { moveVodObjects, type ObjectStorage } from "@commonair/storage";
import type { DiskBudget } from "../disk.ts";
import { frameArgs, type ImageFormat } from "../ffmpeg/args.ts";
import { runCommand } from "../ffmpeg/run.ts";
import { T0_REASON, type MediaModeration } from "../moderation/moderation.ts";
import { errorCategory } from "../moderation/logging.ts";
import { ActiveScratch } from "../recovery.ts";
import { assembleFromStorage } from "./assemble.ts";
import { parsePlaylist, renderPlaylist, totalDuration, type PlaylistSegment } from "./playlist.ts";
import { VOD_PLAYLIST } from "./recorder.ts";

export const VodFinalizeJob = z.object({ vodId: z.uuid() });
export type VodFinalizeJob = z.infer<typeof VodFinalizeJob>;

export interface FinalizeDeps {
  db: Database;
  storage: ObjectStorage;
  bucket: string;
  moderation: MediaModeration;
  ffmpeg: string;
  imageFormat: ImageFormat;
  workDir: string;
  logger: Logger;
  diskBudget?: DiskBudget;
  /** Registry of running jobs' scratch dirs, so the work-dir sweep leaves them alone. */
  scratch?: ActiveScratch;
  now?: () => Date;
}

/** `failedReason` of a VOD that recorded nothing (stable code, see README). */
export const VOD_EMPTY_REASON = "no_segments";

const DAY_MS = 86_400_000;
export const imageExt = (f: ImageFormat) => (f === "webp" ? "webp" : "jpg");
export const imageType = (f: ImageFormat) => (f === "webp" ? "image/webp" : "image/jpeg");

/** Longest stretch of recording assembled into one scratch file for frame sampling. */
export const SCAN_CHUNK_SECONDS = 60;

/**
 * Pure: consecutive segments grouped for sampling. A group shares one init segment (a new
 * recorder run starts a new group) and spans at most `maxSeconds` (bounds scratch space; a single
 * longer segment is its own group). Sampling restarts at each group's start, so frames are never
 * further apart than the interval.
 */
export function scanChunks(segments: readonly PlaylistSegment[], maxSeconds = SCAN_CHUNK_SECONDS): PlaylistSegment[][] {
  const out: PlaylistSegment[][] = [];
  let cur: PlaylistSegment[] = [];
  let secs = 0;
  for (const seg of segments) {
    const first = cur[0];
    if (first && (first.map !== seg.map || secs + seg.durationSeconds > maxSeconds)) {
      out.push(cur);
      cur = [];
      secs = 0;
    }
    cur.push(seg);
    secs += seg.durationSeconds;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * The VOD's placement inputs as they will be once it is `ready`: visibility, removal, the
 * broadcast's T1 restriction, the channel's suspension, and the NCII and DMCA flows that own the
 * objects' keys while they run (same rules as the worker's `vod-placement` and the origin).
 */
export async function placementOnceReady(db: Database, vodId: string): Promise<VodPlacementState | null> {
  const v = schema.vods;
  const [row] = await db
    .select({
      visibility: v.visibility,
      removedReason: v.removedReason,
      broadcastRestricted: sql<boolean>`${schema.broadcasts.restrictedAt} is not null`,
      channelSuspended: sql<boolean>`${schema.channels.suspendedAt} is not null`,
      nciiHidden: sql<boolean>`exists (select 1 from ${schema.nciiRequestItems} i where i.subject_type = 'vod' and i.subject_id = ${v.id} and (i.hidden_at is not null or i.removed_at is not null))`,
      dmcaHidden: sql<boolean>`exists (select 1 from ${schema.dmcaNoticeItems} d where ((d.subject_type = 'vod' and d.subject_id = ${v.id}) or (d.subject_type = 'broadcast' and d.subject_id = ${v.broadcastId})) and d.removed_at is not null and d.restored_at is null)`,
    })
    .from(v)
    .innerJoin(schema.broadcasts, eq(schema.broadcasts.id, v.broadcastId))
    .innerJoin(schema.channels, eq(schema.channels.id, v.channelId))
    .where(eq(v.id, vodId));
  return row ? { ...row, status: "ready" } : null;
}

/** Mark a VOD removed by T0 (never published). Conditional, so a finished VOD is not overwritten. */
async function markRemoved(db: Database, vodId: string): Promise<void> {
  await db
    .update(schema.vods)
    .set({ status: "deleted", removedReason: T0_REASON })
    .where(and(eq(schema.vods.id, vodId), inArray(schema.vods.status, ["recording", "processing"])));
}

export async function finalizeVod(
  deps: FinalizeDeps,
  vodId: string,
): Promise<"ready" | "failed" | "removed" | "skipped"> {
  const { db, storage, bucket, logger, moderation } = deps;
  const log = logger.child({ vodId, worker: "vod-finalize" });
  const [vod] = await db
    .select({
      id: schema.vods.id,
      status: schema.vods.status,
      channelId: schema.vods.channelId,
      broadcastId: schema.vods.broadcastId,
      storagePrefix: schema.vods.storagePrefix,
      retentionDays: schema.channels.vodRetentionDays,
    })
    .from(schema.vods)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.vods.channelId))
    .where(eq(schema.vods.id, vodId));
  if (!vod || vod.status === "ready" || vod.status === "deleted" || vod.status === "failed") return "skipped";
  // Never publish anything from a broadcast with a T0 match (found live, before or while this job
  // was queued). The worker copies its objects to evidence and removes the public copies.
  if (await moderation.broadcastTainted(vod.broadcastId)) {
    log.warn("refusing to publish the VOD of a broadcast with a T0 match");
    await markRemoved(db, vodId);
    return "removed";
  }
  // Frame sampling needs scratch space; over budget, BullMQ retries later (and the stale-VOD
  // reconcile re-queues the job if every retry is used up).
  const budget = await deps.diskBudget?.check("vod-finalize");
  if (budget && !budget.ok) throw new Error("media work dir over disk budget");
  const claimed = await db
    .update(schema.vods)
    .set({ status: "processing" })
    .where(and(eq(schema.vods.id, vodId), inArray(schema.vods.status, ["recording", "processing"])))
    .returning({ id: schema.vods.id });
  if (claimed.length === 0) {
    const [current] = await db
      .select({ status: schema.vods.status })
      .from(schema.vods)
      .where(eq(schema.vods.id, vodId));
    return current?.status === "deleted" ? "removed" : "skipped";
  }

  const prefix = vod.storagePrefix;
  // Only the VOD's own prefixes are ever read, copied or deleted here.
  if (!isVodOwnPrefix(vodId, prefix)) throw new Error("unexpected VOD storage prefix; not finalizing");
  const res = await storage.get(bucket, prefix + VOD_PLAYLIST);
  const segments = res ? parsePlaylist(await res.text()).segments : [];
  if (segments.length === 0) {
    log.warn("VOD has no segments; marking failed");
    const failed = await db
      .update(schema.vods)
      .set({ status: "failed", failedReason: VOD_EMPTY_REASON })
      .where(and(eq(schema.vods.id, vodId), eq(schema.vods.status, "processing")))
      .returning({ id: schema.vods.id });
    if (failed.length === 0) {
      const [current] = await db
        .select({ status: schema.vods.status })
        .from(schema.vods)
        .where(eq(schema.vods.id, vodId));
      return current?.status === "deleted" ? "removed" : "skipped";
    }
    return "failed";
  }

  const scratches = deps.scratch ?? new ActiveScratch();
  const scratch = await scratches.create(deps.workDir, "vod-");
  let thumbnail: Uint8Array<ArrayBuffer> | null = null;
  try {
    const every = await moderation.sampleSeconds();
    let frames = 0;
    for (const [i, chunk] of scanChunks(segments).entries()) {
      const file = join(scratch, `scan-${i}.mp4`);
      const first = chunk[0] as PlaylistSegment;
      const keys = [...(first.map ? [prefix + first.map] : []), ...chunk.map((sg) => prefix + sg.uri)];
      // Missing objects or an undecodable chunk throw: the job retries, nothing is published.
      await assembleFromStorage(storage, bucket, keys, scratch, file);
      const { hit, frames: n } = await moderation.scanVideoFile(file, every, new Date());
      await rm(file, { force: true });
      frames += n;
      if (n === 0) throw new Error("no frame decoded from a VOD chunk; not publishing");
      if (hit) {
        moderation.prepublishFrames("vod", frames);
        await moderation.t0Prepublish("vod", vodId, vod.channelId, hit);
        await markRemoved(db, vodId);
        return "removed";
      }
    }
    moderation.prepublishFrames("vod", frames);
    // The thumbnail is a frame of the middle segment, PDQ-checked before it is written.
    const mid = Math.floor(segments.length / 2);
    const image = await sampleFrame(deps, prefix, segments[mid] as PlaylistSegment, scratch, mid);
    if (image) {
      const { frame, pdq, match } = await moderation.checkImage(image);
      if (match) {
        await moderation.t0Prepublish("vod", vodId, vod.channelId, {
          match,
          frame,
          pdq,
          capturedAt: new Date(),
          original: { bytes: image, contentType: imageType(deps.imageFormat) },
        });
        await markRemoved(db, vodId);
        return "removed";
      }
      thumbnail = image;
    }
  } finally {
    await scratches.release(scratch);
  }

  const now = deps.now?.() ?? new Date();
  // A T0 job that landed while we scanned (another sample, the worker) wins over publishing.
  if (await moderation.broadcastTainted(vod.broadcastId)) {
    await markRemoved(db, vodId);
    return "removed";
  }
  const state = await placementOnceReady(db, vodId);
  const placement = state ? vodPlacement(state) : "private";
  // `leave`: another flow (NCII, DMCA) owns the keys; the objects stay where they are.
  const target = placement === "leave" ? prefix : vodPrefix(vodId, placement);
  const moving = target !== prefix;
  // Copy (never delete) before `ready`: a ready VOD never points at missing objects.
  if (moving) await moveVodObjects(storage, bucket, prefix, target);
  const thumbnailKey = thumbnail ? `${target}thumbnail.${imageExt(deps.imageFormat)}` : null;
  const size = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: schema.vods.status })
      .from(schema.vods)
      .where(eq(schema.vods.id, vodId))
      .for("update");
    if (current?.status !== "processing") return null;
    // Keep T0 cleanup serialized with publication through the ready transition. If cleanup
    // committed first, no final objects are written; if this transaction wins, cleanup runs
    // afterwards and removes the completed public media.
    await storage.put(bucket, target + VOD_PLAYLIST, renderPlaylist(segments, { ended: true }), {
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "public, max-age=3600",
    });
    if (thumbnail && thumbnailKey)
      await storage.put(bucket, thumbnailKey, thumbnail, { contentType: imageType(deps.imageFormat) });
    let totalSize = 0;
    for await (const obj of storage.list(bucket, target)) totalSize += obj.size;
    const changed = await tx
      .update(schema.vods)
      .set({
        status: "ready",
        storagePrefix: target,
        durationSeconds: totalDuration(segments),
        sizeBytes: totalSize,
        expiresAt: new Date(now.getTime() + vod.retentionDays * DAY_MS),
        ...(thumbnailKey ? { thumbnailKey } : {}),
      })
      .where(and(eq(schema.vods.id, vodId), eq(schema.vods.status, "processing")))
      .returning({ id: schema.vods.id });
    return changed.length > 0 ? totalSize : null;
  });
  if (size === null) {
    // Not ours to publish any more: removed meanwhile (T0, NCII), or a concurrent run of this job
    // already published it. The copies made here go only when the row does not point at them
    // (the source is intact; T0 evidence lists both prefixes).
    if (moving) {
      const [current] = await db
        .select({ prefix: schema.vods.storagePrefix })
        .from(schema.vods)
        .where(eq(schema.vods.id, vodId));
      if (current && current.prefix !== target) await deleteQuietly(deps, target, log);
    }
    return "removed";
  }
  if (moving) await deleteQuietly(deps, prefix, log);
  log.info("VOD ready", { segments: segments.length, sizeBytes: size, placement });
  return "ready";
}

/** Delete a VOD prefix after the database no longer points at it; a failure is logged, never thrown. */
async function deleteQuietly(deps: FinalizeDeps, prefix: string, log: Logger): Promise<void> {
  try {
    await deps.storage.deletePrefix(deps.bucket, prefix);
  } catch (err) {
    log.error("could not delete the VOD's previous prefix", { error: errorCategory(err) });
  }
}

async function sampleFrame(
  deps: FinalizeDeps,
  prefix: string,
  seg: PlaylistSegment,
  scratch: string,
  idx: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!seg.map) return null;
  const file = join(scratch, `sample-${idx}.mp4`);
  try {
    await assembleFromStorage(deps.storage, deps.bucket, [prefix + seg.map, prefix + seg.uri], scratch, file);
    const at = Math.min(1, seg.durationSeconds / 2);
    const { stdout } = await runCommand(deps.ffmpeg, frameArgs(file, at, deps.imageFormat), {
      timeoutMs: 30_000,
      maxStdoutBytes: 8 * 1024 * 1024,
    });
    return stdout.byteLength > 0 ? stdout : null;
  } catch (err) {
    // Only the thumbnail: every sampled frame was PDQ-checked above, so a VOD without one is fine.
    deps.logger.warn("could not take the VOD thumbnail", { error: errorCategory(err) });
    return null;
  }
}
