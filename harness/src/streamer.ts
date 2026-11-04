// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulated streamer: ffmpeg publishing `testsrc2` + a sine tone with the machine-readable
 * timestamp strip (and a wall-clock timecode when the local ffmpeg has `drawtext`) over RTMP or
 * WHIP. Supervised: `stop()` always ends the process, and the harness kills strays on exit.
 */
import type { Logger } from "@commonair/observability";
import {
  type EncoderMode,
  type FfmpegProgress,
  type IngestProtocol,
  ProgressParser,
  buildStreamerArgs,
  probeFfmpeg,
  whipFfmpeg,
} from "./ffmpeg.ts";
import { type Supervised, spawnSupervised } from "./process.ts";
import { sleep, withTimeout } from "./wait.ts";

export interface StreamerOptions {
  protocol: IngestProtocol;
  /** RTMP: full publish URL including `?key=`. WHIP: the endpoint URL. */
  url: string;
  /** WHIP only: the stream key secret, sent as `Authorization: Bearer`. */
  bearer?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  keyframeIntervalSeconds?: number;
  durationSeconds?: number;
  mode?: EncoderMode;
  /** `auto` burns a timecode when drawtext is available. */
  timecode?: boolean | "auto";
  toneHz?: number;
  name?: string;
  log?: Logger;
  /** How long `start()` waits for the first encoded frames. */
  startTimeoutMs?: number;
  /** Publishes `start()` makes when ingest refuses one at connect (see `ingestRefusal`); default 3. */
  startAttempts?: number;
}

export const STREAMER_DEFAULTS = {
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 2500,
  keyframeIntervalSeconds: 2,
} as const;

export interface StreamerStats {
  frames: number;
  fps: number;
  bitrateKbps: number | null;
  outTimeMs: number;
  dropFrames: number;
  speed: number | null;
}

export class StreamerError extends Error {
  constructor(
    message: string,
    public readonly stderr: string[],
    /** ffmpeg's exit code when it exited before publishing; null when it timed out instead. */
    public readonly exitCode: number | null = null,
  ) {
    super(`${message}${stderr.length ? `\n  ffmpeg: ${stderr.slice(-8).join("\n  ffmpeg: ")}` : ""}`);
    this.name = "StreamerError";
  }
}

/**
 * Why ingest refused or dropped a publish at connect, from ffmpeg's stderr; null for any other
 * failure (encoder, filters, fonts). MediaMTX answers a failed auth hook the same way as a wrong
 * key: when its call to the API fails (CI runs saw Podman's DNS stall on `api`), ffmpeg reads
 * "authentication failed", or an I/O error once the hook times out.
 */
export function ingestRefusal(stderr: readonly string[]): string | null {
  for (const line of stderr) if (/Server error: authentication failed/.test(line)) return "authentication failed";
  for (const line of stderr) {
    // Only a network output: a filter or font failure ends in "Error opening output files: …" too.
    const m =
      /Error opening output [a-z]+:\/\/\S+: (Input\/output error|Connection refused|Connection reset by peer|Broken pipe|Operation not permitted)\s*$/.exec(
        line,
      );
    if (m?.[1]) return m[1];
  }
  return null;
}

export interface RetryPublishOptions {
  attempts: number;
  /** Wait before attempt n + 1 is `backoffMs * n`. */
  backoffMs: number;
  onRetry?: (attempt: number, reason: string, err: StreamerError) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `launch` again while ingest refuses it at connect. A wrong key or a suspended channel is
 * refused every time, so it still fails, after `attempts` tries; anything else fails at once.
 */
export async function retryRefusedPublish(launch: () => Promise<void>, opts: RetryPublishOptions): Promise<void> {
  const wait = opts.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch();
    } catch (err) {
      const reason = err instanceof StreamerError && err.exitCode !== null ? ingestRefusal(err.stderr) : null;
      if (!reason || attempt >= opts.attempts) throw err;
      opts.onRetry?.(attempt, reason, err as StreamerError);
      await wait(opts.backoffMs * attempt);
    }
  }
}

export class Streamer {
  readonly name: string;
  /** Epoch ms encoded at frame time 0 in the timestamp strip. */
  startEpochMs = 0;
  /** Wall-clock time the first progress block reported encoded frames. */
  firstFrameAt: number | null = null;
  private proc: Supervised | null = null;
  /** The ffmpeg command (argv up to its arguments): the installed one, or the pinned image's for WHIP. */
  private command: string[] = ["ffmpeg"];
  private latest: StreamerStats = { frames: 0, fps: 0, bitrateKbps: null, outTimeMs: 0, dropFrames: 0, speed: null };
  private progressListeners = new Set<(p: FfmpegProgress) => void>();

  constructor(private readonly opts: StreamerOptions) {
    this.name = opts.name ?? `streamer-${crypto.randomUUID().slice(0, 6)}`;
  }

  get stats(): StreamerStats {
    return { ...this.latest };
  }

  get running(): boolean {
    return this.proc?.running === true;
  }

  /** Resolves with the exit code when ffmpeg exits (null if never started). */
  get exited(): Promise<number> | null {
    return this.proc?.exited ?? null;
  }

