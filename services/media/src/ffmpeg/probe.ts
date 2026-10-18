// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turns `ffprobe -show_streams -show_packets -of json` output (see `probeArgs`) into the
 * measurements health sampling needs. Measured, not declared: the keyframe interval comes from
 * the spacing of keyframe packets and the frame rate from packet timestamps, because encoders
 * often declare 30/1 while delivering 24.
 */
import { z } from "zod";
import { probeArgs } from "./args.ts";
import { runCommand } from "./run.ts";

const Stream = z.object({
  index: z.number(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  r_frame_rate: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  has_b_frames: z.number().optional(),
});
const Packet = z.object({
  stream_index: z.number(),
  pts_time: z.string().optional(),
  dts_time: z.string().optional(),
  flags: z.string().optional(),
});
export const FfprobeOutput = z.object({
  streams: z.array(Stream).default([]),
  packets: z.array(Packet).default([]),
});
export type FfprobeOutput = z.infer<typeof FfprobeOutput>;

export interface ProbeResult {
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  /** Frame rate the stream declares. */
  nominalFps: number | null;
  /** Frame rate measured from video packet timestamps over the window. */
  measuredFps: number | null;
  /** Mean spacing of keyframes; null when fewer than two keyframes were seen. */
  keyframeIntervalMs: number | null;
  keyframeCount: number;
  /** Seconds of video actually covered by the packets read. */
  windowSeconds: number;
  hasBFrames: boolean;
}

export function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const den = d === undefined ? 1 : d;
  if (!Number.isFinite(den) || den <= 0) return null;
  return n / den;
}

const time = (s: string | undefined): number | null => {
  if (s === undefined || s === "N/A") return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function analyzeProbe(raw: unknown): ProbeResult {
  const out = FfprobeOutput.parse(raw);
  const video = out.streams.find((s) => s.codec_type === "video");
  const audio = out.streams.find((s) => s.codec_type === "audio");
  const vPackets = video ? out.packets.filter((p) => p.stream_index === video.index) : [];

  const pts = vPackets.map((p) => time(p.pts_time)).filter((t): t is number => t !== null);
  const sorted = [...pts].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = first !== undefined && last !== undefined ? last - first : 0;
  const measuredFps = sorted.length >= 2 && span > 0 ? round2((sorted.length - 1) / span) : null;

  const keyTimes = vPackets
    .filter((p) => p.flags?.startsWith("K"))
    .map((p) => time(p.pts_time))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  let keyframeIntervalMs: number | null = null;
  const kFirst = keyTimes[0];
  const kLast = keyTimes[keyTimes.length - 1];
  if (keyTimes.length >= 2 && kFirst !== undefined && kLast !== undefined)
    keyframeIntervalMs = Math.round(((kLast - kFirst) / (keyTimes.length - 1)) * 1000);

  // Reordered frames (pts ≠ dts, or pts going backwards in decode order) mean B-frames even
  // when the stream header does not say so.
  let reordered = false;
  let prev = -Infinity;
  for (const p of vPackets) {
    const pt = time(p.pts_time);
    const dt = time(p.dts_time);
    if (pt !== null && dt !== null && Math.abs(pt - dt) > 1e-6) reordered = true;
    if (pt !== null) {
      if (pt < prev) reordered = true;
      prev = pt;
    }
  }

  return {
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    nominalFps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    measuredFps,
    keyframeIntervalMs,
    keyframeCount: keyTimes.length,
    windowSeconds: round2(span),
    hasBFrames: (video?.has_b_frames ?? 0) > 0 || reordered,
  };
}

export async function probeSource(
  input: string,
  seconds: number,
  opts: { secrets: readonly string[]; ffprobe?: string },
): Promise<ProbeResult> {
  const { stdout } = await runCommand(opts.ffprobe ?? "ffprobe", probeArgs(input, seconds), {
    timeoutMs: (seconds + 15) * 1000,
    secrets: opts.secrets,
    maxStdoutBytes: 32 * 1024 * 1024,
  });
  return analyzeProbe(JSON.parse(new TextDecoder().decode(stdout)));
}
