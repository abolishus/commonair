// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `QUEUES.vodFinalize` consumer: after a broadcast ends, PDQ-check frames sampled every effective
 * sample interval over the **whole** recording (all of them, before publishing), close the VOD
 * playlist (`#EXT-X-ENDLIST`), record duration/size, mark it `ready` and set its expiry from the
 * channel's retention. A hash match → `moderation.t0` for the VOD, which is never published. A
 * scan that cannot complete throws, so the job retries and nothing is published (fail closed).
 * Idempotent: a finished VOD is left alone.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import type { DiskBudget } from "../disk.ts";
import { frameArgs, type ImageFormat } from "../ffmpeg/args.ts";
import { runCommand } from "../ffmpeg/run.ts";
import { T0_REASON, type MediaModeration } from "../moderation/moderation.ts";
import { ActiveScratch } from "../recovery.ts";
import { assembleFromStorage } from "./assemble.ts";
import { parsePlaylist, renderPlaylist, totalDuration, type PlaylistSegment } from "./playlist.ts";
import { VOD_PLAYLIST, vodPrefix } from "./recorder.ts";

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

  const prefix = vodPrefix(vodId);
  const res = await storage.get(bucket, prefix + VOD_PLAYLIST);
  const segments = res ? parsePlaylist(await res.text()).segments : [];
  if (segments.length === 0) {
    log.warn("VOD has no segments; marking failed");
    await db
      .update(schema.vods)
      .set({ status: "failed", failedReason: VOD_EMPTY_REASON })
      .where(eq(schema.vods.id, vodId));
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

  let thumbnailKey: string | null = null;
  if (thumbnail) {
    thumbnailKey = `${prefix}thumbnail.${imageExt(deps.imageFormat)}`;
  }
  const now = deps.now?.() ?? new Date();
  // A T0 job that landed while we scanned (another sample, the worker) wins over publishing.
  if (await moderation.broadcastTainted(vod.broadcastId)) {
    await markRemoved(db, vodId);
    return "removed";
  }
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
    await storage.put(bucket, prefix + VOD_PLAYLIST, renderPlaylist(segments, { ended: true }), {
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "public, max-age=3600",
    });
    if (thumbnail && thumbnailKey)
      await storage.put(bucket, thumbnailKey, thumbnail, { contentType: imageType(deps.imageFormat) });
    let totalSize = 0;
    for await (const obj of storage.list(bucket, prefix)) totalSize += obj.size;
    const changed = await tx
      .update(schema.vods)
      .set({
        status: "ready",
        durationSeconds: totalDuration(segments),
        sizeBytes: totalSize,
        expiresAt: new Date(now.getTime() + vod.retentionDays * DAY_MS),
        ...(thumbnailKey ? { thumbnailKey } : {}),
      })
      .where(and(eq(schema.vods.id, vodId), eq(schema.vods.status, "processing")))
      .returning({ id: schema.vods.id });
    return changed.length > 0 ? totalSize : null;
  });
  if (size === null) return "removed";
  log.info("VOD ready", { segments: segments.length, sizeBytes: size });
  return "ready";
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
    deps.logger.warn("could not take the VOD thumbnail", { error: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}
