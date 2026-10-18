// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-broadcast health: every few seconds the MediaMTX byte counter gives the ingest bitrate
 * and accrues live seconds; every 30 s an ffprobe of the source measures codec, resolution,
 * frame rate and keyframe spacing. Each poll writes one `broadcast_health_samples` row.
 */
import { schema } from "@commonair/db";
import type { BroadcastInfo, MediaContext } from "../context.ts";
import { internalRtspUrl } from "../ffmpeg/args.ts";
import { probeSource, type ProbeResult } from "../ffmpeg/probe.ts";
import { every, type Loop } from "../loop.ts";
import { isLive, pathBytes, type MtxPath } from "../mediamtx.ts";
import { addLiveSeconds, LiveTimeAccumulator } from "./hours.ts";
import { bitrateKbps, droppedFrames, healthWarnings, type Warning } from "./rules.ts";

export class HealthSampler {
  private loops: Loop[] = [];
  private last: { bytes: number; framesInError: number | null; at: number } | null = null;
  private probe: ProbeResult | null = null;
  private probing: Promise<void> | null = null;
  private sourceType: string | null = null;
  private readonly hours = new LiveTimeAccumulator();
  /** Latest MediaMTX view of the path, shared with the transcode controller. */
  latestPath: MtxPath | null = null;

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
    /** Server-side conditions (transcode queue, disk budget) reported alongside source health. */
    private readonly serverWarnings: () => Warning[] = () => [],
  ) {}

  get latestProbe(): ProbeResult | null {
    return this.probe;
  }

  start(): void {
    const { timings, logger } = this.ctx;
    const log = logger.child({ broadcastId: this.b.broadcastId, worker: "health" });
    this.loops.push(
      every(timings.healthSampleMs, () => this.sample(), { logger: log, name: "health-sample", initialDelayMs: 0 }),
      every(timings.probeIntervalMs, () => this.runProbe(), { logger: log, name: "probe", initialDelayMs: 1_000 }),
    );
  }

  async stop(): Promise<void> {
    await Promise.all(this.loops.map((l) => l.stop()));
    this.loops = [];
    await this.probing?.catch(() => {});
    await this.flushHours();
  }

  private async runProbe(): Promise<void> {
    if (this.probing) return;
    const { rtspBase, internalSecret, timings, ffprobe } = this.ctx;
    this.probing = probeSource(internalRtspUrl(rtspBase, this.b.path, internalSecret), timings.probeWindowSeconds, {
      secrets: [internalSecret],
      ffprobe,
    })
      .then((p) => {
        this.probe = p;
      })
      .finally(() => {
        this.probing = null;
      });
    await this.probing;
  }

  async sample(now = Date.now()): Promise<void> {
    const path = await this.ctx.mtx.getPath(this.b.path);
    this.latestPath = path;
    if (!path || !isLive(path)) {
      this.last = null;
      return;
    }
    this.sourceType = path.source?.type ?? null;
    const bytes = pathBytes(path);
    const framesInError = path.inboundFramesInError ?? null;
    const prev = this.last;
    this.last = { bytes, framesInError, at: now };
    if (!prev) return;

    this.hours.add(prev.at, now);
    const kbps = bitrateKbps(prev.bytes, prev.at, bytes, now);
    if (kbps === null) return;
    const probe = this.probe;
    const warnings = [
      ...healthWarnings({ bitrateKbps: kbps, sourceType: this.sourceType, probe }),
      ...this.serverWarnings(),
    ];
    const errDelta = framesInError !== null && prev.framesInError !== null ? framesInError - prev.framesInError : null;
    await this.ctx.db
      .insert(schema.broadcastHealthSamples)
      .values({
        broadcastId: this.b.broadcastId,
        at: new Date(now),
        bitrateKbps: kbps,
        fps: probe?.measuredFps ?? null,
        width: probe?.width ?? null,
        height: probe?.height ?? null,
        videoCodec: probe?.videoCodec ?? null,
        audioCodec: probe?.audioCodec ?? null,
        keyframeIntervalMs: probe?.keyframeIntervalMs ?? null,
        droppedFrames: droppedFrames({ framesInErrorDelta: errDelta, probe, intervalSeconds: (now - prev.at) / 1000 }),
        warnings,
      })
      .onConflictDoNothing();
    await this.flushHours();
  }

  private async flushHours(): Promise<void> {
    const rows = this.hours.take();
    try {
      await addLiveSeconds(this.ctx.db, this.b.broadcastId, this.b.channelId, rows);
    } catch (err) {
      this.hours.restore(rows);
      throw err;
    }
  }
}
