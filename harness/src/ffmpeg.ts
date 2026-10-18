// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * FFmpeg capability detection and argument builders for simulated streamers. Builders are pure
 * so every encoder mode is unit-tested without spawning ffmpeg.
 */
import { MIN_FRAME_WIDTH, geqExpression, stripHeight } from "./timestamp-strip.ts";

export interface FfmpegCapabilities {
  version: string;
  major: number;
  muxers: Set<string>;
  filters: Set<string>;
  encoders: Set<string>;
}

/** Parse `ffmpeg -version` first line. */
export function parseVersion(text: string): { version: string; major: number } {
  const match = /ffmpeg version (n?(\d+)[^\s]*)/.exec(text);
  if (!match?.[1] || !match[2]) return { version: "unknown", major: 0 };
  return { version: match[1], major: Number(match[2]) };
}

/**
 * Parse the name column of `ffmpeg -muxers` / `-filters` / `-encoders` listings. Each entry line
 * starts with a flags column, then the name; header lines and the `--` separator are skipped.
 */
export function parseListing(text: string, kind: "muxers" | "filters" | "encoders"): Set<string> {
  const names = new Set<string>();
  let body = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!body) {
      // Listings start after a "--" (muxers) or "------" (encoders) line; filters have no separator.
      if (/^\s*-+\s*$/.test(line)) body = true;
      if (kind === "filters" && /^\s*[TSC.]{2,3}\s+\S+\s+\S+->\S+/.test(line)) body = true;
      if (!body) continue;
      if (/^\s*-+\s*$/.test(line)) continue;
    }
    const match = /^\s*[A-Z.|]{1,6}\s+([A-Za-z0-9_,-]+)\s/.exec(line);
    if (!match?.[1]) continue;
    for (const name of match[1].split(",")) names.add(name);
  }
  return names;
}

let cached: Promise<FfmpegCapabilities> | undefined;

async function output(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
}

/** Probe the installed ffmpeg once per process. Throws if ffmpeg is not on PATH. */
export function probeFfmpeg(binary = "ffmpeg"): Promise<FfmpegCapabilities> {
  cached ??= (async () => {
    const [version, muxers, filters, encoders] = await Promise.all([
      output([binary, "-hide_banner", "-version"]),
      output([binary, "-hide_banner", "-muxers"]),
      output([binary, "-hide_banner", "-filters"]),
      output([binary, "-hide_banner", "-encoders"]),
    ]);
    return {
      ...parseVersion(version),
      muxers: parseListing(muxers, "muxers"),
      filters: parseListing(filters, "filters"),
      encoders: parseListing(encoders, "encoders"),
    };
  })();
  return cached;
}

export type IngestProtocol = "rtmp" | "whip";

/**
 * Encoder behaviour. `good` follows the API's recommended settings; the bad modes exist to trigger
 * stream-health warnings: `wrong-keyframe` uses a 10 s GOP, `high-bitrate` sends far more than the
 * recommended bitrate.
 */
export type EncoderMode = "good" | "wrong-keyframe" | "high-bitrate";

export interface StreamerArgsOptions {
  protocol: IngestProtocol;
  /** Full ingest URL (RTMP: includes `?key=`; WHIP: the endpoint). */
  url: string;
  /** WHIP bearer token (the stream key secret). */
  bearer?: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeIntervalSeconds: number;
  /** Stop after this many seconds; unset = until stopped. */
  durationSeconds?: number;
  mode: EncoderMode;
  /** Epoch ms that frame time 0 represents in the timestamp strip. */
  startEpochMs: number;
  /** Burn a human-readable wall clock with drawtext (only when the filter exists). */
  timecode: boolean;
  /** Sine frequency, so several streamers are distinguishable by ear. */
  toneHz?: number;
}

export const BAD_KEYFRAME_SECONDS = 10;
export const HIGH_BITRATE_FACTOR = 4;

/** Effective encoder settings after applying the mode. */
export function effectiveEncoding(o: Pick<StreamerArgsOptions, "bitrateKbps" | "keyframeIntervalSeconds" | "mode">): {
  bitrateKbps: number;
  keyframeIntervalSeconds: number;
} {
  switch (o.mode) {
    case "wrong-keyframe":
      return { bitrateKbps: o.bitrateKbps, keyframeIntervalSeconds: BAD_KEYFRAME_SECONDS };
    case "high-bitrate":
      return { bitrateKbps: o.bitrateKbps * HIGH_BITRATE_FACTOR, keyframeIntervalSeconds: o.keyframeIntervalSeconds };
    default:
      return { bitrateKbps: o.bitrateKbps, keyframeIntervalSeconds: o.keyframeIntervalSeconds };
  }
}

