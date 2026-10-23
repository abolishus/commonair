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
import { withTimeout } from "./wait.ts";

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
  ) {
    super(`${message}${stderr.length ? `\n  ffmpeg: ${stderr.slice(-8).join("\n  ffmpeg: ")}` : ""}`);
    this.name = "StreamerError";
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
      await this.launch(timecode);
    } catch (err) {
      // drawtext can exist without a usable default font; the strip is what matters, so retry bare.
      if (!timecode || wantTimecode === true) throw err;
      this.opts.log?.warn("streamer timecode unavailable, continuing with the strip only", { streamer: this.name });
      await this.launch(false);
    }
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
      throw new StreamerError(`${this.name}: ffmpeg exited with code ${code} before publishing`, proc.stderr());
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
