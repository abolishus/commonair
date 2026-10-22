// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure builders for every ffmpeg/ffprobe command line the service runs. Keeping them pure makes
 * the exact flags reviewable and unit-testable; the supervisor only spawns what these return.
 */
import { MEDIA_INTERNAL_USER } from "@commonair/contracts/internal";
import { hostPort, type ParsedTarget } from "../net/ssrf.ts";
import type { Rung } from "../transcode/ladder.ts";

export type H264Encoder = "h264_nvenc" | "libx264";
export type ImageFormat = "webp" | "jpeg";

/** Shared prefix: no banner, no interactive stdin, machine-readable progress on stdout. */
const BASE = ["-hide_banner", "-nostdin", "-loglevel", "warning"];
const PROGRESS = ["-progress", "pipe:1", "-nostats"];
/** Readers of the live source: TCP only (the MediaMTX config disables UDP), bounded socket waits. */
const RTSP_IN = ["-rtsp_transport", "tcp", "-timeout", "10000000"];

/** `rtsp://internal:<secret>@host:port/<path>` from MEDIAMTX_RTSP_URL. */
export function internalRtspUrl(base: string, path: string, secret: string): string {
  const u = new URL(base);
  u.username = MEDIA_INTERNAL_USER;
  u.password = secret;
  u.pathname = `/${path}`;
  return u.toString();
}

export interface SimulcastOutput {
  /** Full publish URL including the stream key: secret, redact it everywhere. */
  url: string;
  /** Set when the host was replaced by the vetted IP, so the server still sees its own name. */
  tcUrl: string | null;
}

/**
 * Publish URL for a vetted simulcast target: path, then the stream key, then any query. For
 * `rtmp:` the host is the address the SSRF check approved (no second DNS lookup by ffmpeg); for
 * `rtmps:` the host name stays so TLS SNI matches the server.
 */
export function simulcastOutput(target: ParsedTarget, streamKey: string, vettedAddress: string): SimulcastOutput {
  const pinned = target.protocol === "rtmp:";
  const host = hostPort(pinned ? vettedAddress : target.host, target.explicitPort || pinned ? target.port : null);
  return {
    url: `${target.protocol}//${host}${target.path}/${streamKey}${target.search}`,
    tcUrl: pinned ? target.tcUrl : null,
  };
}

/** Restream the source unchanged to an RTMP target. */
export function simulcastArgs(input: string, out: SimulcastOutput): string[] {
  return [
    ...BASE,
    ...PROGRESS,
    ...RTSP_IN,
    "-i",
    input,
    "-map",
    "0",
    "-c",
    "copy",
    ...(out.tcUrl ? ["-rtmp_tcurl", out.tcUrl] : []),
    "-f",
    "flv",
    out.url,
  ];
}

export interface EncoderSettings {
  encoder: H264Encoder;
}

function videoEncoderFlags(encoder: H264Encoder, kbps: number): string[] {
  const rate = [`-b:v`, `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`];
  // Keyframes every 2 s of source time, aligned across rungs (and with a 2 s-GOP source), no
  // B-frames so WebRTC/LL-HLS players never see reordering.
  const gop = ["-force_key_frames", "expr:gte(t,n_forced*2)", "-bf", "0"];
  if (encoder === "h264_nvenc")
    return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "cbr", ...rate, ...gop, "-forced-idr", "1"];
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    ...rate,
    ...gop,
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
  ];
}

export interface LadderInput {
  input: string;
  /** Publish URL for each rung, `rtsp://internal:<secret>@host/live/<slug>/<rung>`. */
  outputFor: (rung: Rung["name"]) => string;
  rungs: readonly Rung[];
  encoder: H264Encoder;
}

/** One decode, split once per video rung, each rung published back to MediaMTX over RTSP. */
export function ladderArgs({ input, outputFor, rungs, encoder }: LadderInput): string[] {
  const video = rungs.filter((r) => r.name !== "audio");
  const args = [...BASE, ...PROGRESS, ...RTSP_IN, "-i", input];
  if (video.length > 0) {
    const labels = video.map((_, i) => `[v${i}]`).join("");
    const scales = video
      .map((r, i) => ("height" in r ? `[v${i}]scale=-2:${r.height}:flags=bicubic[o${i}]` : ""))
      .join(";");
    args.push("-filter_complex", `[0:v:0]split=${video.length}${labels};${scales}`);
  }
  let vi = 0;
  for (const r of rungs) {
    if (r.name === "audio") {
      args.push("-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", `${r.audioKbps}k`, "-ac", "2");
    } else if ("height" in r) {
      args.push("-map", `[o${vi}]`, ...videoEncoderFlags(encoder, r.videoKbps));
      args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", `${r.audioKbps}k`, "-ac", "2");
      vi++;
    }
    args.push("-f", "rtsp", "-rtsp_transport", "tcp", "-pkt_size", "1200", outputFor(r.name));
  }
  return args;
}

