// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A 640×360 frame of each live broadcast every 60 s: PDQ-checked against the hash lists first (a
 * match is handled as T0 live and nothing is written), then stored as
 * `thumbnails/<broadcastId>/latest.<ext>` (stable URL) and a timestamped copy (cache-busting key
 * written to `broadcasts.thumbnailKey`, and history for moderation review). Only the newest
 * `timings.thumbnailHistory` stamped copies are kept; older ones are deleted after each capture.
 */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { ObjectStorage } from "@commonair/storage";
import type { BroadcastInfo, MediaContext } from "./context.ts";
import { internalRtspUrl, thumbnailArgs } from "./ffmpeg/args.ts";
import { runCommand } from "./ffmpeg/run.ts";
import { every, type Loop } from "./loop.ts";
import { imageExt, imageType } from "./vod/finalize.ts";

export const thumbnailPrefix = (broadcastId: string) => `thumbnails/${broadcastId}/`;

export class Thumbnailer {
  private loop: Loop | null = null;
  private readonly log;

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
  ) {
    this.log = ctx.logger.child({ broadcastId: b.broadcastId, worker: "thumbnails" });
  }

  start(): void {
    const { timings } = this.ctx;
    this.loop = every(timings.thumbnailIntervalMs, async () => void (await this.capture()), {
      logger: this.log,
      name: "thumbnail",
      initialDelayMs: timings.thumbnailFirstDelayMs,
    });
  }

  async stop(): Promise<void> {
    await this.loop?.stop();
    this.loop = null;
  }

  /** Returns false when the frame matched the hash list (and the broadcast is being ended). */
  async capture(now = new Date()): Promise<boolean> {
    const { rtspBase, internalSecret, caps, storage, bucket, ffmpeg } = this.ctx;
    const { stdout: image } = await runCommand(
      ffmpeg,
      thumbnailArgs(internalRtspUrl(rtspBase, this.b.path, internalSecret), caps.imageFormat),
      { timeoutMs: 20_000, secrets: [internalSecret], maxStdoutBytes: 8 * 1024 * 1024 },
    );
    if (image.byteLength === 0) throw new Error("ffmpeg produced an empty thumbnail");
    const matched = await this.ctx.moderation.checkLiveThumbnail(
      { broadcastId: this.b.broadcastId, channelId: this.b.channelId, path: this.b.path },
      image,
      imageType(caps.imageFormat),
    );
    if (matched) return false;
    const ext = imageExt(caps.imageFormat);
    const prefix = thumbnailPrefix(this.b.broadcastId);
    const stamped = `${prefix}${now.getTime()}.${ext}`;
    const type = imageType(caps.imageFormat);
    await storage.put(bucket, stamped, image, {
      contentType: type,
      cacheControl: "public, max-age=31536000, immutable",
    });
    await storage.put(bucket, `${prefix}latest.${ext}`, image, {
      contentType: type,
      cacheControl: "public, max-age=30",
    });
    await this.ctx.db
      .update(schema.broadcasts)
      .set({ thumbnailKey: stamped })
      .where(eq(schema.broadcasts.id, this.b.broadcastId));
    try {
      await pruneThumbnails(storage, bucket, this.b.broadcastId, this.ctx.timings.thumbnailHistory);
    } catch (err) {
      // History grows by one per minute; the next capture tries again.
      this.log.warn("thumbnail history cleanup failed", { err });
    }
    return true;
  }
}

const STAMPED = /\/(\d+)\.(webp|jpg)$/;

/**
 * Pure: timestamped history keys beyond the newest `keep` (at least one is always kept, since
 * `broadcasts.thumbnailKey` points at the newest). `latest.<ext>` and foreign keys are ignored.
 */
export function thumbnailsToDelete(keys: readonly string[], keep: number): string[] {
  const stamped = keys
    .map((k) => ({ k, m: STAMPED.exec(k) }))
    .filter((x): x is { k: string; m: RegExpExecArray } => x.m !== null)
    .map(({ k, m }) => ({ k, t: Number(m[1]) }))
    .sort((a, b) => b.t - a.t || b.k.localeCompare(a.k));
  return stamped.slice(Math.max(1, keep)).map((x) => x.k);
}

/** Delete a broadcast's thumbnail history beyond the newest `keep`. Returns how many went. */
export async function pruneThumbnails(
  storage: ObjectStorage,
  bucket: string,
  broadcastId: string,
  keep: number,
): Promise<number> {
  const keys: string[] = [];
  for await (const o of storage.list(bucket, thumbnailPrefix(broadcastId))) keys.push(o.key);
  const doomed = thumbnailsToDelete(keys, keep);
  for (const k of doomed) await storage.delete(bucket, k);
  return doomed.length;
}
