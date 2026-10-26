// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { parseArgs } from "../src/args.ts";
import type { GeneratorVerdict } from "../src/load/judge.ts";
import {
  DEFAULT_SWEEP_THRESHOLDS,
  DEFAULT_VIEWER_STEPS,
  type StepMeasure,
  type StepResultInput,
  type SweepRow,
  SweepParamError,
  containerCpuMean,
  hasLadder,
  judgeStep,
  parseSweepParams,
  planSteps,
  stepShape,
  summarizeSweep,
  sweepRow,
} from "../src/load/sweep.ts";

const CONCLUSIVE: GeneratorVerdict = { inconclusive: false, limits: [], notes: [] };

const good: StepMeasure = {
  viewers: 1000,
  started: 1000,
  browserViewers: 10,
  glassToGlassP95Ms: 6_000,
  ttffP95Ms: 3_000,
  stallRatio: 0.01,
  errors: 0,
  targetCpuP95: 50,
  targetNicP95BytesPerSecond: 100_000_000,
  targetNicCeilingBytesPerSecond: 250_000_000,
  generator: CONCLUSIVE,
};

describe("step planning", () => {
  test("positive, strictly increasing integers", () => {
    expect(planSteps("250,500, 1000")).toEqual([250, 500, 1000]);
    expect(planSteps("7")).toEqual([7]);
  });

  test("empty, non-increasing and non-integer steps are refused with the key named", () => {
    expect(() => planSteps("")).toThrow(/no steps/);
    expect(() => planSteps(" , ")).toThrow(SweepParamError);
    expect(() => planSteps("500,250")).toThrow(/must increase \(500 then 250\)/);
    expect(() => planSteps("250,250")).toThrow(/must increase/);
    expect(() => planSteps("1.5", "streamerSteps")).toThrow(/streamerSteps: "1.5"/);
    expect(() => planSteps("0,1")).toThrow(/positive/);
  });

  test("defaults: viewers axis 250 → 4000 over 20 streams, judgeLoad's thresholds", () => {
    const p = parseSweepParams({});
    expect(p.axis).toBe("viewers");
    expect(p.steps).toEqual([...DEFAULT_VIEWER_STEPS]);
    expect(p).toMatchObject({ streamers: 20, seconds: 120, cooldownSeconds: 30, browserViewers: 10 });
    expect(p.thresholds).toEqual(DEFAULT_SWEEP_THRESHOLDS);
    expect(p.thresholds).toMatchObject({
      maxLatencyMs: 15_000,
      maxTtffMs: 15_000,
      maxStallRatio: 0.05,
      maxErrorRate: 0,
    });
    expect(p.generator).toEqual({ maxCpuP95: 80, nicHeadroom: 0.15 });
  });

  test("the streamers axis, and every threshold overridable", () => {
    const p = parseSweepParams({
      streamerSteps: "1,2,4",
      ladderViewers: "55",
      maxLatencyMs: "10000",
      maxStallRatio: "0.02",
      maxErrorRate: "0.001",
      maxTargetCpuP95: "75",
      targetNicFraction: "0.9",
      generatorCpuP95: "70",
      generatorNicHeadroom: "0.2",
      cooldownSeconds: "0",
    });
    expect(p.axis).toBe("streamers");
    expect(p.steps).toEqual([1, 2, 4]);
    expect(p.thresholds).toMatchObject({
      maxLatencyMs: 10_000,
      maxStallRatio: 0.02,
      maxErrorRate: 0.001,
      maxTargetCpuP95: 75,
      targetNicFraction: 0.9,
    });
    expect(p.generator).toEqual({ maxCpuP95: 70, nicHeadroom: 0.2 });
    expect(stepShape(p, 4)).toEqual({ streamers: 4, viewers: 220 });
    expect(stepShape(parseSweepParams({ streamers: "8" }), 500)).toEqual({ streamers: 8, viewers: 500 });
  });

  test("one axis per sweep; bad values refused", () => {
    expect(() => parseSweepParams({ steps: "1", streamerSteps: "1" })).toThrow(/exclusive/);
    expect(() => parseSweepParams({ streamerSteps: "" })).toThrow(/streamerSteps: no steps/);
    expect(() => parseSweepParams({ maxStallRatio: "2" })).toThrow(/maxStallRatio=2/);
    expect(() => parseSweepParams({ seconds: "0" })).toThrow(/seconds=0/);
    expect(() => parseSweepParams({ streamers: "1.5" })).toThrow(/integer/);
  });

  test("the CLI passes the sweep keys through --set", () => {
    expect(parseArgs(["run", "load-sweep", "--set", "steps=250,500", "--set=maxTargetCpuP95=80"])).toMatchObject({
      kind: "run",
      scenarios: ["load-sweep"],
      params: { steps: "250,500", maxTargetCpuP95: "80" },
    });
  });
});

