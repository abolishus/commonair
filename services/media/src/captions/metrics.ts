// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Captions counters (no-ops until an OpenTelemetry SDK is registered). Attributes are fixed enums only. */
import { meter } from "@commonair/observability";

export type DropReason = "timeout" | "unavailable" | "status" | "malformed" | "backoff" | "backlog" | "store" | "mask";

export interface CaptionsMetrics {
  /** A chunk transcribed and stored. */
  chunk(): void;
  /** A chunk that produced no cues because whisper was down, slow or backed off, or the store failed. */
  dropped(reason: DropReason): void;
  /** Whisper round trip, ms. */
  latency(ms: number): void;
  /** A stream that waited for a captions slot. */
  queued(): void;
  /** An audio reader run killed because its first PTS never arrived (its PCM would pile up). */
  originTimeout(): void;
}

export const NOOP_CAPTIONS_METRICS: CaptionsMetrics = {
  chunk: () => {},
  dropped: () => {},
  latency: () => {},
  queued: () => {},
  originTimeout: () => {},
};

export function createCaptionsMetrics(): CaptionsMetrics {
  const m = meter("media");
  const chunks = m.createCounter("media_captions_chunks_total", { description: "Caption chunks transcribed" });
  const dropped = m.createCounter("media_captions_chunks_dropped_total", {
    description: "Caption chunks dropped (whisper down, slow or backed off; backlog; store failure), by reason",
  });
  const latency = m.createHistogram("media_captions_whisper_latency_ms", {
    description: "Whisper round trip per chunk",
    unit: "ms",
  });
  const queued = m.createCounter("media_captions_streams_queued_total", {
    description: "Streams that waited for a captions slot (CAPTIONS_MAX_STREAMS)",
  });
  const originTimeouts = m.createCounter("media_captions_reader_origin_timeouts_total", {
    description: "Captions audio reader runs restarted because no first PTS arrived",
  });
  return {
    originTimeout: () => originTimeouts.add(1),
    chunk: () => chunks.add(1),
    dropped: (reason) => dropped.add(1, { reason }),
    latency: (ms) => latency.record(ms),
    queued: () => queued.add(1),
  };
}
