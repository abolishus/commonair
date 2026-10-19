// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** All media work for one live broadcast, started on `online` and stopped on `offline`. */
import type { BroadcastInfo, MediaContext } from "./context.ts";
import { WARNINGS, type Warning } from "./health/rules.ts";
import { HealthSampler } from "./health/sampler.ts";
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
  }

  async start(): Promise<void> {
    this.log.info("broadcast session starting", { vod: this.vodId !== null });
    // Each part is independent: a failing simulcast target must not stop recording.
    this.sampler.start();
    this.thumbnails.start();
    await Promise.all([
      this.guard("transcode", () => this.transcode.start()),
      this.guard("simulcast", () => this.simulcast.start()),
      this.guard("recorder", () => this.recorder.start()),
    ]);
  }

  /** `final`: the broadcast ended (finalize the VOD). Otherwise the service is shutting down. */
  stop(final: boolean, finalizeVod = final): Promise<void> {
    this.stopped ??= (async () => {
      await Promise.all([
        this.guard("thumbnails", () => this.thumbnails.stop()),
        this.guard("transcode", () => this.transcode.stop()),
        this.guard("simulcast", () => this.simulcast.stop()),
        this.guard("health", () => this.sampler.stop()),
        this.guard("recorder", () => this.recorder.stop(final)),
      ]);
      if (finalizeVod && this.vodId) {
        const vodId = this.vodId;
        await this.guard("vod-finalize enqueue", () => this.ctx.enqueueVodFinalize(vodId));
      }
      this.log.info("broadcast session stopped", { final });
    })();
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

  private async guard(part: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error("broadcast worker failed", { part, err });
    }
  }
}
