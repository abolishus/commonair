// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `QUEUES.vodFinalize` consumer: after a broadcast ends, close the VOD playlist
 * (`#EXT-X-ENDLIST`), hash-check sampled frames, record duration/size, mark it `ready` and set
 * its expiry from the channel's retention. Idempotent: a finished VOD is left alone.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import { frameArgs, type ImageFormat } from "../ffmpeg/args.ts";
import { runCommand } from "../ffmpeg/run.ts";
import type { HashMatchEnforcer } from "../safety/enforce.ts";
import { broadcastTainted, quarantineVod } from "../safety/quarantine.ts";
import { assembleFromStorage } from "./assemble.ts";
import { parsePlaylist, renderPlaylist, totalDuration, type PlaylistSegment } from "./playlist.ts";
import { VOD_PLAYLIST, vodPrefix } from "./recorder.ts";

export const VodFinalizeJob = z.object({ vodId: z.uuid() });
export type VodFinalizeJob = z.infer<typeof VodFinalizeJob>;

export interface FinalizeDeps {
  db: Database;
  storage: ObjectStorage;
  bucket: string;
  enforcer: HashMatchEnforcer;
  ffmpeg: string;
  imageFormat: ImageFormat;
  workDir: string;
  logger: Logger;
  now?: () => Date;
}

const DAY_MS = 86_400_000;
export const imageExt = (f: ImageFormat) => (f === "webp" ? "webp" : "jpg");
export const imageType = (f: ImageFormat) => (f === "webp" ? "image/webp" : "image/jpeg");

/** Up to `n` segment indexes spread over the recording (first, middle, last …). */
export function sampleIndexes(count: number, n = 3): number[] {
  if (count <= 0) return [];
  if (count <= n) return [...Array(count).keys()];
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round((i * (count - 1)) / (n - 1)));
  return [...out];
}

export async function finalizeVod(
  deps: FinalizeDeps,
  vodId: string,
): Promise<"ready" | "failed" | "removed" | "skipped"> {
  const { db, storage, bucket, logger } = deps;
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
  // Never publish anything from a broadcast with a hash match (the match may have been found live,
  // before or while this job was queued).
  if (deps.enforcer.isTainted(vod.broadcastId) || (await broadcastTainted(db, vod.broadcastId))) {
    log.warn("refusing to publish VOD of a broadcast with a hash match; quarantining");
    await quarantineVod(deps, vodId, vod.broadcastId);
    return "removed";
  }
  await db.update(schema.vods).set({ status: "processing" }).where(eq(schema.vods.id, vodId));

  const prefix = vodPrefix(vodId);
  const res = await storage.get(bucket, prefix + VOD_PLAYLIST);
  const segments = res ? parsePlaylist(await res.text()).segments : [];
  if (segments.length === 0) {
    log.warn("VOD has no segments; marking failed");
    await db.update(schema.vods).set({ status: "failed" }).where(eq(schema.vods.id, vodId));
    return "failed";
  }

  const scratch = await mkdtemp(join(deps.workDir, "vod-"));
  let thumbnail: Uint8Array<ArrayBuffer> | null = null;
  try {
    for (const idx of sampleIndexes(segments.length)) {
      const image = await sampleFrame(deps, prefix, segments[idx] as PlaylistSegment, scratch, idx);
      if (!image) continue;
      const matched = await deps.enforcer.check(image, {
        subjectType: "vod",
        subjectId: vodId,
        channelId: vod.channelId,
        broadcastId: vod.broadcastId,
      });
      if (matched) {
        // The enforcer quarantines the whole broadcast too; do this VOD now so it is never published.
        await quarantineVod(deps, vodId, vod.broadcastId);
        return "removed";
      }
      // The middle sample doubles as the VOD's thumbnail.
      if (thumbnail === null || idx === Math.floor(segments.length / 2)) thumbnail = image;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  await storage.put(bucket, prefix + VOD_PLAYLIST, renderPlaylist(segments, { ended: true }), {
    contentType: "application/vnd.apple.mpegurl",
    cacheControl: "public, max-age=3600",
  });
  let thumbnailKey: string | null = null;
  if (thumbnail) {
    thumbnailKey = `${prefix}thumbnail.${imageExt(deps.imageFormat)}`;
    await storage.put(bucket, thumbnailKey, thumbnail, { contentType: imageType(deps.imageFormat) });
  }
  let size = 0;
  for await (const obj of storage.list(bucket, prefix)) size += obj.size;
  const now = deps.now?.() ?? new Date();
  await db
    .update(schema.vods)
    .set({
      status: "ready",
      durationSeconds: totalDuration(segments),
      sizeBytes: size,
      expiresAt: new Date(now.getTime() + vod.retentionDays * DAY_MS),
      ...(thumbnailKey ? { thumbnailKey } : {}),
    })
    .where(eq(schema.vods.id, vodId));
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
    // An undecodable segment cannot be checked, and must not block the VOD forever; the
    // thumbnails taken while live were checked already.
    deps.logger.warn("could not sample VOD frame", { err, segment: seg.uri });
    return null;
  }
}