  /** Start publishing; resolves when ffmpeg has encoded and sent its first frames. */
  async start(): Promise<void> {
    if (this.proc?.running) throw new Error(`${this.name} already running`);
    let caps = await probeFfmpeg();
    if (this.opts.protocol === "whip") {
      const cmd = await whipFfmpeg();
      if (!cmd)
        throw new Error(
          `ffmpeg ${caps.version} has no WHIP muxer (needs ffmpeg >= 8 built with WHIP), and podman is not there to run the pinned image's; use RTMP or install a newer ffmpeg`,
        );
      this.command = cmd;
      caps = await probeFfmpeg(cmd);
    }
    const wantTimecode = this.opts.timecode ?? "auto";
    const timecode = wantTimecode === "auto" ? caps.filters.has("drawtext") : wantTimecode;
    try {
      await this.launchRetrying(timecode);
    } catch (err) {
      // drawtext can exist without a usable default font; the strip is what matters, so retry bare.
      if (!timecode || wantTimecode === true) throw err;
      if (err instanceof StreamerError && err.exitCode !== null && ingestRefusal(err.stderr)) throw err;
      this.opts.log?.warn("streamer timecode unavailable, continuing with the strip only", { streamer: this.name });
      await this.launchRetrying(false);
    }
  }

  private launchRetrying(timecode: boolean): Promise<void> {
    return retryRefusedPublish(() => this.launch(timecode), {
      attempts: this.opts.startAttempts ?? 3,
      backoffMs: 1_500,
      onRetry: (attempt, reason, err) =>
        this.opts.log?.warn("streamer publish refused at connect, retrying", {
          streamer: this.name,
          attempt,
          reason,
          code: err.exitCode,
          stderr: err.stderr.slice(-8).map((line) => line.replace(/([?&]key=)[^&\s]*/g, "$1REDACTED")),
        }),
    });
  }

  private async launch(timecode: boolean): Promise<void> {
    this.startEpochMs = Date.now();
    this.firstFrameAt = null;
    const args = buildStreamerArgs({
      protocol: this.opts.protocol,
      url: this.opts.url,
      bearer: this.opts.bearer,
      width: this.opts.width ?? STREAMER_DEFAULTS.width,
      height: this.opts.height ?? STREAMER_DEFAULTS.height,
      fps: this.opts.fps ?? STREAMER_DEFAULTS.fps,
      bitrateKbps: this.opts.bitrateKbps ?? STREAMER_DEFAULTS.bitrateKbps,
      keyframeIntervalSeconds: this.opts.keyframeIntervalSeconds ?? STREAMER_DEFAULTS.keyframeIntervalSeconds,
      durationSeconds: this.opts.durationSeconds,
      mode: this.opts.mode ?? "good",
      startEpochMs: this.startEpochMs,
      timecode,
      toneHz: this.opts.toneHz,
    });
    const parser = new ProgressParser();
    let resolveFirst: () => void = () => undefined;
    const firstFrames = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const proc = spawnSupervised([...this.command, ...args], {
      name: this.name,
      onStdoutLine: (line) => {
        const p = parser.push(line);
        if (!p) return;
        this.latest = {
          frames: p.frame,
          fps: p.fps,
          bitrateKbps: p.bitrateKbps,
          outTimeMs: p.outTimeMs,
          dropFrames: p.dropFrames,
          speed: p.speed,
        };
        for (const listener of this.progressListeners) listener(p);
        if (p.frame > 0 && this.firstFrameAt === null) {
          this.firstFrameAt = Date.now();
          resolveFirst();
        }
      },
    });
    this.proc = proc;
    this.opts.log?.info("streamer started", {
      streamer: this.name,
      protocol: this.opts.protocol,
      mode: this.opts.mode ?? "good",
      timecode,
    });
    const exitedEarly = proc.exited.then((code) => {
      throw new StreamerError(`${this.name}: ffmpeg exited with code ${code} before publishing`, proc.stderr(), code);
    });
    try {
      await withTimeout(
        `${this.name} first frames`,
        Promise.race([firstFrames, exitedEarly]),
        this.opts.startTimeoutMs ?? 20_000,
      );
    } catch (err) {
      await proc.stop(500);
      if (err instanceof StreamerError) throw err;
      throw new StreamerError((err as Error).message, proc.stderr());
    } finally {
      exitedEarly.catch(() => undefined);
    }
  }

  /** Subscribe to progress blocks (about one per second). Returns an unsubscribe function. */
  onProgress(listener: (p: FfmpegProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Last stderr lines from ffmpeg (for failure reports). */
  stderr(): string[] {
    return this.proc?.stderr() ?? [];
  }

  async stop(graceMs = 3_000): Promise<void> {
    if (!this.proc) return;
    const code = await this.proc.stop(graceMs);
    this.opts.log?.info("streamer stopped", { streamer: this.name, code, frames: this.latest.frames });
  }
}

/** RTMP publish URL from an ingest base (`rtmp://host:1935`) and the API's OBS stream key (`<slug>?key=<secret>`). */
export function rtmpPublishUrl(rtmpBase: string, streamKey: string): string {
  return `${rtmpBase.replace(/\/+$/, "")}/live/${streamKey}`;
}

/** WHIP endpoint and bearer token from a WHIP base (`http://host:8889`) and the OBS stream key. */
export function whipPublishTarget(whipBase: string, streamKey: string): { url: string; bearer: string } {
  const [slug, query = ""] = streamKey.split("?", 2);
  const secret = new URLSearchParams(query).get("key");
  if (!slug || !secret) throw new Error("stream key must look like <slug>?key=<secret>");
  return { url: `${whipBase.replace(/\/+$/, "")}/live/${slug}/whip`, bearer: secret };
}
