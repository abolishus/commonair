// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Adaptive transcoding for one broadcast: watches the channel's viewer count and runs the
 * ffmpeg ladder only while the hysteresis says so. Renditions are advertised (Valkey key, DB
 * flag, LiveEvent) once ffmpeg actually produces output, and withdrawn when it stops or crashes.
 */
import { eq } from "drizzle-orm";
import type { Valkey } from "iovalkey";
import { KEYS, renditionPath } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import type { BroadcastInfo, MediaContext } from "../context.ts";
import { internalRtspUrl, internalSrtUrl, ladderArgs } from "../ffmpeg/args.ts";
import { Supervisor } from "../ffmpeg/supervisor.ts";
import { every, type Loop } from "../loop.ts";
import { sourceInfo } from "../mediamtx.ts";
import { TRANSCODE_STOP_FRACTION, VIEWER_FRESH_MS } from "../settings.ts";
import { initialHysteresis, stepHysteresis, type HysteresisState } from "./hysteresis.ts";
import { advertisedRenditions, selectRungs, type Rendition, type Rung } from "./ladder.ts";

/** Renditions key lifetime; refreshed every poll, so a crashed service stops advertising quickly. */
const RENDITIONS_TTL_SECONDS = 60;

/** Cached verified count if the integrity pipeline published one, else fresh heartbeats. */
export async function readViewerCount(valkey: Valkey, channelId: string, now = Date.now()): Promise<number> {
  const cached = await valkey.get(KEYS.viewerCount(channelId));
  if (cached !== null) {
    const n = Number.parseInt(cached, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return valkey.zcount(KEYS.viewers(channelId), now - VIEWER_FRESH_MS, "+inf");
}

export class TranscodeController {
  private loop: Loop | null = null;
  private state: HysteresisState = initialHysteresis();
  private ladder: Supervisor | null = null;
  private advertised: Rendition[] | null = null;
  private waiting = false;
  private readonly log;

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
    /** Height measured by the health probe, used when MediaMTX does not report one. */
    private readonly probedHeight: () => number | null = () => null,
  ) {
    this.log = ctx.logger.child({ broadcastId: b.broadcastId, worker: "transcode" });
  }

  get active(): boolean {
    return this.ladder !== null;
  }

  async start(): Promise<void> {
    // A previous process may have died while advertising; start from passthrough.
    await this.withdraw(true);
    this.loop = every(this.ctx.timings.transcodePollMs, () => this.tick(), {
      logger: this.log,
      name: "transcode",
      initialDelayMs: 0,
    });
  }

  /** True while the ladder should run but every transcode slot on this host is taken. */
  get waitingForSlot(): boolean {
    return this.waiting;
  }

  async stop(): Promise<void> {
    await this.loop?.stop();
    this.loop = null;
    this.waiting = false;
    await this.stopLadder();
    this.ctx.transcodeSlots.release(this.b.broadcastId);
  }

  async tick(now = Date.now()): Promise<void> {
    const viewers = await readViewerCount(this.ctx.valkey, this.b.channelId, now);
    const { state, action } = stepHysteresis(this.state, viewers, now, {
      threshold: this.ctx.transcodeThreshold,
      startAfterMs: this.ctx.timings.transcodeStartAfterMs,
      stopAfterMs: this.ctx.timings.transcodeStopAfterMs,
      stopFraction: TRANSCODE_STOP_FRACTION,
    });
    this.state = state;
    if (action === "stop") {
      this.log.info("viewers below hysteresis floor, stopping ladder", { viewers });
      this.waiting = false;
      await this.stopLadder();
      // Also leaves the queue when the ladder never got a slot.
      this.ctx.transcodeSlots.release(this.b.broadcastId);
    } else if (action === "start" || (this.waiting && state.active && !this.ladder)) {
      const slots = this.ctx.transcodeSlots;
      if (!slots.tryAcquire(this.b.broadcastId)) {
        // Queued: retried every poll while viewers stay high; the streamer sees a warning.
        if (!this.waiting)
          this.log.warn("transcode slots exhausted; ladder queued", {
            viewers,
            capacity: slots.capacity,
            position: slots.queuePosition(this.b.broadcastId),
          });
        this.waiting = true;
        return;
      }
      this.waiting = false;
      this.log.info("viewer threshold crossed, starting ladder", { viewers });
      if (!(await this.startLadder())) {
        slots.release(this.b.broadcastId);
        this.state = initialHysteresis();
      }
    } else if (this.advertised) {
      await this.ctx.valkey.expire(KEYS.renditions(this.b.channelId), RENDITIONS_TTL_SECONDS);
    }
  }

  private async startLadder(): Promise<boolean> {
    const path = await this.ctx.mtx.getPath(this.b.path);
    if (!path) return false;
    const info = sourceInfo(path);
    const height = info.hasVideo ? (info.height ?? this.probedHeight()) : null;
    if (info.hasVideo && height === null) {
      this.log.warn("source height unknown yet, ladder deferred");
      return false;
    }
    const rungs = selectRungs({ height, hasAudio: info.hasAudio });
    if (rungs.length === 0) {
      this.log.warn("source has no tracks to transcode");
      return false;
    }
    const { rtspBase, srtBase, internalSecret, caps, clock } = this.ctx;
    const outputFor = (r: Rung["name"]) => internalRtspUrl(rtspBase, renditionPath(this.b.slug, r), internalSecret);
    const renditions = advertisedRenditions(rungs);
    this.ladder = new Supervisor({
      name: `ladder:${this.b.slug}`,
      binary: this.ctx.ffmpeg,
      // A fresh W0 for every (re)start; without one the start fails and is retried with backoff
      // (an unanchored rung would be seconds off under useAbsoluteTimestamp). ADR 0012 A2.
      args: async () => {
        const input = internalSrtUrl(srtBase, this.b.path, internalSecret);
        const w0Ms = await clock.w0(this.b.broadcastId, this.b.path, "ladder");
        return ladderArgs({ input, w0Ms, outputFor, rungs, encoder: caps.encoder });
      },
      secrets: [internalSecret],
      logger: this.log,
      onProgress: (p) => {
        if (!this.advertised && p.frame !== null && p.frame > 0) void this.advertise(renditions);
      },
      onExit: () => {
        if (this.advertised) void this.withdraw(false);
      },
    });
    this.ladder.start();
    return true;
  }

  private async stopLadder(): Promise<void> {
    const ladder = this.ladder;
    this.ladder = null;
    if (!ladder) return;
    await ladder.stop();
    this.ctx.transcodeSlots.release(this.b.broadcastId);
    await this.withdraw(false);
  }

  private async advertise(renditions: Rendition[]): Promise<void> {
    this.advertised = renditions;
    try {
      await this.ctx.valkey.set(
        KEYS.renditions(this.b.channelId),
        JSON.stringify(renditions),
        "EX",
        RENDITIONS_TTL_SECONDS,
      );
      await this.ctx.db
        .update(schema.broadcasts)
        .set({ transcodeActive: true })
        .where(eq(schema.broadcasts.id, this.b.broadcastId));
      await this.publish(renditions);
      this.log.info("renditions live", { renditions });
    } catch {
      this.log.warn("could not advertise renditions", { errorCode: "RENDITIONS_ADVERTISE_FAILED" });
    }
  }

  private async withdraw(silent: boolean): Promise<void> {
    const was = this.advertised;
    this.advertised = null;
    try {
      await this.ctx.valkey.del(KEYS.renditions(this.b.channelId));
      await this.ctx.db
        .update(schema.broadcasts)
        .set({ transcodeActive: false })
        .where(eq(schema.broadcasts.id, this.b.broadcastId));
      if (!silent && was) await this.publish(["source"]);
    } catch {
      this.log.warn("could not withdraw renditions", { errorCode: "RENDITIONS_WITHDRAW_FAILED" });
    }
  }

  private publish(renditions: Rendition[]): Promise<void> {
    return this.ctx.publishLive({
      type: "renditions",
      channelId: this.b.channelId,
      broadcastId: this.b.broadcastId,
      renditions,
      at: new Date().toISOString(),
    });
  }
}
