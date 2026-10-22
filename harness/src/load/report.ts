// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `load` section of a run report (docs/testing/e6-selectors.md, "Load test"): origin egress
 * (total, per second, per viewer, by source), CPU per container (average and max), p95
 * glass-to-glass latency, p95 time to first frame, stall ratio and count, and errors. Pure.
 */
import type { ViewerAggregate } from "../viewer.ts";

export interface CpuStats {
  meanCpuPercent: number;
  peakCpuPercent: number;
  samples: number;
}

/** What the load run measured; `buildLoadReport` turns it into the report section. */
export interface LoadMeasurements {
  streamers: number;
  viewers: number;
  /** Seconds the audience was held (the egress window). */
  windowSeconds: number;
  all: ViewerAggregate;
  /** Browser viewers: their latency is true glass-to-glass (decoded pixels). */
  browser: ViewerAggregate;
  egressBySource: Record<string, number>;
  egressMethod: "prometheus" | "viewer-reported";
  cpu: Record<string, CpuStats>;
  /** HTTP viewer processes besides this one (0 = all in-process). */
  shards: number;
}

export interface EgressSource {
  bytes: number;
  bytesPerSecond: number;
}

export interface LoadReport {
  streamers: number;
  viewers: number;
  started: number;
  windowSeconds: number;
  shards: number;
  egress: {
    method: LoadMeasurements["egressMethod"];
    totalBytes: number;
    bytesPerSecond: number;
    /** Over every viewer the run opened (a viewer that never started still counts). */
    perViewerBytes: number;
    perViewerBytesPerSecond: number;
    bySource: Record<string, EgressSource>;
  };
  cpu: Record<string, { avgPercent: number; maxPercent: number; samples: number }>;
  glassToGlassP95Ms: number | null;
  ttffP95Ms: number | null;
  stallRatio: number;
  stallCount: number;
  errors: number;
}

const perSecond = (bytes: number, seconds: number) => (seconds > 0 ? bytes / seconds : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

export function buildLoadReport(m: LoadMeasurements): LoadReport {
  const totalBytes = Object.values(m.egressBySource).reduce((s, b) => s + b, 0);
  const perViewerBytes = m.viewers > 0 ? totalBytes / m.viewers : 0;
  return {
    streamers: m.streamers,
    viewers: m.viewers,
    started: m.all.started,
    windowSeconds: round2(m.windowSeconds),
    shards: m.shards,
    egress: {
      method: m.egressMethod,
      totalBytes,
      bytesPerSecond: round2(perSecond(totalBytes, m.windowSeconds)),
      perViewerBytes: round2(perViewerBytes),
      perViewerBytesPerSecond: round2(perSecond(perViewerBytes, m.windowSeconds)),
      bySource: Object.fromEntries(
        Object.entries(m.egressBySource).map(([source, bytes]) => [
          source,
          { bytes, bytesPerSecond: round2(perSecond(bytes, m.windowSeconds)) },
        ]),
      ),
    },
    cpu: Object.fromEntries(
      Object.entries(m.cpu).map(([name, c]) => [
        name,
        { avgPercent: round2(c.meanCpuPercent), maxPercent: round2(c.peakCpuPercent), samples: c.samples },
      ]),
    ),
    glassToGlassP95Ms: m.browser.latency.p95,
    ttffP95Ms: m.all.ttff.p95,
    stallRatio: m.all.stallRatio,
    stallCount: m.all.stalls,
    errors: m.all.errors,
  };
}

/** The spec's pass criteria: hard = every viewer started; soft = stalls, latency, errors. Pure. */
export function loadVerdict(r: LoadReport): {
  everyViewerStarted: boolean;
  stallRatioOk: boolean;
  latencyOk: boolean;
  ttffOk: boolean;
  noErrors: boolean;
} {
  return {
    everyViewerStarted: r.started === r.viewers,
    stallRatioOk: r.stallRatio < 0.05,
    latencyOk: (r.glassToGlassP95Ms ?? Number.POSITIVE_INFINITY) < 15_000,
    ttffOk: (r.ttffP95Ms ?? Number.POSITIVE_INFINITY) < 15_000,
    noErrors: r.errors === 0,
  };
}
