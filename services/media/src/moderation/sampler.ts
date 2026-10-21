// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live moderation sampling for one broadcast: the first frame right after the session starts
 * (well within STREAM_START_SAMPLE_SECONDS of publish), then one frame every effective sample
 * interval (re-read before each wait), independent of the 60 s thumbnail. Samples are scheduled
 * from the start of the previous one, so a slow capture does not stretch the cadence. A failed
 * capture is retried sooner (CAPTURE_RETRY_MS). Nothing is stored for an unflagged frame.
 */
import { MODERATION_CONSTANTS, type DecodedFrame } from "@commonair/moderation";
import type { Logger } from "@commonair/observability";
import { internalRtspUrl } from "../ffmpeg/args.ts";
import { runCommand } from "../ffmpeg/run.ts";
import { errorCategory } from "./logging.ts";
import type { LiveTarget } from "./moderation.ts";

/** Retry delay after a failed capture (the source may still be waiting for its first keyframe). */
export const CAPTURE_RETRY_MS = 1_000;

export interface SamplerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: SamplerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SamplerDeps {
  /** One frame of the live source at both moderation sizes. */
  capture: () => Promise<DecodedFrame>;
  /** PDQ, match and classifier hand-off; "matched" ends sampling (the broadcast is being ended). */
  scan: (frame: DecodedFrame, capturedAt: Date) => Promise<"clean" | "matched">;
  /** The effective interval in seconds (min of env and setting). */
  intervalSeconds: () => Promise<number>;
  /** Called on every failed capture (metrics). */
  onCaptureFailed?: () => void;
  logger: Logger;
  clock?: SamplerClock;
}

export class LiveSampler {
  private timer: unknown = null;
  private current: Promise<void> = Promise.resolve();
  private stopped = false;
  private consecutiveFailures = 0;
  private readonly clock: SamplerClock;

  constructor(private readonly deps: SamplerDeps) {
    this.clock = deps.clock ?? realClock;
  }

  start(): void {
    // The first frame at once: ffmpeg waits for the next keyframe, which is within the GOP.
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.current = this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const started = this.clock.now();
    let next: number;
    try {
      const frame = await this.deps.capture();
      this.consecutiveFailures = 0;
      const result = await this.deps.scan(frame, new Date(started));
      if (result === "matched") {
        this.stopped = true;
        return;
      }
      const interval = (await this.deps.intervalSeconds()) * 1000;
      next = Math.max(0, started + interval - this.clock.now());
    } catch (err) {
      this.consecutiveFailures++;
      this.deps.onCaptureFailed?.();
      const fields = { failures: this.consecutiveFailures, error: errorCategory(err) };
      // Ids are in the child logger; the error message may carry the source URL, so only its name.
      if (this.consecutiveFailures % 10 === 0) this.deps.logger.error("moderation sampling keeps failing", fields);
      else this.deps.logger.warn("moderation sample failed", fields);
      const interval = await this.deps.intervalSeconds().catch(() => MODERATION_CONSTANTS.STREAM_START_SAMPLE_SECONDS);
      next = Math.min(interval * 1000, CAPTURE_RETRY_MS);
    }
    this.schedule(next);
  }
}

/** Readers of the live source use the same conventions as the thumbnailer: TCP, bounded waits. */
const BASE = ["-hide_banner", "-nostdin", "-loglevel", "warning"];
const RTSP_IN = ["-rtsp_transport", "tcp", "-timeout", "10000000"];
/** Bound the PNG size; `decodeImage` scales to the moderation sizes. */
const CAPTURE_FILTER = "scale=w=1024:h=1024:force_original_aspect_ratio=decrease";

/** One live frame as a lossless PNG on stdout. */
export function liveFrameArgs(input: string): string[] {
  return [
    ...BASE,
    ...RTSP_IN,
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    CAPTURE_FILTER,
    "-c:v",
    "png",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}

/**
 * One ffmpeg reader per sample: a single frame from the internal RTSP source, decoded by
 * `@commonair/moderation` to raw luma 512² and RGB 384² of the same frame.
 */
export function liveCapture(opts: {
  ffmpeg: string;
  rtspBase: string;
  internalSecret: string;
  target: LiveTarget;
  decode: (png: Uint8Array) => Promise<DecodedFrame>;
}): () => Promise<DecodedFrame> {
  const url = internalRtspUrl(opts.rtspBase, opts.target.path, opts.internalSecret);
  return async () => {
    const { stdout } = await runCommand(opts.ffmpeg, liveFrameArgs(url), {
      timeoutMs: 15_000,
      secrets: [opts.internalSecret],
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    if (stdout.byteLength === 0) throw new Error("ffmpeg produced no frame");
    return opts.decode(stdout);
  };
}
