// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media clock gauges (ADR 0012; no-ops until an OpenTelemetry SDK is registered). Attributes are
 * fixed enums only: never broadcast, run or channel ids.
 */
import { meter } from "@commonair/observability";
import type { W0Consumer } from "./anchor.ts";

export interface ClockMetrics {
  /** |offset| of a recorder run, once per run (W0 + first sample − ffmpeg's raw PDT). */
  recorderOffset(ms: number): void;
  /** Per recorder segment: |stamped PDT − (W0 + its own first sample time)|. The live-to-VOD gauge. */
  recorderResidual(ms: number): void;
  /** A W0 fetch that failed, by consumer. */
  w0Failure(consumer: W0Consumer): void;
  /** How far a fresh W0 moved from the previous one of the same broadcast. */
  w0Drift(ms: number): void;
}

export const NOOP_CLOCK_METRICS: ClockMetrics = {
  recorderOffset: () => {},
  recorderResidual: () => {},
  w0Failure: () => {},
  w0Drift: () => {},
};

export function createClockMetrics(): ClockMetrics {
  const m = meter("media");
  const offset = m.createHistogram("media_clock_recorder_offset_ms", {
    description: "Absolute offset of each recorder run from ffmpeg's own PDT to the broadcast clock",
    unit: "ms",
  });
  const residual = m.createHistogram("media_clock_recorder_residual_ms", {
    description: "Per recorder segment: stamped PDT minus W0 plus the segment's first sample time (live-to-VOD skew)",
    unit: "ms",
  });
  const failures = m.createCounter("media_clock_w0_failures_total", {
    description: "W0 fetches from MediaMTX LL-HLS that failed, by consumer (ladder, aac, recorder)",
  });
  const drift = m.createHistogram("media_clock_w0_drift_ms", {
    description: "How far a fresh W0 moved from the previous one of the same broadcast (nonzero breaks ADR 0012 A2)",
    unit: "ms",
  });
  return {
    recorderOffset: (ms) => offset.record(Math.abs(ms)),
    recorderResidual: (ms) => residual.record(Math.abs(ms)),
    w0Failure: (consumer) => failures.add(1, { consumer }),
    w0Drift: (ms) => drift.record(Math.abs(ms)),
  };
}

/**
 * `media_clock_host_synchronized`: 1 when the kernel says its clock is NTP-synchronized, 0 when
 * not, not reported when it cannot be read (`read` returns null). Observed on each export.
 */
export function observeHostSynchronized(read: () => boolean | null): void {
  meter("media")
    .createObservableGauge("media_clock_host_synchronized", {
      description: "1 when the host kernel clock is NTP-synchronized (adjtimex), 0 when not; absent when unreadable",
    })
    .addCallback((result) => {
      const v = read();
      if (v !== null) result.observe(v ? 1 : 0);
    });
}