describe("judging one step", () => {
  const t = DEFAULT_SWEEP_THRESHOLDS;

  test("within every target passes", () => {
    expect(judgeStep(good, t)).toEqual({ status: "pass", breaches: [] });
  });

  test("each target breaks on its own, at its boundary", () => {
    const one = (m: Partial<StepMeasure>) => judgeStep({ ...good, ...m }, t).breaches.map((b) => b.metric);
    expect(one({ started: 999 })).toEqual(["started"]);
    expect(one({ glassToGlassP95Ms: 14_999 })).toEqual([]);
    expect(one({ glassToGlassP95Ms: 15_000 })).toEqual(["latency"]);
    expect(one({ ttffP95Ms: 15_000 })).toEqual(["ttff"]);
    expect(one({ stallRatio: 0.0499 })).toEqual([]);
    expect(one({ stallRatio: 0.05 })).toEqual(["stalls"]);
    expect(one({ errors: 1 })).toEqual(["errors"]);
    expect(one({ targetCpuP95: 85 })).toEqual([]);
    expect(one({ targetCpuP95: 85.01 })).toEqual(["target_cpu"]);
    expect(one({ targetNicP95BytesPerSecond: 237_499_999 })).toEqual([]);
    expect(one({ targetNicP95BytesPerSecond: 237_500_000 })).toEqual(["target_nic"]);
  });

  test("missing measurements: no browsers = no latency rule; no target sampling = no host rules", () => {
    const one = (m: Partial<StepMeasure>) => judgeStep({ ...good, ...m }, t).breaches.map((b) => b.metric);
    expect(one({ browserViewers: 0, glassToGlassP95Ms: null })).toEqual([]);
    expect(one({ glassToGlassP95Ms: null })).toEqual(["latency"]);
    expect(one({ targetCpuP95: null, targetNicP95BytesPerSecond: null })).toEqual([]);
    expect(one({ targetNicCeilingBytesPerSecond: null, targetNicP95BytesPerSecond: 1e12 })).toEqual([]);
  });

  test("an error rate threshold tolerates that share of errors", () => {
    const loose = { ...t, maxErrorRate: 0.001 };
    expect(judgeStep({ ...good, errors: 1 }, loose).status).toBe("pass");
    expect(judgeStep({ ...good, errors: 2 }, loose).breaches).toEqual([
      { metric: "errors", value: 0.002, threshold: 0.001 },
    ]);
  });

  test("several targets breaking together are all reported", () => {
    const v = judgeStep({ ...good, stallRatio: 0.2, targetCpuP95: 99, errors: 3 }, t);
    expect(v.status).toBe("break");
    expect(v.breaches.map((b) => b.metric)).toEqual(["stalls", "errors", "target_cpu"]);
  });

  test("a saturated generator makes the step inconclusive, whatever the target did", () => {
    const generator: GeneratorVerdict = {
      inconclusive: true,
      limits: [{ kind: "cpu", host: "local", cpuP95: 95, threshold: 80 }],
      notes: [],
    };
    expect(judgeStep({ ...good, generator }, t).status).toBe("inconclusive");
    expect(judgeStep({ ...good, generator, stallRatio: 0.5 }, t)).toMatchObject({
      status: "inconclusive",
      breaches: [{ metric: "stalls" }],
    });
  });
});

