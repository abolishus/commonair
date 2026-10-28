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

/**
 * SRT receive latency for the internal network, in microseconds (ffmpeg's unit). SRT's 120 ms
 * default budgets for retransmissions across the internet; MediaMTX and media share a host or a
 * private network. It only delays the readers' output: PDT comes from W0, not from arrival.
 */
export const SRT_LATENCY_US = 40_000;
/** Bounded SRT waits: connect (ms, libsrt's unit) and any later socket read (µs). */
const SRT_CONNECT_TIMEOUT_MS = 5_000;
const SRT_RW_TIMEOUT_US = 10_000_000;

/**
 * MediaMTX splits an SRT `streamid` on `:`, so the internal password cannot contain one. The
 * service checks this at boot, so a bad value fails loudly instead of every SRT reader retrying.
 */
export function assertSrtSecret(secret: string): void {
  if (secret.includes(":"))
    throw new Error("MEDIA_INTERNAL_PASSWORD must not contain ':' (MediaMTX splits the SRT streamid on it)");
}

/**
 * `srt://host:port?…&streamid=read:<path>:internal:<secret>` from MEDIAMTX_SRT_URL (ADR 0012 A2):
 * the reader for the ladder, the AAC copy and the recorder. MediaMTX gives every SRT reader one
 * stream timeline, so `-copyts` times are comparable across sessions. ffmpeg percent-decodes the
 * `streamid` value, so the path and secret are percent-encoded and the separators stay literal;
 * MediaMTX splits the decoded value on `:`, so a secret containing one cannot be expressed.
 */
export function internalSrtUrl(base: string, path: string, secret: string): string {
  assertSrtSecret(secret);
  const u = new URL(base);
  if (u.protocol !== "srt:") throw new Error("MEDIAMTX_SRT_URL must be an srt:// URL");
  const streamid = ["read", encodeURIComponent(path), MEDIA_INTERNAL_USER, encodeURIComponent(secret)].join(":");
  const query = [
    "mode=caller",
    "transtype=live",
    `latency=${SRT_LATENCY_US}`,
    `connect_timeout=${SRT_CONNECT_TIMEOUT_MS}`,
    `timeout=${SRT_RW_TIMEOUT_US}`,
    // Last, so redaction masks from the secret to the end of the URL.
    `streamid=${streamid}`,
  ].join("&");
  return `srt://${u.host}?${query}`;
}

/**
 * Input flag for an SRT reader: keep the source's stream timeline, so the ladder's outputs can
 * be anchored with W0 and the recorder's fMP4 times are W0-relative.
 */
const SRT_IN = ["-copyts"];

/** `-start_time_realtime`: wall clock (µs) of PTS 0, so an RTSP output's sender reports carry W0. */
function realtime(w0Ms: number): string[] {
  if (!Number.isFinite(w0Ms) || w0Ms <= 0) throw new RangeError("W0 must be a positive epoch time");
  return ["-start_time_realtime", String(Math.round(w0Ms * 1000))];
}

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

/**
 * Keyframes on 2 s boundaries of the shared source timeline, the first frame always: every rung
 * and every ladder run, restarts included, cuts at the same instants. ffmpeg (6.1+) evaluates `t`
 * relative to the first frame the encoder sees, not to the input timeline, so `ALIGN_START`
 * makes that first frame the first one on a 2 s boundary of the timeline (measured: without it a
 * B-frame source keyed 67 ms after every boundary).
 */
export const KEYFRAME_EXPR = "expr:if(isnan(prev_forced_t),1,gte(floor(t/2),floor(prev_forced_t/2)+1))";
/**
 * Drops video frames before the first 2 s boundary of the source timeline (`t`, `start_t` are
 * absolute under `-copyts`; 1 ms of slack for rounding). Up to 2 s of a new ladder's video is lost.
 */
export const ALIGN_START = "select='gte(t,2*ceil((start_t-0.001)/2)-0.001)'";

function videoEncoderFlags(encoder: H264Encoder, kbps: number): string[] {
  const rate = [`-b:v`, `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`];
  // No B-frames so WebRTC/LL-HLS players never see reordering.
  const gop = ["-force_key_frames", KEYFRAME_EXPR, "-bf", "0"];
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
  /** The source over SRT (`internalSrtUrl`). */
  input: string;
  /** Wall clock of the source timeline's PTS 0, epoch ms (`clock/w0.ts`). */
  w0Ms: number;
  /** Publish URL for each rung, `rtsp://internal:<secret>@host/live/<slug>/<rung>`. */
  outputFor: (rung: Rung["name"]) => string;
  rungs: readonly Rung[];
  encoder: H264Encoder;
}

/**
 * One decode, split once per video rung, each rung published back to MediaMTX over RTSP. Every
 * output carries W0 in its sender reports and the rendition paths stamp PDT from them
 * (`useAbsoluteTimestamp`), so a frame has the source's PDT on every rung.
 */
export function ladderArgs({ input, w0Ms, outputFor, rungs, encoder }: LadderInput): string[] {
  const video = rungs.filter((r) => r.name !== "audio");
  const rt = realtime(w0Ms);
  const args = [...BASE, ...PROGRESS, ...SRT_IN, "-i", input];
  if (video.length > 0) {
    const labels = video.map((_, i) => `[v${i}]`).join("");
    const scales = video
      .map((r, i) => ("height" in r ? `[v${i}]scale=-2:${r.height}:flags=bicubic[o${i}]` : ""))
      .join(";");
    args.push("-filter_complex", `[0:v:0]${ALIGN_START},split=${video.length}${labels};${scales}`);
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
    args.push(...rt, "-f", "rtsp", "-rtsp_transport", "tcp", "-pkt_size", "1200", outputFor(r.name));
  }
  return args;
}

/**
 * The source with its audio re-encoded to AAC and the video copied, published back to MediaMTX
 * (`sourceAacPath`): cheap enough to run for every WHIP broadcast, whatever the viewer count.
 */
export function aacCopyArgs(input: string, output: string, w0Ms: number): string[] {
  return [
    ...BASE,
    ...PROGRESS,
    ...SRT_IN,
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
    ...realtime(w0Ms),
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
  /**
   * The source's audio is AAC. MPEG-TS (SRT) carries it with ADTS headers, which MP4 cannot hold;
   * the nested HLS muxer does not insert the rewrap itself. Opus needs none (and the filter would
   * refuse it), so the caller says which.
   */
  aacAudio: boolean;
}

export const recorderPlaylist = (runId: string) => `${runId}.m3u8`;
export const recorderInit = (runId: string) => `init_${runId}.mp4`;

/**
 * Copy the source into fMP4 HLS segments: no re-encode, segment boundaries on source keyframes.
 * The input is SRT with `-copyts`, and `frag_discont` stops the MP4 muxer from rebasing the first
 * fragment to 0, so `tfdt` is the source timeline and `W0 + time` is a sample's exact PDT (R4,
 * ADR 0012 decision 4; measured in `clock-mediamtx.int.test.ts`).
 */
export function recorderArgs({ input, dir, runId, segmentSeconds, aacAudio }: RecorderInput): string[] {
  return [
    ...BASE,
    ...PROGRESS,
    ...SRT_IN,
    "-i",
    input,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    ...(aacAudio ? ["-bsf:a", "aac_adtstoasc"] : []),
    "-f",
    "hls",
    "-hls_segment_options",
    "movflags=+frag_discont",
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
