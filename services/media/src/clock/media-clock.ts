// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The media service's clock (ADR 0012, variant A2). W0 is fetched fresh for every ffmpeg start
 * (no background loop) and compared with the broadcast's previous W0: on one MediaMTX path session
 * it must not move, so any drift is exported as a gauge. Recorder run offsets live in memory for
 * the synchronous anchor; their durable copy is the run sidecar (`run.ts`).
 *
 * A path whose PDT is still moving (a publisher catching up after a slow start, `w0.ts`) is
 * polled until it settles rather than failed at once, so a consumer starts as soon as W0 is right
 * instead of after the supervisor's growing backoff. A source that never settles gets the newest W0 after
 * `acceptAfterMs`, so it still gets a ladder and an AAC copy.
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
  /** Tests: shorten the settle waits. */
  settle?: Partial<SettlePolicy>;
  /** Tests: the clock and sleep the settle wait uses. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SettlePolicy {
  /** How often an unsettled path is read again within one `w0()` call. */
  pollMs: number;
  /** How long one `w0()` call waits for a settled W0 before it throws (the caller retries). */
  waitMs: number;
  /** After this long unsettled (per broadcast), the newest W0 is taken anyway, with a warning. */
  acceptAfterMs: number;
}

/**
 * ffmpeg's `-re` catches up at 1.05× (its default `-readrate_catchup`): a 1.5 s late WHIP start
 * moves PDT for ~30 s, then the playlist window must clear it; one wait covers both.
 */
export const DEFAULT_SETTLE: SettlePolicy = { pollMs: 1_000, waitMs: 45_000, acceptAfterMs: 120_000 };

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
    sourceSegmentMs: () => null,
    setRunOffset: () => {},
    forget: () => {},
    sidecarOffsetMs: async () => null,
  };
}

export function createMediaClock(opts: MediaClockOptions): MediaClock {
  const metrics = opts.metrics ?? NOOP_CLOCK_METRICS;
  const fetchW0 = opts.fetchW0 ?? defaultFetchW0;
  const log = opts.logger.child({ component: "clock" });
  const settle = { ...DEFAULT_SETTLE, ...opts.settle };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const lastW0 = new Map<string, number>();
  /** The newest source segment's duration seen with each broadcast's last W0. */
  const segmentMs = new Map<string, number>();
  /** When a broadcast's W0 was first seen unsettled; cleared once it settles. */
  const unsettledSince = new Map<string, number>();
  const offsets = new Map<string, Map<string, number>>();

  const read = (path: string, requireSettled: boolean) =>
    fetchW0({ hlsBase: opts.hlsBase, path, password: opts.password, timeoutMs: opts.timeoutMs, requireSettled });

  /** A settled W0, waiting up to `settle.waitMs` for one; the newest after `acceptAfterMs`. */
  async function settledW0(broadcastId: string, path: string, consumer: W0Consumer): Promise<W0Result> {
    const deadline = now() + settle.waitMs;
    for (;;) {
      try {
        const r = await read(path, true);
        unsettledSince.delete(broadcastId);
        return r;
      } catch (err) {
        if (!(err instanceof W0Error) || err.reason !== "unsettled") throw err;
        const since = unsettledSince.get(broadcastId) ?? now();
        unsettledSince.set(broadcastId, since);
        if (now() - since >= settle.acceptAfterMs) {
          const r = await read(path, false);
          log.warn("W0 never settled; using the newest segment's", {
            broadcastId,
            consumer,
            errorCode: "W0_UNSETTLED",
            driftMs: r.settle ? Math.round(r.settle.driftMs) : null,
            spanMs: r.settle ? Math.round(r.settle.spanMs) : null,
          });
          return r;
        }
        if (now() + settle.pollMs > deadline) throw err;
        await sleep(settle.pollMs);
      }
    }
  }

  return {
    metrics,
    offsetMs(broadcastId, runId) {
      return offsets.get(broadcastId)?.get(runId) ?? 0;
    },
    async w0(broadcastId: string, path: string, consumer: W0Consumer): Promise<number> {
      let result: W0Result;
      try {
        result = await settledW0(broadcastId, path, consumer);
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
      segmentMs.set(broadcastId, result.segmentMs);
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
    sourceSegmentMs(broadcastId) {
      return segmentMs.get(broadcastId) ?? null;
    },
    forget(broadcastId) {
      lastW0.delete(broadcastId);
      segmentMs.delete(broadcastId);
      unsettledSince.delete(broadcastId);
      offsets.delete(broadcastId);
    },
    async sidecarOffsetMs(dir, runId) {
      return (await readSidecar(dir, runId))?.offsetMs ?? null;
    },
  };
}
