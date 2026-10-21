// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Moderation counters (no-ops until an OpenTelemetry SDK is registered). Attributes are fixed enums only. */
import { meter } from "@commonair/observability";

/** What happened to one live frame. `low_quality` frames are classified but never matched. */
export type FrameOutcome = "sampled" | "matched" | "low_quality" | "enqueued";
export type SubjectKind = "broadcast" | "vod" | "clip" | "thumbnail";

export interface ModerationMetrics {
  frame(outcome: FrameOutcome): void;
  /** A classifier job dropped because the queue is backed up (PDQ still ran). */
  classifierDropped(): void;
  /** A sampled live frame that could not be captured or decoded. */
  captureFailed(): void;
  /** A scan job or frame that could not be written to Valkey. */
  scanEnqueueFailed(): void;
  /** A failed attempt to enqueue a T0 job (it is retried). */
  t0EnqueueFailed(): void;
  /** A T0 job enqueued, by subject. */
  t0(subject: SubjectKind): void;
  /** Frames PDQ-checked before a VOD or clip is published. */
  prepublishFrames(subject: "vod" | "clip", n: number): void;
}

export function createModerationMetrics(): ModerationMetrics {
  const m = meter("media");
  const frames = m.createCounter("moderation_frames_total", {
    description: "Live frames by outcome (sampled, matched, low_quality, enqueued)",
  });
  const dropped = m.createCounter("moderation_classifier_dropped_total", {
    description: "Classifier jobs dropped because the moderation queue is backed up (PDQ still ran)",
  });
  const capture = m.createCounter("moderation_capture_failures_total", {
    description: "Live moderation samples that could not be captured or decoded",
  });
  const scanFail = m.createCounter("moderation_scan_enqueue_failures_total", {
    description: "Classifier frames or jobs that could not be written to Valkey",
  });
  const t0Fail = m.createCounter("moderation_t0_enqueue_failures_total", {
    description: "Failed attempts to enqueue a T0 job (retried until it lands)",
  });
  const t0 = m.createCounter("moderation_t0_total", { description: "T0 hash matches enqueued, by subject" });
  const prepublish = m.createCounter("moderation_prepublish_frames_total", {
    description: "Frames PDQ-checked before a VOD or clip is published",
  });
  return {
    frame: (outcome) => frames.add(1, { outcome }),
    classifierDropped: () => dropped.add(1),
    captureFailed: () => capture.add(1),
    scanEnqueueFailed: () => scanFail.add(1),
    t0EnqueueFailed: () => t0Fail.add(1),
    t0: (subject) => t0.add(1, { subject }),
    prepublishFrames: (subject, n) => prepublish.add(n, { subject }),
  };
}
