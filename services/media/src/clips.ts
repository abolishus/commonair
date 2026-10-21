// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `QUEUES.clips` consumer: cut `durationSeconds` starting `startOffset` seconds into the
 * broadcast, from the live recorder's local buffer when the broadcast is still live, otherwise
 * from the VOD's segments in object storage. Every second of the cut and its thumbnail are
 * PDQ-checked before anything is uploaded; a match → `moderation.t0` for the clip, which is never
 * published. Output: `clips/<clipId>.mp4` plus a thumbnail.
 */

import { join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import type { DiskBudget } from "./disk.ts";
import { clipArgs, frameArgs, type H264Encoder, type ImageFormat } from "./ffmpeg/args.ts";
import { runCommand } from "./ffmpeg/run.ts";
import { ActiveScratch } from "./recovery.ts";
import { T0_REASON, type Hit, type MediaModeration } from "./moderation/moderation.ts";
import { assembleFromStorage, concatFiles } from "./vod/assemble.ts";
import { imageExt, imageType } from "./vod/finalize.ts";
import { findWindow, parsePlaylist } from "./vod/playlist.ts";
import { VOD_PLAYLIST, vodPrefix, type LocalWindow } from "./vod/recorder.ts";

export const ClipJob = z.object({ clipId: z.uuid() });
export type ClipJob = z.infer<typeof ClipJob>;

export const clipKey = (clipId: string) => `clips/${clipId}.mp4`;
export const clipThumbKey = (clipId: string, f: ImageFormat) => `clips/${clipId}.${imageExt(f)}`;

/** The clip can never be produced (no source media); retrying will not help. */
export class ClipUnavailableError extends Error {
  constructor(
    message: string,
    /** Stored as the clip's `removedReason` when set. */
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "ClipUnavailableError";
  }
}

/** `removedReason` of a clip refused because the media work dir is over its disk budget. */
export const CLIP_DISK_REASON = "disk_budget_exceeded";

export interface ClipDeps {
  db: Database;
  storage: ObjectStorage;
  bucket: string;
  moderation: MediaModeration;
  ffmpeg: string;
  encoder: H264Encoder;
  imageFormat: ImageFormat;
  workDir: string;
  logger: Logger;
  /** Refuses the cut when the work dir is over budget (optional for embedding/tests). */
  diskBudget?: DiskBudget;
  /** Registry of running jobs' scratch dirs, so the work-dir sweep leaves them alone. */
  scratch?: ActiveScratch;
  /** Local rolling buffer of a broadcast that is live on this instance. */
  liveWindow: (broadcastId: string, start: Date, durationSeconds: number) => LocalWindow | null;
}

export async function processClip(deps: ClipDeps, clipId: string): Promise<"ready" | "removed" | "skipped"> {
  const { db, storage, bucket } = deps;
  const log = deps.logger.child({ clipId, worker: "clips" });
  const [clip] = await db
    .select({
      id: schema.clips.id,
      status: schema.clips.status,
      channelId: schema.clips.channelId,
      broadcastId: schema.clips.broadcastId,
      vodId: schema.clips.vodId,
      startOffset: schema.clips.startOffset,
      durationSeconds: schema.clips.durationSeconds,
      startedAt: schema.broadcasts.startedAt,
    })
    .from(schema.clips)
    .leftJoin(schema.broadcasts, eq(schema.broadcasts.id, schema.clips.broadcastId))
    .where(eq(schema.clips.id, clipId));
  if (!clip || clip.status !== "processing") return "skipped";
  if (!clip.broadcastId || !clip.startedAt) throw new ClipUnavailableError("clip has no broadcast");
  if (!(clip.durationSeconds > 0)) throw new ClipUnavailableError("clip duration must be positive");
  if (await deps.moderation.broadcastTainted(clip.broadcastId)) {
    await markClipRemoved(db, clipId);
    return "removed";
  }
  const start = new Date(clip.startedAt.getTime() + clip.startOffset * 1000);
  // Refused outright, never queued behind a full disk: the creator can simply clip again.
  const budget = await deps.diskBudget?.check("clip");
  if (budget && !budget.ok) throw new ClipUnavailableError("media work dir over disk budget", CLIP_DISK_REASON);

  const scratches = deps.scratch ?? new ActiveScratch();
  const scratch = await scratches.create(deps.workDir, "clip-");
  try {
    const source = join(scratch, "source.mp4");
    let window: { offsetSeconds: number; durationSeconds: number };
    let vodId = clip.vodId;
    const live = deps.liveWindow(clip.broadcastId, start, clip.durationSeconds);
    if (live) {
      await concatFiles([live.initPath, ...live.segmentPaths], source);
      window = live;
    } else {
      vodId ??= await findVod(db, clip.broadcastId);
      if (!vodId) throw new ClipUnavailableError("broadcast is not live here and has no VOD");
      const prefix = vodPrefix(vodId);
      const res = await storage.get(bucket, prefix + VOD_PLAYLIST);
      if (!res) throw new ClipUnavailableError("VOD playlist missing");
      const w = findWindow(parsePlaylist(await res.text()).segments, start, clip.durationSeconds);
      const first = w?.segments[0];
      if (!w || !first?.map) throw new ClipUnavailableError("clip window is outside the recording");
      const keys = [prefix + first.map, ...w.segments.map((s) => prefix + s.uri)];
      await assembleFromStorage(storage, bucket, keys, scratch, source);
      window = w;
    }

    const out = join(scratch, "clip.mp4");
    await runCommand(
      deps.ffmpeg,
      clipArgs({
        input: source,
        startSeconds: window.offsetSeconds,
        durationSeconds: window.durationSeconds,
        output: out,
        encoder: deps.encoder,
      }),
      { timeoutMs: Math.max(60_000, window.durationSeconds * 10_000) },
    );
    // Every second of the cut, all of it, before anything is uploaded (decoder errors throw:
    // the job retries and nothing is published).
    const scan = await deps.moderation.scanVideoFile(out, CLIP_SAMPLE_SECONDS, new Date());
    deps.moderation.prepublishFrames("clip", scan.frames);
    if (scan.frames === 0) throw new Error("no frame decoded from the clip; not publishing");
    if (scan.hit) return removeForT0(deps, clipId, clip.channelId, scan.hit);
    const { stdout: thumb } = await runCommand(
      deps.ffmpeg,
      frameArgs(out, window.durationSeconds / 2, deps.imageFormat),
      { timeoutMs: 30_000, maxStdoutBytes: 8 * 1024 * 1024 },
    );
    if (thumb.byteLength > 0) {
      const { frame, pdq, match } = await deps.moderation.checkImage(thumb);
      if (match)
        return removeForT0(deps, clipId, clip.channelId, {
          match,
          frame,
          pdq,
          capturedAt: new Date(),
          original: { bytes: thumb, contentType: imageType(deps.imageFormat) },
        });
    }
    // A T0 job that landed while we cut (live sampling, the worker) wins over publishing.
    if (await deps.moderation.broadcastTainted(clip.broadcastId)) {
      await markClipRemoved(db, clipId);
      return "removed";
    }
    const thumbnailKey = thumb.byteLength > 0 ? clipThumbKey(clipId, deps.imageFormat) : null;
    const clipBytes = await Bun.file(out).bytes();
    const published = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: schema.clips.status })
        .from(schema.clips)
        .where(eq(schema.clips.id, clipId))
        .for("update");
      if (current?.status !== "processing") return false;
      // T0 cleanup changes this row in its transaction. Holding the row lock across object
      // publication makes cleanup and publication serialize: cleanup wins before uploads or
      // runs after all uploads and the ready transition commit.
      await storage.put(bucket, clipKey(clipId), clipBytes, { contentType: "video/mp4" });
      if (thumbnailKey) await storage.put(bucket, thumbnailKey, thumb, { contentType: imageType(deps.imageFormat) });
      const changed = await tx
        .update(schema.clips)
        .set({
          status: "ready",
          storageKey: clipKey(clipId),
          thumbnailKey,
          durationSeconds: Math.round(window.durationSeconds * 1000) / 1000,
          ...(vodId && !clip.vodId ? { vodId } : {}),
        })
        .where(and(eq(schema.clips.id, clipId), eq(schema.clips.status, "processing")))
        .returning({ id: schema.clips.id });
      return changed.length > 0;
    });
    if (!published) return "removed";
    log.info("clip ready", { durationSeconds: window.durationSeconds, fromLiveBuffer: live !== null });
    return "ready";
  } finally {
    await scratches.release(scratch);
  }
}

