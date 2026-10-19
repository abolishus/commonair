// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stream-health warnings shown to the streamer (dashboard "stream health"). Codes are stable
 * identifiers; the web app maps them to translated messages.
 */
import type { HealthWarningCode } from "@commonair/contracts/enums";
import type { ProbeResult } from "../ffmpeg/probe.ts";

export const WARNINGS = {
  bitrateHigh: "bitrate_high",
  bitrateLow: "bitrate_low",
  keyframeInterval: "keyframe_interval",
  fpsDrop: "fps_drop",
  bFramesWebrtc: "b_frames_webrtc",
  audioMissing: "audio_missing",
  videoMissing: "video_missing",
  videoCodec: "video_codec_unsupported",
  audioCodec: "audio_codec_unsupported",
  /** Server-side: the ladder should run but every transcode slot on the host is taken. */
  transcodeCapacity: "transcode_capacity",
  /** Server-side: VOD recording/clip buffer paused, the media work dir is over its disk budget. */
  recordingDiskBudget: "recording_disk_budget",
} as const satisfies Record<string, HealthWarningCode>;
export type Warning = (typeof WARNINGS)[keyof typeof WARNINGS];

export const MAX_BITRATE_KBPS = 8000;
export const TARGET_KEYFRAME_MS = 2000;
export const KEYFRAME_TOLERANCE_MS = 500;
export const FPS_DROP_FRACTION = 0.1;

/** Minimum sensible bitrate for a resolution; below it the picture visibly falls apart. */
export function minBitrateKbps(height: number | null): number {
  if (height === null) return 1000;
  if (height >= 720) return 1000;
  if (height >= 480) return 600;
  return 300;
}

/** MediaMTX source types that arrive over WebRTC (WHIP). */
export const isWebrtcSource = (sourceType: string | null) => sourceType === "webRTCSession";

export interface HealthInput {
  bitrateKbps: number;
  sourceType: string | null;
  /** Latest probe of the source; null until the first probe completes. */
  probe: ProbeResult | null;
}

export function healthWarnings({ bitrateKbps, sourceType, probe }: HealthInput): Warning[] {
  const w: Warning[] = [];
  const webrtc = isWebrtcSource(sourceType);
  if (bitrateKbps > MAX_BITRATE_KBPS) w.push(WARNINGS.bitrateHigh);
  // A zero sample means "no bytes arrived since the last poll" which is a stall, also too low.
  else if (bitrateKbps < minBitrateKbps(probe?.height ?? null)) w.push(WARNINGS.bitrateLow);
  if (!probe) return w;

  if (probe.videoCodec === null) w.push(WARNINGS.videoMissing);
  else if (probe.videoCodec !== "h264") w.push(WARNINGS.videoCodec);

  if (probe.audioCodec === null) w.push(WARNINGS.audioMissing);
  else if (!(probe.audioCodec === "aac" || (webrtc && probe.audioCodec === "opus"))) w.push(WARNINGS.audioCodec);

  if (probe.videoCodec !== null) {
    if (probe.keyframeIntervalMs === null) {
      // Fewer than two keyframes in the window: the interval is at least the window length.
      if (probe.windowSeconds * 1000 >= TARGET_KEYFRAME_MS + KEYFRAME_TOLERANCE_MS) w.push(WARNINGS.keyframeInterval);
    } else if (Math.abs(probe.keyframeIntervalMs - TARGET_KEYFRAME_MS) > KEYFRAME_TOLERANCE_MS)
      w.push(WARNINGS.keyframeInterval);

    if (fpsDeficit(probe) > FPS_DROP_FRACTION) w.push(WARNINGS.fpsDrop);
    if (webrtc && probe.hasBFrames) w.push(WARNINGS.bFramesWebrtc);
  }
  return w;
}

/** Fraction of declared frames that did not arrive (0 when unknown or on target). */
export function fpsDeficit(probe: Pick<ProbeResult, "nominalFps" | "measuredFps">): number {
  const { nominalFps, measuredFps } = probe;
  if (!nominalFps || measuredFps === null) return 0;
  return Math.max(0, (nominalFps - measuredFps) / nominalFps);
}

/**
 * Dropped frames over an interval. MediaMTX reports frames that arrived corrupt
 * (`inboundFramesInError`); frames the encoder never sent show up only as an fps deficit, so the
 * estimate is the larger of the two.
 */
export function droppedFrames(opts: {
  framesInErrorDelta: number | null;
  probe: Pick<ProbeResult, "nominalFps" | "measuredFps"> | null;
  intervalSeconds: number;
}): number {
  const fromErrors = Math.max(0, opts.framesInErrorDelta ?? 0);
  let fromFps = 0;
  if (opts.probe?.nominalFps && opts.probe.measuredFps !== null)
    fromFps = Math.max(0, (opts.probe.nominalFps - opts.probe.measuredFps) * opts.intervalSeconds);
  return Math.round(Math.max(fromErrors, fromFps));
}

/** Bitrate in kbit/s from two byte-counter readings; null when the counter reset or time stood still. */
export function bitrateKbps(prevBytes: number, prevAtMs: number, bytes: number, atMs: number): number | null {
  const dt = atMs - prevAtMs;
  if (dt <= 0 || bytes < prevBytes) return null;
  return Math.round(((bytes - prevBytes) * 8) / dt);
}
