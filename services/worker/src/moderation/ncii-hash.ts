// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `moderation.ncii-hash`: after staff decided an NCII request `removed` (the API already
 * unpublished every resolved subject), PDQ-hash the removed content into `local_hash_list` as
 * `ncii` so re-uploads match T0, and only then delete the objects (e4c spec "NCII decision").
 * VODs are sampled every effective sample interval, clips every second, upload images once; frames
 * below PDQ_MIN_QUALITY are skipped. Objects are looked up at their public key and, for requests
 * auto-hidden earlier, under the private hidden prefix. Idempotent: an item with `removed_at`
 * is done; hashes insert with ON CONFLICT DO NOTHING.
 */
import type { NciiHashJob } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { decodeImage, MODERATION_CONSTANTS, pdqHash, sampleVideoFrames } from "@commonair/moderation";
import type { ObjectStorage } from "@commonair/storage";
import { and, eq, isNull } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { nciiHiddenKey, readObject, vodPrefix } from "./objects.ts";
import { audit } from "./records.ts";
import { mediaStorage, moderationRuntime } from "./runtime.ts";
import { sampleSeconds } from "./settings.ts";

const { nciiRequests: requests, nciiRequestItems: items, clips, localHashList } = schema;
const LUMA = MODERATION_CONSTANTS.PDQ_LUMA_SIZE;

export function selectVodPlaylist(keys: readonly string[]): string {
  const playlist = keys.find((k) => k.endsWith("/index.m3u8")) ?? keys.find((k) => k.endsWith(".m3u8"));
  if (!playlist) throw new Error("NCII VOD playlist missing; retain source objects for retry");
  return playlist;
}

/** Keep only usable hashes, deduplicated. Pure. */
export function usableHashes(hashes: readonly { hash: string; quality: number }[]): string[] {
  return [...new Set(hashes.filter((h) => h.quality >= MODERATION_CONSTANTS.PDQ_MIN_QUALITY).map((h) => h.hash))];
}

/** Objects under `prefix`, or under its hidden copy when the public one is gone. */
async function listWithFallback(storage: ObjectStorage, bucket: string, prefix: string) {
  const keys: string[] = [];
  for await (const o of storage.list(bucket, prefix)) keys.push(o.key);
  if (keys.length > 0) return { base: prefix, keys };
  const hidden = nciiHiddenKey(prefix);
  for await (const o of storage.list(bucket, hidden)) keys.push(o.key);
  return { base: hidden, keys };
}

async function readWithFallback(storage: ObjectStorage, bucket: string, key: string) {
  const direct = await readObject(storage, bucket, key);
  if (direct) return { key, bytes: direct };
  const hidden = nciiHiddenKey(key);
  const h = await readObject(storage, bucket, hidden);
  return h ? { key: hidden, bytes: h } : null;
}

async function hashVideo(ctx: WorkerContext, file: string, everySeconds: number) {
  const rt = moderationRuntime(ctx);
  const out: { hash: string; quality: number }[] = [];
  for await (const f of sampleVideoFrames(file, { everySeconds, ffmpegPath: rt.ffmpegPath }))
    out.push(pdqHash(f.luma, LUMA, LUMA));
  return out;
}

interface ItemResult {
  hashes: string[];
  deleteKeys: string[];
}

