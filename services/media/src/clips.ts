// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `QUEUES.clips` consumer: cut `durationSeconds` starting `startOffset` seconds into the
 * broadcast, from the live recorder's local buffer when the broadcast is still live, otherwise
 * from the VOD's segments in object storage. Output: `clips/<clipId>.mp4` plus a thumbnail.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import { clipArgs, frameArgs, type H264Encoder, type ImageFormat } from "./ffmpeg/args.ts";
import { runCommand } from "./ffmpeg/run.ts";
import type { HashMatchEnforcer } from "./safety/enforce.ts";
import { SUSPEND_REASON } from "./safety/enforce.ts";
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
  constructor(message: string) {
    super(message);
    this.name = "ClipUnavailableError";
  }
}

export interface ClipDeps {
  db: Database;
  storage: ObjectStorage;
  bucket: string;
  enforcer: HashMatchEnforcer;
  ffmpeg: string;
  encoder: H264Encoder;
  imageFormat: ImageFormat;
  workDir: string;
  logger: Logger;
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
  const start = new Date(clip.startedAt.getTime() + clip.startOffset * 1000);

  const scratch = await mkdtemp(join(deps.workDir, "clip-"));
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
    const { stdout: thumb } = await runCommand(
      deps.ffmpeg,
      frameArgs(out, window.durationSeconds / 2, deps.imageFormat),
      { timeoutMs: 30_000, maxStdoutBytes: 8 * 1024 * 1024 },
    );
    if (thumb.byteLength > 0) {
      const matched = await deps.enforcer.check(thumb, {
        subjectType: "clip",
        subjectId: clipId,
        channelId: clip.channelId,
      });
      if (matched) {
        await db
          .update(schema.clips)
          .set({ status: "deleted", removedReason: SUSPEND_REASON })
          .where(eq(schema.clips.id, clipId));
        return "removed";
      }
    }
    await storage.put(bucket, clipKey(clipId), await Bun.file(out).bytes(), { contentType: "video/mp4" });
    const thumbnailKey = thumb.byteLength > 0 ? clipThumbKey(clipId, deps.imageFormat) : null;
    if (thumbnailKey) await storage.put(bucket, thumbnailKey, thumb, { contentType: imageType(deps.imageFormat) });
    await db
      .update(schema.clips)
      .set({
        status: "ready",
        storageKey: clipKey(clipId),
        thumbnailKey,
        durationSeconds: Math.round(window.durationSeconds * 1000) / 1000,
        ...(vodId && !clip.vodId ? { vodId } : {}),
      })
      .where(eq(schema.clips.id, clipId));
    log.info("clip ready", { durationSeconds: window.durationSeconds, fromLiveBuffer: live !== null });
    return "ready";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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

export async function markClipFailed(db: Database, clipId: string): Promise<void> {
  await db
    .update(schema.clips)
    .set({ status: "failed" })
    .where(and(eq(schema.clips.id, clipId), eq(schema.clips.status, "processing")));
}
