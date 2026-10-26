// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `load-sweep`: step the load up until one host stops coping. Two axes:
 *
 * - **viewers** (`--set steps=250,500,…`): the audience grows over a fixed set of streams;
 * - **streamers** (`--set streamerSteps=1,2,4,…`): live streams grow at a fixed audience per
 *   stream (`ladderViewers`, at or above `TRANSCODE_VIEWER_THRESHOLD` so ladders start), to find
 *   the transcode limit.
 *
 * Each step is judged against the load targets (`judgeLoad`'s by default), the target's CPU p95
 * and NIC; the sweep stops at the first step that breaks one and records which. A step where the
 * generator was the limit is inconclusive and also stops the sweep. Parameters, planning and
 * judging are pure.
 */
import {
  type GeneratorThresholds,
  type GeneratorVerdict,
  DEFAULT_GENERATOR_THRESHOLDS,
  describeLimit,
} from "./judge.ts";
import { DEFAULT_HTTP_PER_PROCESS } from "./shard.ts";

export class SweepParamError extends Error {
  override name = "SweepParamError";
}

export const DEFAULT_VIEWER_STEPS = [250, 500, 1000, 2000, 4000] as const;

export interface SweepThresholds {
  /** p95 glass-to-glass (browser viewers), ms; breaks at or above. */
  maxLatencyMs: number;
  /** p95 time to first frame, ms; breaks at or above. */
  maxTtffMs: number;
  /** Stalled time / watched time; breaks at or above. */
  maxStallRatio: number;
  /** Viewer errors per viewer; breaks above. 0 = any error breaks, like `judgeLoad`. */
  maxErrorRate: number;
  /** Target host CPU p95 (%); breaks above. */
  maxTargetCpuP95: number;
  /** Target NIC p95 at or above this share of its ceiling breaks (needs the ceiling). */
  targetNicFraction: number;
}

/** `judgeLoad`'s thresholds (`loadVerdict`), plus the host limits from the S1-a brief. */
export const DEFAULT_SWEEP_THRESHOLDS: SweepThresholds = {
  maxLatencyMs: 15_000,
  maxTtffMs: 15_000,
  maxStallRatio: 0.05,
  maxErrorRate: 0,
  maxTargetCpuP95: 85,
  targetNicFraction: 0.95,
};

export interface SweepParams {
  axis: "viewers" | "streamers";
  /** Viewers per step (viewers axis) or live streams per step (streamers axis). */
  steps: number[];
  /** Streams on the viewers axis. */
  streamers: number;
  /** Viewers per stream on the streamers axis. */
  ladderViewers: number;
  /** Hold per step once the viewers are started. */
  seconds: number;
  /** Pause between steps (viewers gone, streams still up). */
  cooldownSeconds: number;
  browserViewers: number;
  httpPerProcess: number;
  thresholds: SweepThresholds;
  generator: GeneratorThresholds;
}

export const SWEEP_PARAM_KEYS = [
  "steps",
  "streamerSteps",
  "streamers",
  "ladderViewers",
  "seconds",
  "cooldownSeconds",
  "browserViewers",
  "httpPerProcess",
  "maxLatencyMs",
  "maxTtffMs",
  "maxStallRatio",
  "maxErrorRate",
  "maxTargetCpuP95",
  "targetNicFraction",
  "generatorCpuP95",
  "generatorNicHeadroom",
] as const;

/**
 * Parse a step list (`250,500,1000`): positive integers, strictly increasing, at least one.
 * Pure; throws `SweepParamError` naming the key.
 */
export function planSteps(raw: string, key = "steps"): number[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) throw new SweepParamError(`--set ${key}: no steps given`);
  const steps = parts.map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) throw new SweepParamError(`--set ${key}: "${s}" is not a positive integer`);
    return n;
  });
  for (let i = 1; i < steps.length; i++) {
    if ((steps[i] as number) <= (steps[i - 1] as number)) {
      throw new SweepParamError(`--set ${key}: steps must increase (${steps[i - 1]} then ${steps[i]})`);
    }
  }
  return steps;
}