async function hashVod(ctx: WorkerContext, vodId: string, every: number, work: string): Promise<ItemResult> {
  const storage = mediaStorage(ctx);
  const { base, keys } = await listWithFallback(storage, ctx.mediaBucket, vodPrefix(vodId));
  if (keys.length === 0) return { hashes: [], deleteKeys: [] };
  const dir = join(work, vodId);
  // One object at a time to disk: a whole VOD is never held in memory.
  for (const k of keys) {
    const bytes = await readObject(storage, ctx.mediaBucket, k);
    if (!bytes) continue;
    const path = join(dir, k.slice(base.length));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  const playlist = selectVodPlaylist(keys);
  const hashes = await hashVideo(ctx, join(dir, playlist.slice(base.length)), every);
  return { hashes: usableHashes(hashes), deleteKeys: keys };
}

async function hashClip(ctx: WorkerContext, clipId: string, work: string): Promise<ItemResult> {
  const storage = mediaStorage(ctx);
  const [c] = await ctx.db
    .select({ s: clips.storageKey, t: clips.thumbnailKey })
    .from(clips)
    .where(eq(clips.id, clipId));
  const deleteKeys: string[] = [];
  let hashes: { hash: string; quality: number }[] = [];
  if (c?.s) {
    const obj = await readWithFallback(storage, ctx.mediaBucket, c.s);
    if (obj) {
      const file = join(work, `${clipId}.mp4`);
      await writeFile(file, obj.bytes);
      hashes = await hashVideo(ctx, file, 1);
      deleteKeys.push(obj.key);
    }
  }
  if (c?.t) {
    const thumb = await readWithFallback(storage, ctx.mediaBucket, c.t);
    if (thumb) deleteKeys.push(thumb.key);
  }
  return { hashes: usableHashes(hashes), deleteKeys };
}

async function hashUpload(ctx: WorkerContext, key: string): Promise<ItemResult> {
  const rt = moderationRuntime(ctx);
  const obj = await readWithFallback(mediaStorage(ctx), ctx.mediaBucket, key);
  if (!obj) return { hashes: [], deleteKeys: [] };
  const d = await decodeImage(obj.bytes, { ffmpegPath: rt.ffmpegPath });
  return { hashes: usableHashes([pdqHash(d.luma, LUMA, LUMA)]), deleteKeys: [obj.key] };
}

export async function hashRemovedContent(ctx: WorkerContext, job: NciiHashJob) {
  const rt = moderationRuntime(ctx);
  const storage = mediaStorage(ctx);
  const [req] = await ctx.db.select().from(requests).where(eq(requests.id, job.requestId));
  if (!req || req.status !== "removed") {
    ctx.logger.warn("ncii-hash: request is not removed; nothing to do", { requestId: job.requestId });
    return { items: 0, hashes: 0, deleted: 0 };
  }
  const every = await sampleSeconds(ctx, ctx.db, rt.envSampleSeconds);
  const pending = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.requestId, req.id), isNull(items.removedAt)));
  const work = await mkdtemp(join(tmpdir(), "commonair-ncii-"));
  let hashed = 0;
  let deleted = 0;
  let done = 0;
  try {
    for (const i of pending) {
      let r: ItemResult = { hashes: [], deleteKeys: [] };
      if (i.subjectType === "vod" && i.subjectId) r = await hashVod(ctx, i.subjectId, every, work);
      else if (i.subjectType === "clip" && i.subjectId) r = await hashClip(ctx, i.subjectId, work);
      else if (i.subjectType === "upload" && i.uploadKey) r = await hashUpload(ctx, i.uploadKey);
      else if (i.subjectType === null) continue; // not on this instance: nothing to hash
      const now = ctx.now();
      // Hashes are committed before any object is deleted; a crash in between re-hashes next time.
      await ctx.db.transaction(async (tx) => {
        if (r.hashes.length > 0) {
          const rows = await tx
            .insert(localHashList)
            .values(
              r.hashes.map((pdq) => ({
                id: uuidv7(now.getTime()),
                category: "ncii" as const,
                pdq,
                sourceType: "ncii_request",
                sourceId: req.id,
                addedById: req.decidedById,
                createdAt: now,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: localHashList.id });
          hashed += rows.length;
        }
      });
      for (const k of r.deleteKeys) {
        await storage.delete(ctx.mediaBucket, k);
        deleted++;
      }
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(items)
          .set({ removedAt: now })
          .where(and(eq(items.id, i.id), isNull(items.removedAt)));
        await audit(
          tx,
          {
            action: "ncii.hash_removed",
            subjectType: "ncii_request",
            subjectId: req.id,
            reason: "ncii_removed",
            details: {
              requestId: req.id,
              itemId: i.id,
              subjectType: i.subjectType,
              subjectId: i.subjectId,
              hashes: r.hashes.length,
              objectsDeleted: r.deleteKeys.length,
              sampleSeconds: every,
            },
          },
          now,
        );
      });
      done++;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  moderationMetrics.actions.add(done, { kind: "ncii_hash" });
  ctx.logger.info("NCII content hashed and removed", { requestId: req.id, items: done, hashes: hashed, deleted });
  return { items: done, hashes: hashed, deleted };
}