/** Clips are sampled every second (ADR 0006 Q1, vPDQ-style). */
export const CLIP_SAMPLE_SECONDS = 1;

async function markClipRemoved(db: Database, clipId: string): Promise<void> {
  await db
    .update(schema.clips)
    .set({ status: "deleted", removedReason: T0_REASON })
    .where(and(eq(schema.clips.id, clipId), eq(schema.clips.status, "processing")));
}

/** Enqueue T0 for the clip (throws if it cannot, so the job retries), then mark it removed. Nothing is uploaded. */
async function removeForT0(deps: ClipDeps, clipId: string, channelId: string, hit: Hit): Promise<"removed"> {
  await deps.moderation.t0Prepublish("clip", clipId, channelId, hit);
  await markClipRemoved(deps.db, clipId);
  return "removed";
}

async function findVod(db: Database, broadcastId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.vods.id })
    .from(schema.vods)
    .where(
      and(eq(schema.vods.broadcastId, broadcastId), inArray(schema.vods.status, ["recording", "processing", "ready"])),
    )
    .orderBy(desc(schema.vods.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export async function markClipFailed(db: Database, clipId: string, reason: string | null = null): Promise<void> {
  await db
    .update(schema.clips)
    .set({ status: "failed", ...(reason ? { removedReason: reason } : {}) })
    .where(and(eq(schema.clips.id, clipId), eq(schema.clips.status, "processing")));
}