function num(
  params: Readonly<Record<string, string>>,
  key: string,
  fallback: number,
  check: { min: number; integer?: boolean; max?: number },
): number {
  const raw = params[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  const bad =
    raw.trim() === "" ||
    !Number.isFinite(n) ||
    n < check.min ||
    (check.max !== undefined && n > check.max) ||
    (check.integer === true && !Number.isInteger(n));
  if (bad) {
    const range = check.max === undefined ? `≥ ${check.min}` : `in [${check.min}, ${check.max}]`;
    throw new SweepParamError(`--set ${key}=${raw}: expected ${check.integer ? "an integer" : "a number"} ${range}`);
  }
  return n;
}

export function parseSweepParams(params: Readonly<Record<string, string>>): SweepParams {
  if (params.steps !== undefined && params.streamerSteps !== undefined) {
    throw new SweepParamError("--set steps and --set streamerSteps are exclusive (one axis per sweep)");
  }
  const axis = params.streamerSteps !== undefined ? "streamers" : "viewers";
  const steps =
    axis === "streamers"
      ? planSteps(params.streamerSteps ?? "", "streamerSteps")
      : params.steps !== undefined
        ? planSteps(params.steps, "steps")
        : [...DEFAULT_VIEWER_STEPS];
  const int = (key: string, fallback: number, min: number) => num(params, key, fallback, { min, integer: true });
  const d = DEFAULT_SWEEP_THRESHOLDS;
  const g = DEFAULT_GENERATOR_THRESHOLDS;
  return {
    axis,
    steps,
    streamers: int("streamers", 20, 1),
    ladderViewers: int("ladderViewers", 60, 1),
    seconds: int("seconds", 120, 1),
    cooldownSeconds: int("cooldownSeconds", 30, 0),
    browserViewers: int("browserViewers", 10, 0),
    httpPerProcess: int("httpPerProcess", DEFAULT_HTTP_PER_PROCESS, 1),
    thresholds: {
      maxLatencyMs: num(params, "maxLatencyMs", d.maxLatencyMs, { min: 1 }),
      maxTtffMs: num(params, "maxTtffMs", d.maxTtffMs, { min: 1 }),
      maxStallRatio: num(params, "maxStallRatio", d.maxStallRatio, { min: 0, max: 1 }),
      maxErrorRate: num(params, "maxErrorRate", d.maxErrorRate, { min: 0, max: 1 }),
      maxTargetCpuP95: num(params, "maxTargetCpuP95", d.maxTargetCpuP95, { min: 1, max: 100 }),
      targetNicFraction: num(params, "targetNicFraction", d.targetNicFraction, { min: 0.01, max: 1 }),
    },
    generator: {
      maxCpuP95: num(params, "generatorCpuP95", g.maxCpuP95, { min: 1, max: 100 }),
      nicHeadroom: num(params, "generatorNicHeadroom", g.nicHeadroom, { min: 0, max: 0.99 }),
    },
  };
}

/** Streams and viewers of one step. Pure. */
export function stepShape(p: SweepParams, step: number): { streamers: number; viewers: number } {
  return p.axis === "viewers"
    ? { streamers: p.streamers, viewers: step }
    : { streamers: step, viewers: step * p.ladderViewers };
}

/** What one step measured, as the judge needs it. */
export interface StepMeasure {
  viewers: number;
  started: number;
  browserViewers: number;
  glassToGlassP95Ms: number | null;
  ttffP95Ms: number | null;
  stallRatio: number;
  errors: number;
  /** Null when the target was not sampled (no SSH, failed reads). */
  targetCpuP95: number | null;
  /** The target's busiest interface, transmit p95. */
  targetNicP95BytesPerSecond: number | null;
  targetNicCeilingBytesPerSecond: number | null;
  generator: GeneratorVerdict;
}

export type BreachMetric = "started" | "latency" | "ttff" | "stalls" | "errors" | "target_cpu" | "target_nic";

export interface Breach {
  metric: BreachMetric;
  value: number | null;
  threshold: number;
}

export type StepStatus = "pass" | "break" | "inconclusive";

export interface StepVerdict {
  status: StepStatus;
  /** Every target that broke in this step (ties are reported together). */
  breaches: Breach[];
}

/** Judge one step. Pure. */
export function judgeStep(m: StepMeasure, t: SweepThresholds): StepVerdict {
  const breaches: Breach[] = [];
  if (m.started < m.viewers) breaches.push({ metric: "started", value: m.started, threshold: m.viewers });
  // Without browser viewers there is no glass-to-glass measurement; that is not a break.
  if (m.browserViewers > 0 && (m.glassToGlassP95Ms === null || m.glassToGlassP95Ms >= t.maxLatencyMs)) {
    breaches.push({ metric: "latency", value: m.glassToGlassP95Ms, threshold: t.maxLatencyMs });
  }
  if (m.viewers > 0 && (m.ttffP95Ms === null || m.ttffP95Ms >= t.maxTtffMs)) {
    breaches.push({ metric: "ttff", value: m.ttffP95Ms, threshold: t.maxTtffMs });
  }
  if (m.stallRatio >= t.maxStallRatio)
    breaches.push({ metric: "stalls", value: m.stallRatio, threshold: t.maxStallRatio });
  const errorRate = m.viewers > 0 ? m.errors / m.viewers : m.errors > 0 ? 1 : 0;
  if (errorRate > t.maxErrorRate) breaches.push({ metric: "errors", value: errorRate, threshold: t.maxErrorRate });
  if (m.targetCpuP95 !== null && m.targetCpuP95 > t.maxTargetCpuP95) {
    breaches.push({ metric: "target_cpu", value: m.targetCpuP95, threshold: t.maxTargetCpuP95 });
  }
  if (
    m.targetNicP95BytesPerSecond !== null &&
    m.targetNicCeilingBytesPerSecond !== null &&
    m.targetNicP95BytesPerSecond >= m.targetNicCeilingBytesPerSecond * t.targetNicFraction
  ) {
    breaches.push({
      metric: "target_nic",
      value: m.targetNicP95BytesPerSecond,
      threshold: m.targetNicCeilingBytesPerSecond * t.targetNicFraction,
    });
  }
  const status: StepStatus = m.generator.inconclusive ? "inconclusive" : breaches.length > 0 ? "break" : "pass";
  return { status, breaches };
}

/** One row of the report's `sweep` section. */
export interface SweepRow {
  step: number;
  axis: SweepParams["axis"];
  streamers: number;
  viewers: number;
  started: number;
  status: StepStatus;
  breaches: Breach[];
  /** Generator limits when inconclusive (human-readable). */
  generatorLimits: string[];
  /** Streams with a transcode ladder at the end of the hold (null = not checked). */
  ladders: number | null;
  glassToGlassP95Ms: number | null;
  ttffP95Ms: number | null;
  stallRatio: number;
  errors: number;
  /** Failed heartbeats (a rate-limited generator address shows here first). */
  heartbeatErrors: number;
  targetCpuP95: number | null;
  targetNicTxP95BytesPerSecond: number | null;
  /** Origin egress per viewer (Prometheus or viewer-reported). */
  perViewerEgressBytesPerSecond: number;
  /** The target's NIC transmit (all interfaces) per viewer, host-measured. */
  perViewerNicTxBytesPerSecond: number | null;
  postgresCpuMeanPercent: number | null;
  valkeyCpuMeanPercent: number | null;
  generatorCpuP95: number | null;
}

/** True once the sweep must not go on. */
export const stopsSweep = (row: Pick<SweepRow, "status">): boolean => row.status !== "pass";

export interface SweepSummary {
  axis: SweepParams["axis"];
  /** `completed`: every step passed; else what stopped the sweep. */
  outcome: "completed" | "break" | "inconclusive";
  stepsRun: number;
  lastPassing: SweepRow | null;
  firstFailing: SweepRow | null;
  /** The metrics that broke at the first failing step (all of them, if several broke together). */
  brokeBy: BreachMetric[];
  /** At the last passing step. */
  perViewerEgressBytesPerSecond: number | null;
  perViewerNicTxBytesPerSecond: number | null;
  targetCpuP95: number | null;
}

/** The stop rule over the rows run so far: the first non-passing row ends the sweep. Pure. */
export function summarizeSweep(axis: SweepParams["axis"], rows: readonly SweepRow[]): SweepSummary {
  let lastPassing: SweepRow | null = null;
  let firstFailing: SweepRow | null = null;
  let stepsRun = 0;
  for (const row of rows) {
    stepsRun++;
    if (stopsSweep(row)) {
      firstFailing = row;
      break;
    }
    lastPassing = row;
  }
  return {
    axis,
    outcome: firstFailing === null ? "completed" : firstFailing.status === "inconclusive" ? "inconclusive" : "break",
    stepsRun,
    lastPassing,
    firstFailing,
    brokeBy: firstFailing?.breaches.map((b) => b.metric) ?? [],
    perViewerEgressBytesPerSecond: lastPassing?.perViewerEgressBytesPerSecond ?? null,
    perViewerNicTxBytesPerSecond: lastPassing?.perViewerNicTxBytesPerSecond ?? null,
    targetCpuP95: lastPassing?.targetCpuP95 ?? null,
  };
}

/** Video renditions that only a transcode ladder produces. */
export const LADDER_RENDITIONS: readonly string[] = ["1080p", "720p", "480p"];

/** Whether `playback.start`'s `renditions` show a ladder (absent or `source` only = none). Pure. */
export function hasLadder(renditions: readonly string[] | null | undefined): boolean {
  return (renditions ?? []).some((r) => LADDER_RENDITIONS.includes(r));
}

/** Mean CPU of the container whose name contains `service` (`commonair-postgres`, …). Pure. */
export function containerCpuMean(
  cpu: Readonly<Record<string, { meanCpuPercent: number }>>,
  service: string,
): number | null {
  const hit = Object.entries(cpu).find(([name]) => name.includes(service));
  return hit ? hit[1].meanCpuPercent : null;
}

/** The parts of a load result a sweep row is built from (structural, so this module stays pure). */
export interface StepResultInput {
  viewers: number;
  all: { started: number; stallRatio: number; errors: number; ttff: { p95: number | null } };
  browser: { viewers: number; latency: { p95: number | null } };
  report: { egress: { perViewerBytesPerSecond: number } };
  cpu: Readonly<Record<string, { meanCpuPercent: number }>>;
  target: {
    cpuP95: number | null;
    /** Transmit p95 of the busiest interface. */
    busiestTxP95: number | null;
    /** Mean transmit over all interfaces. */
    totalTxMean: number | null;
  };
  generatorCpuP95: number | null;
  generator: GeneratorVerdict;
  heartbeatErrors: number;
}

/** Judge a step and build its report row. Pure. */
export function sweepRow(
  p: Pick<SweepParams, "axis" | "thresholds">,
  step: number,
  shape: { streamers: number; viewers: number },
  r: StepResultInput,
  targetNicCeilingBytesPerSecond: number | null,
  ladders: number | null,
): SweepRow {
  const verdict = judgeStep(
    {
      viewers: r.viewers,
      started: r.all.started,
      browserViewers: r.browser.viewers,
      glassToGlassP95Ms: r.browser.latency.p95,
      ttffP95Ms: r.all.ttff.p95,
      stallRatio: r.all.stallRatio,
      errors: r.all.errors,
      targetCpuP95: r.target.cpuP95,
      targetNicP95BytesPerSecond: r.target.busiestTxP95,
      targetNicCeilingBytesPerSecond,
      generator: r.generator,
    },
    p.thresholds,
  );
  return {
    step,
    axis: p.axis,
    streamers: shape.streamers,
    viewers: shape.viewers,
    started: r.all.started,
    status: verdict.status,
    breaches: verdict.breaches,
    generatorLimits: r.generator.limits.map(describeLimit),
    ladders,
    glassToGlassP95Ms: r.browser.latency.p95,
    ttffP95Ms: r.all.ttff.p95,
    stallRatio: r.all.stallRatio,
    errors: r.all.errors,
    heartbeatErrors: r.heartbeatErrors,
    targetCpuP95: r.target.cpuP95,
    targetNicTxP95BytesPerSecond: r.target.busiestTxP95,
    perViewerEgressBytesPerSecond: r.report.egress.perViewerBytesPerSecond,
    perViewerNicTxBytesPerSecond:
      r.target.totalTxMean !== null && r.viewers > 0 ? r.target.totalTxMean / r.viewers : null,
    postgresCpuMeanPercent: containerCpuMean(r.cpu, "postgres"),
    valkeyCpuMeanPercent: containerCpuMean(r.cpu, "valkey"),
    generatorCpuP95: r.generatorCpuP95,
  };
}
