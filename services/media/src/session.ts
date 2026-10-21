// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** All media work for one live broadcast, started on `online` and stopped on `offline`. */
import type { BroadcastInfo, MediaContext } from "./context.ts";
import { WARNINGS, type Warning } from "./health/rules.ts";
import { errorCategory } from "./moderation/logging.ts";
import { HealthSampler } from "./health/sampler.ts";
import { LiveSampler, liveCapture } from "./moderation/sampler.ts";
import { SimulcastManager } from "./simulcast.ts";
import { Thumbnailer } from "./thumbnails.ts";
import { TranscodeController } from "./transcode/controller.ts";
import { SegmentRecorder, type LocalWindow } from "./vod/recorder.ts";

export class BroadcastSession {
  readonly sampler: HealthSampler;
  readonly transcode: TranscodeController;
  private readonly simulcast: SimulcastManager;
  private readonly recorder: SegmentRecorder;
  private readonly thumbnails: Thumbnailer;
  /** Moderation frames (PDQ in media, classifier in the worker). Always runs. */
  private readonly frames: LiveSampler;
  private stopped: Promise<void> | null = null;
  private readonly log;

  constructor(
    private readonly ctx: MediaContext,
    readonly info: BroadcastInfo,
    readonly vodId: string | null,
  ) {
    this.log = ctx.logger.child({ broadcastId: info.broadcastId, channelId: info.channelId });
    this.sampler = new HealthSampler(ctx, info, () => this.serverWarnings());
    this.transcode = new TranscodeController(ctx, info, () => this.sampler.latestProbe?.height ?? null);
    this.simulcast = new SimulcastManager(ctx, info);
    this.recorder = new SegmentRecorder(ctx, info, vodId);
    this.thumbnails = new Thumbnailer(ctx, info);
    const target = { broadcastId: info.broadcastId, channelId: info.channelId, path: info.path };
    const { moderation } = ctx;
    this.frames = new LiveSampler({
      capture: liveCapture({
        ffmpeg: ctx.ffmpeg,
        rtspBase: ctx.rtspBase,
        internalSecret: ctx.internalSecret,
        target,
        decode: (png) => moderation.decode(png),
      }),
      scan: (frame, at) => moderation.scanLiveFrame(target, frame, at),
      intervalSeconds: () => moderation.sampleSeconds(),
      onCaptureFailed: () => moderation.captureFailed(),
      logger: this.log.child({ worker: "moderation" }),
    });
  }

  async start(): Promise<void> {
    this.log.info("broadcast session starting", { vod: this.vodId !== null });
    // Each part is independent: a failing simulcast target must not stop recording.
    this.frames.start();
    this.sampler.start();
    this.thumbnails.start();
    await Promise.all([
      this.guard("transcode", () => this.transcode.start()),
      this.guard("simulcast", () => this.simulcast.start()),
      this.guard("recorder", () => this.recorder.start()),
    ]);
  }

  /** `final`: the broadcast ended (finalize the VOD). Otherwise the service is shutting down. */
  stop(final: boolean, finalizeVod = final, strict = false): Promise<void> {
    if (this.stopped) {
      return strict ? this.stopped.then(() => this.recorder.stop(final, true)) : this.stopped;
    }
    if (!this.stopped) {
      const stopping = (async () => {
        await Promise.all([
          this.guard("moderation", () => this.frames.stop(), strict),
          this.guard("thumbnails", () => this.thumbnails.stop(), strict),
          this.guard("transcode", () => this.transcode.stop(), strict),
          this.guard("simulcast", () => this.simulcast.stop(), strict),
          this.guard("health", () => this.sampler.stop(), strict),
          this.guard("recorder", () => this.recorder.stop(final, strict), strict),
        ]);
        if (finalizeVod && this.vodId) {
          const vodId = this.vodId;
          await this.guard("vod-finalize enqueue", () => this.ctx.enqueueVodFinalize(vodId));
        }
        this.log.info("broadcast session stopped", { final });
      })();
      this.stopped = stopping.catch((err: unknown) => {
        this.stopped = null;
        throw err;
      });
    }
    return this.stopped;
  }

  serverWarnings(): Warning[] {
    const w: Warning[] = [];
    if (this.transcode.waitingForSlot) w.push(WARNINGS.transcodeCapacity);
    if (this.recorder.diskRefused) w.push(WARNINGS.recordingDiskBudget);
    return w;
  }

  liveWindow(start: Date, durationSeconds: number): LocalWindow | null {
    return this.recorder.localWindow(start, durationSeconds);
  }

  private async guard(part: string, fn: () => Promise<void>, rethrow = false): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error("broadcast worker failed", { part, error: errorCategory(err) });
      if (rethrow) throw err;
    }
  }
}
