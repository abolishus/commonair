// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure parts of the `clock-skew` scenario (ADR 0012 decision 5). A sample is one decoded segment:
 * its first frame's burned-in capture time (the strip) and the segment's PDT. `e = PDT − strip` is
 * that rendition's clock error at that instant; the streamer's own clock cancels out of every
 * comparison, which is always between two `e`s of the same capture time.
 *
 * - Cross-rendition skew, per source sample: `max(e) − min(e)` over the source and every rung
 *   sample paired with it (same strip time, or the nearest within one segment).
 * - Live-to-VOD skew, per VOD sample: `|e_vod − e_source|` against the nearest source sample.
 */
import { percentile } from "./metrics.ts";

export type ClockProtocol = "rtmp" | "whip";

export interface ClockSample {
  /** `source`, a rung (`1080p`, `720p`, `480p`), `aac` (the WHIP AAC copy) or `vod`. */
  rendition: string;
  /** Capture time burned into the segment's first frame, epoch ms. */
  stripMs: number;
  /** The segment's EXT-X-PROGRAM-DATE-TIME, epoch ms. */
  pdtMs: number;
}

/** A rendition's clock error at one capture instant. */
export const errorOf = (s: Pick<ClockSample, "pdtMs" | "stripMs">) => s.pdtMs - s.stripMs;

/** The sample of `pool` whose strip time is nearest `stripMs`, if within `maxGapMs`. */
export function nearest<T extends Pick<ClockSample, "stripMs">>(
  pool: readonly T[],
  stripMs: number,
  maxGapMs: number,
): T | null {
  let best: T | null = null;
  let bestGap = Infinity;
  for (const s of pool) {
    const gap = Math.abs(s.stripMs - stripMs);
    if (gap < bestGap) {
      best = s;
      bestGap = gap;
    }
  }
  return best && bestGap <= maxGapMs ? best : null;
}

/**
 * Cross-rendition skew per source instant: each rung sample pairs with the nearest source sample
 * (within `maxGapMs`, about one segment); a source sample with at least one paired rung sample
 * yields `max(e) − min(e)` over itself and its rungs (several samples of one rung: their spread
 * counts too).
 */
export function crossRenditionSkews(samples: readonly ClockSample[], maxGapMs: number): number[] {
  const source = samples.filter((s) => s.rendition === "source");
  const groups = new Map<ClockSample, number[]>();
  for (const s of samples) {
    if (s.rendition === "source" || s.rendition === "vod") continue;
    const anchor = nearest(source, s.stripMs, maxGapMs);
    if (!anchor) continue;
    const list = groups.get(anchor) ?? [errorOf(anchor)];
    list.push(errorOf(s));
    groups.set(anchor, list);
  }
  return [...groups.values()].map((es) => Math.max(...es) - Math.min(...es));
}

/** Live-to-VOD skew per VOD sample: `|e_vod − e_source|` for the nearest source capture time. */
export function liveToVodSkews(
  source: readonly ClockSample[],
  vod: readonly ClockSample[],
  maxGapMs: number,
): number[] {
  return vod.flatMap((v) => {
    const s = nearest(source, v.stripMs, maxGapMs);
    return s ? [Math.abs(errorOf(v) - errorOf(s))] : [];
  });
}

export interface Interval {
  from: number;
  to: number;
}

/**
 * Time a rendition was measurably present: its samples' strip times merged into intervals
 * wherever consecutive samples are at most `gapMs` apart (each sample covers itself only).
 */
export function coverage(stripTimes: readonly number[], gapMs: number): Interval[] {
  const sorted = [...stripTimes].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (const t of sorted) {
    const last = out.at(-1);
    if (last && t - last.to <= gapMs) last.to = t;
    else out.push({ from: t, to: t });
  }
  return out;
}

/** Total covered milliseconds, optionally inside `[window.from, window.to]`. */
export function coveredMs(intervals: readonly Interval[], window?: Interval): number {
  let total = 0;
  for (const i of intervals) {
    const from = window ? Math.max(i.from, window.from) : i.from;
    const to = window ? Math.min(i.to, window.to) : i.to;
    if (to > from) total += to - from;
  }
  return total;
}

export interface CoverageRule {
  /** Each rendition must be covered at least this long overall. */
  minTotalMs: number;
  /** Strip time the ladder came back after its restart; null when there was no restart. */
  restartAt: number | null;
  /** The window after `restartAt` each rung must cover… */
  afterRestartMs: number;
  /** …at least this fraction of. */
  afterRestartFraction: number;
  /** Largest gap between samples still counted as continuous. */
  gapMs: number;
}

