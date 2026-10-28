// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The media service's clock (ADR 0012, variant A2). W0 is fetched fresh for every ffmpeg start
 * (no background loop) and compared with the broadcast's previous W0: on one MediaMTX path session
 * it must not move, so any drift is exported as a gauge. Recorder run offsets live in memory for
 * the synchronous anchor; their durable copy is the run sidecar (`run.ts`).
 */
import type { Logger } from "@commonair/observability";
import { IDENTITY_CLOCK, type ClockAnchor, type MediaClock, type W0Consumer } from "./anchor.ts";
import { NOOP_CLOCK_METRICS, type ClockMetrics } from "./metrics.ts";
import { readSidecar } from "./run.ts";
import { fetchW0 as defaultFetchW0, W0Error, type FetchW0Options, type W0Result } from "./w0.ts";

export interface MediaClockOptions {
  /** MEDIAMTX_HLS_URL. */
  hlsBase: string;
  /** MEDIA_INTERNAL_PASSWORD. */
  password: string;
  logger: Logger;
  metrics?: ClockMetrics;
  timeoutMs?: number;
  /** Tests: replace the LL-HLS fetch. */
  fetchW0?: (opts: FetchW0Options) => Promise<W0Result>;
}

/**
 * A clock that never has W0 (tests and tools that do not care about the clock): readers that need
 * W0 cannot start, the recorder keeps raw times, or `anchor`'s offsets when one is given.
 */
export function offlineClock(anchor: ClockAnchor = IDENTITY_CLOCK): MediaClock {
  return {
    metrics: NOOP_CLOCK_METRICS,
    offsetMs: (b, r) => anchor.offsetMs(b, r),
    w0: async () => {
      throw new W0Error("no W0 on an offline clock", "http");
    },
    setRunOffset: () => {},
    forget: () => {},
    sidecarOffsetMs: async () => null,
  };
}

export function createMediaClock(opts: MediaClockOptions): MediaClock {
  const metrics = opts.metrics ?? NOOP_CLOCK_METRICS;
  const fetchW0 = opts.fetchW0 ?? defaultFetchW0;
  const log = opts.logger.child({ component: "clock" });
  const lastW0 = new Map<string, number>();
  const offsets = new Map<string, Map<string, number>>();

  return {
    metrics,
    offsetMs(broadcastId, runId) {
      return offsets.get(broadcastId)?.get(runId) ?? 0;
    },
    async w0(broadcastId: string, path: string, consumer: W0Consumer): Promise<number> {
      let result: W0Result;
      try {
        result = await fetchW0({ hlsBase: opts.hlsBase, path, password: opts.password, timeoutMs: opts.timeoutMs });
      } catch (err) {
        metrics.w0Failure(consumer);
        // W0Error messages name the path only, never a URL with credentials.
        log.warn("W0 unavailable", {
          broadcastId,
          consumer,
          reason: err instanceof W0Error ? err.reason : "error",
          error: err instanceof W0Error ? err.message : "unexpected",
        });
        throw err;
      }
      const prev = lastW0.get(broadcastId);
      if (prev !== undefined) metrics.w0Drift(result.w0Ms - prev);
      lastW0.set(broadcastId, result.w0Ms);
      return result.w0Ms;
    },
    setRunOffset(broadcastId, runId, offsetMs) {
      let runs = offsets.get(broadcastId);
      if (offsetMs === null) {
        runs?.delete(runId);
        return;
      }
      if (!runs) offsets.set(broadcastId, (runs = new Map()));
      runs.set(runId, offsetMs);
    },
    forget(broadcastId) {
      lastW0.delete(broadcastId);
      offsets.delete(broadcastId);
    },
    async sidecarOffsetMs(dir, runId) {
      return (await readSidecar(dir, runId))?.offsetMs ?? null;
    },
  };
}