/** Video filtergraph: test pattern + timestamp strip (+ optional wall-clock timecode). */
export function videoFilter(o: Pick<StreamerArgsOptions, "width" | "height" | "startEpochMs" | "timecode">): string {
  const h = stripHeight(o.height);
  const graph = [
    `[0:v]split[base][src]`,
    `[src]crop=${o.width}:${h}:0:0,format=gray,geq=lum=${geqExpression(o.startEpochMs)},format=yuv420p[strip]`,
  ];
  if (o.timecode) {
    const seconds = Math.floor(o.startEpochMs / 1000);
    const size = Math.max(12, Math.round(o.height / 18));
    graph.push(`[base][strip]overlay=0:0[ov]`);
    graph.push(
      `[ov]drawtext=text='%{pts\\:gmtime\\:${seconds}\\:%H\\\\:%M\\\\:%S} UTC':x=8:y=${h + 8}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.6[v]`,
    );
  } else {
    graph.push(`[base][strip]overlay=0:0[v]`);
  }
  return graph.join(";");
}

export function validateStreamerOptions(o: StreamerArgsOptions): void {
  if (o.width < MIN_FRAME_WIDTH) throw new RangeError(`width must be at least ${MIN_FRAME_WIDTH}`);
  if (o.width % 2 !== 0 || o.height % 2 !== 0) throw new RangeError("width and height must be even");
  if (!(o.fps > 0 && o.fps <= 120)) throw new RangeError("fps must be in (0, 120]");
  if (!(o.bitrateKbps > 0)) throw new RangeError("bitrate must be positive");
  if (!(o.keyframeIntervalSeconds > 0)) throw new RangeError("keyframe interval must be positive");
  if (o.protocol === "whip" && !o.bearer) throw new RangeError("WHIP needs a bearer token");
}

/** Complete ffmpeg argv (without the binary) for a synthetic streamer. */
export function buildStreamerArgs(o: StreamerArgsOptions): string[] {
  validateStreamerOptions(o);
  const enc = effectiveEncoding(o);
  const gop = Math.max(1, Math.round(o.fps * enc.keyframeIntervalSeconds));
  const args = ["-hide_banner", "-nostats", "-loglevel", "warning", "-progress", "pipe:1"];
  args.push("-re", "-f", "lavfi", "-i", `testsrc2=size=${o.width}x${o.height}:rate=${o.fps}`);
  args.push("-re", "-f", "lavfi", "-i", `sine=frequency=${o.toneHz ?? 440}:sample_rate=48000`);
  args.push("-filter_complex", videoFilter(o), "-map", "[v]", "-map", "1:a");
  if (o.durationSeconds !== undefined) args.push("-t", String(o.durationSeconds));
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    "-sc_threshold",
    "0",
    "-b:v",
    `${enc.bitrateKbps}k`,
    "-maxrate",
    `${enc.bitrateKbps}k`,
    "-bufsize",
    `${enc.bitrateKbps * 2}k`,
  );
  if (o.protocol === "rtmp") {
    args.push("-profile:v", "high", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2");
    args.push("-f", "flv", o.url);
  } else {
    // WebRTC: no B-frames, Opus audio, Annex B H.264 (constrained baseline is safest across peers).
    args.push("-profile:v", "baseline", "-bf", "0", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2");
    args.push("-f", "whip", "-authorization", o.bearer ?? "", o.url);
  }
  return args;
}

/** One `-progress` block from ffmpeg (`key=value` lines terminated by `progress=`). */
export interface FfmpegProgress {
  frame: number;
  fps: number;
  bitrateKbps: number | null;
  outTimeMs: number;
  dropFrames: number;
  speed: number | null;
  done: boolean;
}

/** Incremental parser for `-progress pipe:1` output. */
export class ProgressParser {
  private block = new Map<string, string>();

  /** Feed one line; returns a progress snapshot when a block completes. */
  push(line: string): FfmpegProgress | null {
    const eq = line.indexOf("=");
    if (eq < 0) return null;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    this.block.set(key, value);
    if (key !== "progress") return null;
    const b = this.block;
    this.block = new Map();
    const num = (k: string) => {
      const n = Number.parseFloat(b.get(k) ?? "");
      return Number.isFinite(n) ? n : null;
    };
    const bitrate = /([\d.]+)kbits\/s/.exec(b.get("bitrate") ?? "");
    return {
      frame: num("frame") ?? 0,
      fps: num("fps") ?? 0,
      bitrateKbps: bitrate?.[1] ? Number(bitrate[1]) : null,
      // `out_time_us` is microseconds; ffmpeg's `out_time_ms` is also microseconds (historic bug).
      outTimeMs: Math.round((num("out_time_us") ?? num("out_time_ms") ?? 0) / 1000),
      dropFrames: num("drop_frames") ?? 0,
      speed: num("speed"),
      done: value === "end",
    };
  }
}
