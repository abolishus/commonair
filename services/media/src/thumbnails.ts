// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A 640×360 frame of each live broadcast every 60 s: hash-checked first, then stored as
 * `thumbnails/<broadcastId>/latest.<ext>` (stable URL) and a timestamped copy (cache-busting key
 * written to `broadcasts.thumbnailKey`, and history for moderation review).
 */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
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
    const matched = await this.ctx.enforcer.check(image, {
      subjectType: "broadcast",
      subjectId: this.b.broadcastId,
      channelId: this.b.channelId,
      broadcastId: this.b.broadcastId,
      path: this.b.path,
    });
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
    return true;
  }
}