export interface RenditionCoverage {
  rendition: string;
  samples: number;
  totalMs: number;
  afterRestartMs: number | null;
  ok: boolean;
}

/** Per rendition (VOD excluded): covered long enough overall and right after the ladder restart. */
export function judgeCoverage(samples: readonly ClockSample[], rule: CoverageRule): RenditionCoverage[] {
  const byRendition = new Map<string, number[]>();
  for (const s of samples) {
    if (s.rendition === "vod") continue;
    byRendition.set(s.rendition, [...(byRendition.get(s.rendition) ?? []), s.stripMs]);
  }
  return [...byRendition.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rendition, times]) => {
      const intervals = coverage(times, rule.gapMs);
      const totalMs = coveredMs(intervals);
      const after =
        rule.restartAt === null
          ? null
          : coveredMs(intervals, { from: rule.restartAt, to: rule.restartAt + rule.afterRestartMs });
      const afterOk = after === null || after >= rule.afterRestartMs * rule.afterRestartFraction;
      return {
        rendition,
        samples: times.length,
        totalMs,
        afterRestartMs: after,
        ok: totalMs >= rule.minTotalMs && afterOk,
      };
    });
}

export interface SkewSummary {
  samples: number;
  p95: number | null;
  max: number | null;
}

const summarizeSkew = (values: readonly number[]): SkewSummary => ({
  samples: values.length,
  p95: values.length ? percentile([...values], 95) : null,
  max: values.length ? Math.max(...values) : null,
});

export interface ProtocolClock {
  protocol: ClockProtocol;
  /** Live samples of every rendition (source and rungs). */
  live: readonly ClockSample[];
  /** Samples of the published VOD. */
  vod: readonly ClockSample[];
}

export interface ProtocolSkew {
  protocol: ClockProtocol;
  crossRendition: SkewSummary;
  liveToVod: SkewSummary;
  renditions: string[];
}

export interface SkewOptions {
  /** Pairing window for rung samples (about one live segment). */
  liveGapMs: number;
  /** Pairing window for VOD samples (about one VOD segment). */
  vodGapMs: number;
}

export function protocolSkew(p: ProtocolClock, opts: SkewOptions): ProtocolSkew {
  const source = p.live.filter((s) => s.rendition === "source");
  return {
    protocol: p.protocol,
    crossRendition: summarizeSkew(crossRenditionSkews(p.live, opts.liveGapMs)),
    liveToVod: summarizeSkew(liveToVodSkews(source, p.vod, opts.vodGapMs)),
    renditions: [...new Set(p.live.map((s) => s.rendition))].sort(),
  };
}

export interface SkewMetric {
  name: string;
  value: number | null;
}

/**
 * The scenario's metrics: per protocol (`<metric>.<protocol>`) and overall (the worst protocol),
 * `crossRenditionSkewP95Ms`, `crossRenditionSkewMaxMs`, `liveToVodSkewP95Ms`, `liveToVodSkewMaxMs`.
 */
export function skewMetrics(results: readonly ProtocolSkew[]): SkewMetric[] {
  const fields = [
    ["crossRenditionSkewP95Ms", (r: ProtocolSkew) => r.crossRendition.p95],
    ["crossRenditionSkewMaxMs", (r: ProtocolSkew) => r.crossRendition.max],
    ["liveToVodSkewP95Ms", (r: ProtocolSkew) => r.liveToVod.p95],
    ["liveToVodSkewMaxMs", (r: ProtocolSkew) => r.liveToVod.max],
  ] as const;
  const out: SkewMetric[] = [];
  for (const [name, get] of fields) {
    const values = results.map(get);
    for (const [i, r] of results.entries()) out.push({ name: `${name}.${r.protocol}`, value: values[i] ?? null });
    const known = values.filter((v): v is number => v !== null);
    out.push({ name, value: known.length === results.length && known.length > 0 ? Math.max(...known) : null });
  }
  return out;
}

/** Rendition name from an origin variant URI: `720p/…` → `720p`, a bare file → `source`. */
export function renditionOfUri(uri: string): string {
  const path = uri.split("?")[0] ?? "";
  const dir = path.includes("/") ? (path.split("/").at(-2) ?? "") : "";
  return /^(1080p|720p|480p|aac)$/.test(dir) ? dir : "source";
}