/**
 * The source with its audio re-encoded to AAC and the video copied, published back to MediaMTX
 * (`sourceAacPath`): cheap enough to run for every WHIP broadcast, whatever the viewer count.
 */
export function aacCopyArgs(input: string, output: string): string[] {
  return [
    ...BASE,
    ...PROGRESS,
    ...RTSP_IN,
    "-i",
    input,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "rtsp",
    "-rtsp_transport",
    "tcp",
    "-pkt_size",
    "1200",
    output,
  ];
}

export interface RecorderInput {
  input: string;
  /** Local directory for this broadcast's segments. */
  dir: string;
  /** Unique per ffmpeg run so a restart never overwrites earlier segments. */
  runId: string;
  segmentSeconds: number;
}

export const recorderPlaylist = (runId: string) => `${runId}.m3u8`;
export const recorderInit = (runId: string) => `init_${runId}.mp4`;

/** Copy the source into fMP4 HLS segments: no re-encode, segment boundaries on source keyframes. */
export function recorderArgs({ input, dir, runId, segmentSeconds }: RecorderInput): string[] {
  return [
    ...BASE,
    ...PROGRESS,
    ...RTSP_IN,
    "-i",
    input,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_list_size",
    "0",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    recorderInit(runId),
    "-hls_segment_filename",
    `${dir}/${runId}_%06d.m4s`,
    "-hls_flags",
    "independent_segments+program_date_time+temp_file",
    `${dir}/${recorderPlaylist(runId)}`,
  ];
}

function imageEncoder(format: ImageFormat): string[] {
  return format === "webp"
    ? ["-c:v", "libwebp", "-quality", "75", "-f", "webp"]
    : ["-c:v", "mjpeg", "-q:v", "4", "-f", "mjpeg"];
}

/** Fit into 640×360 keeping the aspect ratio, letterboxed. */
const THUMB_FILTER =
  "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1";

/** One frame of the live source as an image on stdout. */
export function thumbnailArgs(input: string, format: ImageFormat): string[] {
  return [...BASE, ...RTSP_IN, "-i", input, "-frames:v", "1", "-vf", THUMB_FILTER, ...imageEncoder(format), "pipe:1"];
}

/** One frame at `atSeconds` of a local file as an image on stdout (VOD sampling, clip thumbnails). */
export function frameArgs(input: string, atSeconds: number, format: ImageFormat): string[] {
  return [
    ...BASE,
    "-ss",
    atSeconds.toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    THUMB_FILTER,
    ...imageEncoder(format),
    "pipe:1",
  ];
}

export interface ClipInput {
  input: string;
  startSeconds: number;
  durationSeconds: number;
  output: string;
  encoder: H264Encoder;
}

/** Frame-accurate cut (re-encode), web-friendly MP4 with the index up front. */
export function clipArgs({ input, startSeconds, durationSeconds, output, encoder }: ClipInput): string[] {
  const v =
    encoder === "h264_nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "23"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"];
  return [
    ...BASE,
    "-y",
    "-i",
    input,
    // Output-side seek: decode from the start of the assembled segments and drop frames until
    // the offset. Exact, and immune to fMP4 fragments whose timestamps do not start at zero.
    "-ss",
    startSeconds.toFixed(3),
    "-t",
    durationSeconds.toFixed(3),
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    ...v,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

/**
 * Read `seconds` of the live source and report streams plus per-packet timing, from which the
 * keyframe interval, the real frame rate and B-frame use are measured.
 */
export function probeArgs(input: string, seconds: number): string[] {
  return [
    "-v",
    "error",
    ...RTSP_IN,
    "-read_intervals",
    `%+${seconds}`,
    "-show_streams",
    "-show_packets",
    "-show_entries",
    "packet=stream_index,pts_time,dts_time,flags:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,has_b_frames",
    "-of",
    "json",
    input,
  ];
}

/** 1-frame encode used to confirm a hardware encoder actually works on this host. */
export function encoderTestArgs(encoder: H264Encoder): string[] {
  return [
    ...BASE,
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=256x256:d=0.1",
    "-frames:v",
    "1",
    "-c:v",
    encoder,
    "-f",
    "null",
    "-",
  ];
}
