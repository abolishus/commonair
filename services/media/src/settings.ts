// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Timing and sizing knobs. Production uses DEFAULT_TIMINGS; integration tests shrink them so a
 * hysteresis window or a thumbnail interval does not take minutes.
 */
export interface MediaTimings {
  /** MediaMTX API poll for bitrate + live seconds. */
  healthSampleMs: number;
  /** ffprobe of the source (codec, resolution, fps, keyframe interval). */
  probeIntervalMs: number;
  /** How much of the source each probe reads. */
  probeWindowSeconds: number;
  /** Viewer-count poll for the transcode decision. */
  transcodePollMs: number;
  /** Viewers must exceed the threshold this long before the ladder starts. */
  transcodeStartAfterMs: number;
  /** Viewers must stay below 80% of the threshold this long before the ladder stops. */
  transcodeStopAfterMs: number;
  thumbnailIntervalMs: number;
  /** Delay before the first thumbnail of a broadcast (the source needs a keyframe first). */
  thumbnailFirstDelayMs: number;
  /** Local recorder playlist poll. */
  recorderPollMs: number;
  /** Rolling local segment window kept for live clips. */
  clipBufferSeconds: number;
  /** Recorder segment length (2 s GOP → 4 s segments). */
  segmentSeconds: number;
  /** Reconcile live broadcasts against the database and MediaMTX. */
  reconcileMs: number;
  /** Timestamped thumbnails kept per broadcast (older ones are deleted). */
  thumbnailHistory: number;
  /** Work-dir sweep interval. */
  sweepMs: number;
  /** A broadcast directory no session owns is recovered and removed once untouched this long. */
  broadcastDirMaxAgeMs: number;
  /** An unfinished VOD this long after its broadcast ended is marked failed. */
  vodFailAfterMs: number;
  /** Wait this long after a finalize job failed for good before re-queueing it. */
  vodRetryAfterMs: number;
}

export const DEFAULT_TIMINGS: MediaTimings = {
  healthSampleMs: 5_000,
  probeIntervalMs: 30_000,
  probeWindowSeconds: 4,
  transcodePollMs: 5_000,
  transcodeStartAfterMs: 30_000,
  transcodeStopAfterMs: 120_000,
  thumbnailIntervalMs: 60_000,
  thumbnailFirstDelayMs: 5_000,
  recorderPollMs: 1_000,
  clipBufferSeconds: 90,
  segmentSeconds: 4,
  reconcileMs: 30_000,
  thumbnailHistory: 10,
  sweepMs: 5 * 60_000,
  broadcastDirMaxAgeMs: 15 * 60_000,
  vodFailAfterMs: 24 * 3600_000,
  vodRetryAfterMs: 10 * 60_000,
};

/** Viewer sessions whose last heartbeat is older than this are not counted. */
export const VIEWER_FRESH_MS = 30_000;
/** Fraction of the threshold below which the ladder may stop (hysteresis). */
export const TRANSCODE_STOP_FRACTION = 0.8;
/** Simulcast reconnect backoff cap. */
export const SIMULCAST_MAX_BACKOFF_MS = 60_000;
/** Purpose string for simulcast stream-key encryption (must match services/api). */
export const SIMULCAST_SECRET_PURPOSE = "simulcast";
/** If uploads fail for this many segments in a row, the oldest pending ones are dropped. */
export const MAX_PENDING_UPLOADS = 300;