describe("the stop rule", () => {
  const row = (step: number, status: SweepRow["status"], metrics: SweepRow["breaches"][number]["metric"][] = []) =>
    ({
      step,
      status,
      breaches: metrics.map((metric) => ({ metric, value: 1, threshold: 0 })),
      viewers: step,
      streamers: 20,
      perViewerEgressBytesPerSecond: 150_000,
      perViewerNicTxBytesPerSecond: 160_000,
      targetCpuP95: step / 100,
    }) as SweepRow;

  test("no steps run", () => {
    expect(summarizeSweep("viewers", [])).toMatchObject({
      outcome: "completed",
      stepsRun: 0,
      lastPassing: null,
      firstFailing: null,
      brokeBy: [],
      perViewerEgressBytesPerSecond: null,
    });
  });

  test("every step passed", () => {
    const s = summarizeSweep("viewers", [row(250, "pass"), row(500, "pass")]);
    expect(s).toMatchObject({ outcome: "completed", stepsRun: 2, firstFailing: null, targetCpuP95: 5 });
    expect(s.lastPassing?.step).toBe(500);
  });

  test("the first breaking step stops the sweep; later rows are not considered", () => {
    const s = summarizeSweep("viewers", [
      row(250, "pass"),
      row(500, "pass"),
      row(1000, "break", ["target_cpu"]),
      row(2000, "pass"),
    ]);
    expect(s).toMatchObject({
      outcome: "break",
      stepsRun: 3,
      brokeBy: ["target_cpu"],
      perViewerNicTxBytesPerSecond: 160_000,
    });
    expect(s.lastPassing?.step).toBe(500);
    expect(s.firstFailing?.step).toBe(1000);
  });

  test("ties at the failing step are reported together", () => {
    const s = summarizeSweep("streamers", [row(1, "pass"), row(2, "break", ["latency", "target_cpu"])]);
    expect(s.brokeBy).toEqual(["latency", "target_cpu"]);
  });

  test("the first step failing leaves no passing step; an inconclusive step stops it too", () => {
    expect(summarizeSweep("viewers", [row(250, "break", ["stalls"])]).lastPassing).toBeNull();
    const s = summarizeSweep("viewers", [row(250, "pass"), row(500, "inconclusive")]);
    expect(s.outcome).toBe("inconclusive");
    expect(s.brokeBy).toEqual([]);
  });
});

describe("rows", () => {
  const input: StepResultInput = {
    viewers: 500,
    all: { started: 500, stallRatio: 0.01, errors: 0, ttff: { p95: 2_000 } },
    browser: { viewers: 10, latency: { p95: 5_000 } },
    report: { egress: { perViewerBytesPerSecond: 150_000 } },
    cpu: {
      "commonair-postgres": { meanCpuPercent: 12 },
      "commonair-valkey": { meanCpuPercent: 3 },
      "commonair-origin": { meanCpuPercent: 80 },
    },
    target: { cpuP95: 40, busiestTxP95: 90_000_000, totalTxMean: 80_000_000 },
    generatorCpuP95: 30,
    heartbeatErrors: 4,
    generator: CONCLUSIVE,
  };

  test("a row carries the verdict, per-viewer egress both ways, and Postgres and Valkey CPU", () => {
    const r = sweepRow(parseSweepParams({}), 500, { streamers: 20, viewers: 500 }, input, 250_000_000, 0);
    expect(r).toMatchObject({
      step: 500,
      axis: "viewers",
      status: "pass",
      breaches: [],
      ladders: 0,
      perViewerEgressBytesPerSecond: 150_000,
      perViewerNicTxBytesPerSecond: 160_000,
      postgresCpuMeanPercent: 12,
      valkeyCpuMeanPercent: 3,
      generatorCpuP95: 30,
      heartbeatErrors: 4,
    });
  });

  test("the NIC rule uses the busiest interface against the ceiling", () => {
    const r = sweepRow(parseSweepParams({}), 500, { streamers: 20, viewers: 500 }, input, 90_000_000, null);
    expect(r.status).toBe("break");
    expect(r.breaches.map((b) => b.metric)).toEqual(["target_nic"]);
  });

  test("container lookup by service name, null when absent", () => {
    expect(containerCpuMean({ commonair_postgres_1: { meanCpuPercent: 7 } }, "postgres")).toBe(7);
    expect(containerCpuMean({}, "valkey")).toBeNull();
  });

  test("ladders: any video rendition beyond the source", () => {
    expect(hasLadder(["source", "720p", "480p"])).toBe(true);
    expect(hasLadder(["source"])).toBe(false);
    expect(hasLadder(["source", "audio"])).toBe(false);
    expect(hasLadder([])).toBe(false);
    expect(hasLadder(undefined)).toBe(false);
  });
});
