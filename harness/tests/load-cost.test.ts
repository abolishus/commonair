// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `load-cost` (S1-i): parameters, the cell planner, the cell judge, the subtraction and
 * attribution maths (negative and noisy differences included), the profile collection, and the
 * scenario end to end against a stand-in platform whose containers burn CPU at known rates per
 * live stream, per open viewer and per ladder, so every derived cost has an exact expected value.
 */
import { createLogger } from "@commonair/observability";
import { describe, expect, test } from "vite-plus/test";
import { loadCostScenario } from "../scenarios/load-cost.ts";
import { loadHarnessEnv, loadLoadEnv } from "../src/env.ts";
import { type LoadResult, type StreamerFleet, loadTopology, runAudience } from "../src/load.ts";
import {
  COST_CELLS,
  type CellObservation,
  type CellPlan,
  type CellRow,
  type CostService,
  CostParamError,
  MIN_CELL_SECONDS,
  byService,
  cellRow,
  costInconclusiveReasons,
  heartbeatlessSecondsCap,
  judgeCell,
  noiseFloor,
  parseCells,
  parseCostParams,
  planCells,
  planNotes,
  serviceOf,
  summarizeCost,
} from "../src/load/cost.ts";
import type { ContainerUsage, CounterRead } from "../src/load/counters.ts";
import {
  ProfileError,
  collectProfiles,
  listCommand,
  markCommand,
  profilePaths,
  startProfiles,
} from "../src/load/profiles.ts";
import type { CommandRunner } from "../src/load/ssh.ts";
import type { Platform } from "../src/platform.ts";
import { runOne } from "../src/runner.ts";
import { type ScenarioContext, type ScenarioResult, defineScenario } from "../src/scenario.ts";
import { type Viewer, emptyReport } from "../src/viewer.ts";

const env = loadHarnessEnv({});
const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });
const PREFIX = env.HARNESS_CONTAINER_PREFIX;

describe("parameters", () => {
  test("defaults: every cell, 180 s after a 30 s warm-up, 10 streams, 40 viewers, ladder at 60", () => {
    const p = parseCostParams({}, { remote: true });
    expect(p.cells).toEqual([...COST_CELLS]);
    expect(p).toMatchObject({
      seconds: 180,
      warmupSeconds: 30,
      streams: 10,
      viewers: 40,
      manyStreams: 10,
      ladderThreshold: 50,
      ladderViewers: 60,
      heartbeats: true,
      fetchSegments: true,
      browserViewers: 0,
      source: { protocol: "rtmp", width: 1920, height: 1080, bitrateKbps: 6000 },
      profiles: [],
      testShortCells: false,
      notes: [],
    });
  });

  test("cells: run order, idle added, unknown and repeated refused", () => {
    expect(parseCells("ladder, ingest")).toEqual({ cells: ["idle", "ingest", "ladder"], addedIdle: true });
    expect(parseCells("ingest,idle").addedIdle).toBe(false);
    expect(() => parseCells("idle,bogus")).toThrow(/unknown cell "bogus"/);
    expect(() => parseCells("idle,idle")).toThrow(/twice/);
    expect(() => parseCells(" , ")).toThrow(/no cells/);
    expect(parseCostParams({ cells: "ingest" }, { remote: true }).notes).toEqual([
      "idle added: every cost subtracts it",
    ]);
  });

  test("a cell shorter than 60 s is refused, unless the test-only switch is on locally", () => {
    expect(() => parseCostParams({ seconds: String(MIN_CELL_SECONDS - 1) }, { remote: true })).toThrow(
      /needs at least 60 s/,
    );
    expect(parseCostParams({ seconds: "60" }, { remote: true }).seconds).toBe(60);
    expect(parseCostParams({ seconds: "5", testShortCells: "true" }, { remote: false }).seconds).toBe(5);
    expect(() => parseCostParams({ seconds: "5", testShortCells: "true" }, { remote: true })).toThrow(
      /test-only and refused against a remote target/,
    );
  });

  test("viewers stay below the threshold and the ladder reaches it", () => {
    expect(() => parseCostParams({ viewers: "50" }, { remote: true })).toThrow(/below the ladder threshold \(50\)/);
    expect(() => parseCostParams({ ladderViewers: "49" }, { remote: true })).toThrow(/must reach/);
    const p = parseCostParams({ ladderThreshold: "20", viewers: "10" }, { remote: true });
    expect(p.ladderViewers).toBe(30);
  });

  test("without heartbeats the window is capped inside the playback token's life, and says so", () => {
    expect(heartbeatlessSecondsCap(30, 40)).toBe(120 - 15 - 30 - 4);
    const p = parseCostParams({ heartbeats: "false" }, { remote: true });
    expect(p.seconds).toBe(71);
    expect(p.notes[0]).toMatch(/seconds capped from 180 to 71: without heartbeats/);
    // Below the minimum after the cap: refused rather than measured short.
    expect(() => parseCostParams({ heartbeats: "false", warmupSeconds: "50" }, { remote: true })).toThrow(/refused/);
    // The cap concerns the viewers cell only.
    expect(parseCostParams({ heartbeats: "false", cells: "idle,ingest" }, { remote: true }).seconds).toBe(180);
    expect(() => parseCostParams({ heartbeats: "maybe" }, { remote: true })).toThrow(/true or false/);
  });

  test("profiles: Bun services only, remote only, plain directory", () => {
    expect(parseCostParams({ profiles: "media, worker" }, { remote: true }).profiles).toEqual(["media", "worker"]);
    expect(() => parseCostParams({ profiles: "mediamtx" }, { remote: true })).toThrow(/not a Bun service.*perf/);
    expect(() => parseCostParams({ profiles: "api" }, { remote: false })).toThrow(/needs a remote target/);
    expect(() => parseCostParams({ profileDir: "../etc" }, { remote: true })).toThrow(/plain path/);
  });

  test("the smoke preset: tiny local cells, overridable, refused remotely", () => {
    const p = parseCostParams({ preset: "smoke", viewers: "4" }, { remote: false });
    expect(p).toMatchObject({ streams: 2, viewers: 4, manyStreams: 2, seconds: 20, testShortCells: true });
    expect(p.cells).not.toContain("ladder");
    expect(() => parseCostParams({ preset: "smoke" }, { remote: true })).toThrow(/local stack/);
    expect(() => parseCostParams({ preset: "huge" }, { remote: false })).toThrow(/expected smoke/);
  });

  test("bad numbers name their key", () => {
    expect(() => parseCostParams({ streams: "0" }, { remote: true })).toThrow(CostParamError);
    expect(() => parseCostParams({ width: "1919" }, { remote: true })).toThrow(/even/);
    expect(() => parseCostParams({ protocol: "srt" }, { remote: true })).toThrow(/rtmp or whip/);
    expect(() => parseCostParams({ browserViewers: "41" }, { remote: true })).toThrow(/exceeds/);
  });
});

describe("planning", () => {
  test("every cell's streams, viewers and knobs; only the viewers cell takes the knobs", () => {
    const p = parseCostParams({ fetchSegments: "false" }, { remote: true });
    const plan = planCells(p);
    expect(plan.map((c) => [c.name, c.streams, c.viewers, c.fetchSegments, c.expectLadder])).toEqual([
      ["idle", 0, 0, true, false],
      ["viewers", 1, 40, false, false],
      ["viewers-many", 10, 400, true, false],
      ["ingest", 10, 0, true, false],
      ["ingest-2x", 20, 0, true, false],
      ["ladder", 1, 60, true, true],
    ]);
    const ladder = plan.at(-1) as CellPlan;
    expect(ladder).toMatchObject({ warmupSeconds: 90, ladderWaitSeconds: 60, heartbeats: true });
    expect(plan[0]?.warmupSeconds).toBe(30);
  });

  test("a cell past 430 viewers per generator address is flagged", () => {
    const plan = planCells(parseCostParams({ manyStreams: "11" }, { remote: true }));
    expect(planNotes(plan, 1)).toEqual([expect.stringMatching(/^viewers-many: 440 viewers over 1 generator/)]);
    expect(planNotes(plan, 2)).toEqual([]);
  });
});

describe("attribution", () => {
  test("container names to services (quadlet and compose names), others ignored", () => {
    expect(serviceOf("commonair-api", "commonair")).toBe("api");
    expect(serviceOf("commonair-mediamtx-1", "commonair")).toBe("mediamtx");
    expect(serviceOf("commonair_worker_1", "commonair")).toBe("worker");
    expect(serviceOf("commonair-chat", "commonair")).toBeNull();
    expect(serviceOf("other-api", "commonair")).toBeNull();
  });

  test("replicas of one service are summed", () => {
    const u = (cores: number): ContainerUsage => ({
      cores,
      coresP50: cores,
      coresP95: cores,
      rxBytesPerSecond: 1,
      txBytesPerSecond: 2,
      intervals: 10,
      restarts: 0,
      missing: 0,
    });
    const s = byService({ "commonair-api-1": u(1), "commonair-api-2": u(0.5), "commonair-web": u(9) }, "commonair");
    expect(Object.keys(s)).toEqual(["api"]);
    expect(s.api).toMatchObject({ cores: 1.5, rxBytesPerSecond: 2, txBytesPerSecond: 4 });
  });
});

/** Usage for one service: mean cores, spread from p50 to p95. */
const usage = (cores: number, spread = 0, rx = 0, tx = 0): ContainerUsage => ({
  cores,
  coresP50: cores,
  coresP95: cores + spread,
  rxBytesPerSecond: rx,
  txBytesPerSecond: tx,
  intervals: 36,
  restarts: 0,
  missing: 0,
});

const SERVICES = ["mediamtx", "media", "worker", "origin", "caddy", "api", "postgres", "valkey"] as const;

/** A measured row whose services burn `base` plus `extra[service]`. */
function row(
  name: CellRow["name"],
  streams: number,
  viewers: number,
  extra: Partial<Record<CostService, number>> = {},
  o: { spread?: number; status?: CellRow["status"]; valkey?: [number, number]; host?: number } = {},
): CellRow {
  const services = Object.fromEntries(
    SERVICES.map((s) => [
      s,
      usage(
        0.1 + (extra[s] ?? 0),
        o.spread ?? 0,
        s === "valkey" ? (o.valkey?.[0] ?? 0) : 0,
        s === "valkey" ? (o.valkey?.[1] ?? 0) : 0,
      ),
    ]),
  ) as Record<CostService, ContainerUsage>;
  return {
    name,
    streams,
    viewers,
    windowSeconds: 180,
    heartbeats: true,
    fetchSegments: true,
    laddersAtStart: 0,
    laddersAtEnd: 0,
    services,
    servicesTotalCores: null,
    host: o.host === undefined ? null : { cores: o.host, coresP95: o.host, cpus: 8 },
    containerSource: "cgroup",
    viewersReport: { reports: viewers, sessions: viewers, started: viewers, errors: 0, heartbeatErrors: 0 },
    status: o.status ?? "measured",
    failures: [],
    inconclusive: o.status === "inconclusive" ? ["generator CPU"] : [],
  };
}

const P = { streams: 10, viewers: 40, manyStreams: 10, ladderViewers: 60, linearityTolerance: 0.2 };

describe("the subtraction maths", () => {
  const perStream = { mediamtx: 0.02, media: 0.15, worker: 0.08, valkey: 0.005 };
  const times = (k: number, m: Partial<Record<CostService, number>>) =>
    Object.fromEntries(Object.entries(m).map(([s, v]) => [s, v * k])) as Partial<Record<CostService, number>>;
  const plus = (...ms: Partial<Record<CostService, number>>[]) => {
    const out: Partial<Record<CostService, number>> = {};
    for (const m of ms)
      for (const [s, v] of Object.entries(m)) out[s as CostService] = (out[s as CostService] ?? 0) + v;
    return out;
  };
  const perViewer = { caddy: 0.002, origin: 0.001, api: 0.0005 };
  const cells = [
    row("idle", 0, 0, {}, { spread: 0.01, host: 1 }),
    row("viewers", 1, 40, plus(perStream, times(40, perViewer)), { host: 1.4 }),
    row("viewers-many", 10, 400, plus(times(10, perStream), times(400, perViewer)), { host: 6 }),
    row("ingest", 10, 0, times(10, perStream), { valkey: [440_000, 450_000], host: 3.5 }),
    row("ingest-2x", 20, 0, times(20, perStream), { host: 6 }),
    row("ladder", 1, 60, plus(perStream, times(60, perViewer), { media: 2.1 }), { host: 3.6 }),
  ];
  const s = summarizeCost(P, cells, { local: false });

  test("ingest per stream, by container, and the group's sum", () => {
    const l = s.costs.ingestPerStream;
    expect(l.basis).toBe("(ingest − idle) / 10 streams");
    expect(l.perService.media).toBeCloseTo(0.15);
    expect(l.perService.caddy).toBeCloseTo(0);
    expect(l.total).toBeCloseTo(0.255);
    expect(l.host).toBeCloseTo(0.25);
    expect(l.negative).toEqual([]);
  });

  test("moderation counts both halves: capture in media and the classifier in worker", () => {
    expect(s.costs.moderationPerStream.capture).toBeCloseTo(0.15);
    expect(s.costs.moderationPerStream.classifier).toBeCloseTo(0.08);
    expect(s.costs.moderationPerStream.total).toBeCloseTo(0.23);
    expect(s.costs.packagingPerStream).toBeCloseTo(0.025);
  });

  test("linear: twice the streams, the same per stream", () => {
    expect(s.costs.linearity.ratio).toBeCloseTo(1);
    expect(s.costs.linearity.marginalPerStream).toBeCloseTo(0.255);
    expect(s.costs.linearity.linear).toBe(true);
  });

  test("viewers: the stream's ingest is taken out, per viewer and per 100", () => {
    const l = s.costs.viewersPerViewer;
    expect(l.basis).toBe("(viewers − idle − 1 × ingest per stream) / 40 viewers");
    expect(l.perService.caddy).toBeCloseTo(0.002);
    expect(l.perService.api).toBeCloseTo(0.0005);
    expect(l.perService.media).toBeCloseTo(0);
    expect(l.total).toBeCloseTo(0.003);
    expect(s.costs.edgePer100Viewers.onePath).toBeCloseTo(0.3);
    expect(s.costs.edgePer100Viewers.manyPaths).toBeCloseTo(0.3);
  });

  test("the ladder is what remains after the viewers cell and the extra viewers", () => {
    const l = s.costs.ladder;
    expect(l.basis).toBe("ladder − viewers − 20 × viewer cost");
    expect(l.perService.media).toBeCloseTo(2.1);
    expect(l.perService.caddy).toBeCloseTo(0);
    expect(l.allServices).toBeCloseTo(2.1);
  });

  test("valkey bytes per stream, and the ADR 0041 targets", () => {
    expect(s.costs.valkeyBytesPerStream).toEqual({ rx: 44_000, tx: 45_000 });
    expect(s.targets.map((t) => [t.target, t.met])).toEqual([
      [0.1, true],
      [0.05, false],
      [0.15, false],
    ]);
    expect(s.outcome).toBe("measured");
  });

  test("a negative difference is reported, not hidden, and flagged", () => {
    const neg = summarizeCost(P, [row("idle", 0, 0), row("ingest", 10, 0, { media: -0.05, worker: 1 })], {
      local: false,
    });
    const l = neg.costs.ingestPerStream;
    expect(l.perService.media).toBeCloseTo(-0.005);
    expect(l.negative).toEqual(["media"]);
  });

  test("a difference inside the idle cell's p95 spread is flagged as noise, and its target unjudged", () => {
    const noisy = summarizeCost(
      P,
      [row("idle", 0, 0, {}, { spread: 0.05 }), row("ingest", 10, 0, { mediamtx: 0.01, valkey: 0.01, worker: 2 })],
      { local: false },
    );
    const l = noisy.costs.ingestPerStream;
    expect(l.belowNoise).toEqual(expect.arrayContaining(["mediamtx", "valkey", "media"]));
    expect(l.belowNoise).not.toContain("worker");
    expect(l.totalBelowNoise).toBe(false);
    expect(noisy.targets[0]?.met).toBeNull();
    expect(noiseFloor(row("idle", 0, 0, {}, { spread: 0.05 }).services).api).toBeCloseTo(0.05);
    // Linearity needs both lines out of the noise.
    const tiny = summarizeCost(
      P,
      [
        row("idle", 0, 0, {}, { spread: 1 }),
        row("ingest", 10, 0, { media: 0.1 }),
        row("ingest-2x", 20, 0, { media: 0.2 }),
      ],
      { local: false },
    );
    expect(tiny.costs.linearity.linear).toBeNull();
    expect(tiny.costs.ingestPerStream.totalBelowNoise).toBe(true);
  });

  test("non-linear: 2N streams cost more per stream", () => {
    const nl = summarizeCost(
      P,
      [row("idle", 0, 0), row("ingest", 10, 0, { media: 1 }), row("ingest-2x", 20, 0, { media: 3 })],
      {
        local: false,
      },
    );
    expect(nl.costs.linearity.ratio).toBeCloseTo(1.5);
    expect(nl.costs.linearity.linear).toBe(false);
  });

  test("a cost that needs an inconclusive or missing cell is unavailable, and says why", () => {
    const partial = summarizeCost(
      P,
      [row("idle", 0, 0), row("viewers", 1, 40, { caddy: 0.08 }), row("ingest", 10, 0, {}, { status: "inconclusive" })],
      { local: true },
    );
    expect(partial.outcome).toBe("inconclusive");
    expect(partial.local).toBe(true);
    expect(partial.costs.ingestPerStream.unavailable).toBe("the ingest cell is inconclusive");
    expect(partial.costs.ladder.unavailable).toBe("the ladder cell did not run");
    // Without ingest the viewers line keeps the stream in and says so.
    expect(partial.costs.viewersPerViewer.basis).toMatch(/no ingest cell/);
    expect(partial.costs.viewersPerViewer.perService.caddy).toBeCloseTo(0.002);
    expect(partial.costs.moderationPerStream.total).toBeNull();
    expect(partial.targets[1]?.met).toBeNull();
    expect(costInconclusiveReasons(partial)).toEqual(["ingest: generator CPU"]);
  });

  test("a viewers cell without segments or heartbeats is a partial viewer: no ladder from it, no target verdict", () => {
    const partialViewers = { ...row("viewers", 1, 40, { caddy: 0.04 }), fetchSegments: false };
    const partial = summarizeCost(P, [row("idle", 0, 0), partialViewers, row("ladder", 1, 60, { media: 2 })], {
      local: false,
    });
    expect(partial.costs.viewersPerViewer.perService.caddy).toBeCloseTo(0.001);
    expect(partial.costs.ladder.unavailable).toMatch(/partial viewer/);
    expect(partial.targets[2]?.met).toBeNull();
  });

  test("no idle cell: nothing to subtract", () => {
    const none = summarizeCost(P, [row("ingest", 10, 0)], { local: false });
    expect(none.costs.ingestPerStream.unavailable).toBe("the idle cell did not run");
  });
});

describe("judging a cell", () => {
  const plan = (name: CellPlan["name"], streams: number, viewers: number, over: Partial<CellPlan> = {}): CellPlan => ({
    name,
    streams,
    viewersPerStream: streams ? viewers / streams : 0,
    viewers,
    browserViewers: 0,
    warmupSeconds: 30,
    ladderWaitSeconds: 0,
    seconds: 180,
    heartbeats: true,
    fetchSegments: true,
    expectLadder: name === "ladder",
    ...over,
  });
  const obs = (p: CellPlan, over: Partial<CellObservation> = {}): CellObservation => ({
    plan: p,
    windowSeconds: 180,
    viewers: { reports: p.viewers, sessions: p.viewers, started: p.viewers, errors: 0, heartbeatErrors: 0 },
    offline: [],
    laddersAtStart: p.expectLadder ? 1 : 0,
    laddersAtEnd: p.expectLadder ? 1 : 0,
    generator: { inconclusive: false, limits: [], notes: [] },
    counters: { failures: 0, source: "cgroup" },
    services: { api: usage(0.1) },
    host: null,
    ...over,
  });

  test("zero streams and zero viewers is a legal, measured cell", () => {
    const o = obs(plan("idle", 0, 0), { laddersAtStart: null, laddersAtEnd: null });
    expect(judgeCell(o, 0)).toEqual({ status: "measured", failures: [], inconclusive: [] });
    const r = cellRow(o, judgeCell(o, 0));
    expect(r).toMatchObject({
      name: "idle",
      streams: 0,
      viewers: 0,
      servicesTotalCores: 0.1,
      containerSource: "cgroup",
    });
  });

  test("a stream that was not live fails the cell", () => {
    const v = judgeCell(obs(plan("ingest", 2, 0), { offline: ["load-ch1"] }), 0);
    expect(v.status).toBe("failed");
    expect(v.failures).toEqual(["1 of 2 streams were not live: load-ch1"]);
  });

  test("viewers that never got a session or never played fail it; without segments only sessions count", () => {
    const short = judgeCell(
      obs(plan("viewers", 1, 40), {
        viewers: { reports: 40, sessions: 38, started: 30, errors: 2, heartbeatErrors: 0 },
      }),
      0,
    );
    expect(short.failures).toEqual([
      "38 of 40 viewers got a playback session",
      "30 of 40 viewers played a segment",
      "2 viewer errors",
    ]);
    const noSegments = plan("viewers", 1, 40, { fetchSegments: false });
    expect(
      judgeCell(
        obs(noSegments, { viewers: { reports: 40, sessions: 40, started: 0, errors: 0, heartbeatErrors: 0 } }),
        0,
      ).status,
    ).toBe("measured");
  });

  test("ladders: required in the ladder cell, forbidden elsewhere, unknown is inconclusive", () => {
    expect(judgeCell(obs(plan("ladder", 1, 60), { laddersAtEnd: 0 }), 0).failures).toEqual([
      "no ladder ran through the window",
    ]);
    expect(judgeCell(obs(plan("viewers", 1, 40), { laddersAtEnd: 1 }), 0).failures).toEqual([
      "a ladder ran in a cell that must have none",
    ]);
    expect(judgeCell(obs(plan("ladder", 1, 60), { laddersAtStart: null }), 0)).toMatchObject({
      status: "inconclusive",
      inconclusive: ["the ladder could not be checked"],
    });
  });

  test("the generator as the limit, failed heartbeats and missing samples are inconclusive, never a cost", () => {
    const gen = judgeCell(
      obs(plan("viewers", 1, 40), {
        generator: {
          inconclusive: true,
          limits: [{ kind: "cpu", host: "local", cpuP95: 91, threshold: 80 }],
          notes: [],
        },
        viewers: { reports: 40, sessions: 40, started: 40, errors: 0, heartbeatErrors: 3 },
        counters: { failures: 2, source: "cgroup" },
        services: { api: { ...usage(0.1), restarts: 1, missing: 1 } },
      }),
      0,
    );
    expect(gen.status).toBe("inconclusive");
    expect(gen.inconclusive).toEqual([
      "local: CPU p95 91.0 % > 80 %",
      "3 failed heartbeats > 0: the generator's address was rate-limited",
      "2 container reads failed",
      "api restarted during the window",
      "api was missing from 1 reads",
    ]);
    // A local run (no generator verdict) does not judge heartbeats; without heartbeats there are none to judge.
    const local = obs(plan("viewers", 1, 40), {
      generator: null,
      viewers: { reports: 40, sessions: 40, started: 40, errors: 0, heartbeatErrors: 3 },
    });
    expect(judgeCell(local, 0).status).toBe("measured");
    expect(judgeCell(obs(plan("idle", 0, 0), { services: {} }), 0).inconclusive).toEqual(["no container was measured"]);
  });

  test("a failure wins over inconclusive; a thrown cell fails with its message", () => {
    const both = judgeCell(
      obs(plan("ingest", 1, 0), { offline: ["c"], counters: { failures: 1, source: "podman" } }),
      0,
    );
    expect(both.status).toBe("failed");
    const thrown = judgeCell(obs(plan("ingest", 1, 0), { error: "c offline: timed out", services: {} }), 0);
    expect(thrown).toMatchObject({ status: "failed", failures: ["c offline: timed out"] });
  });
});

describe("profiles", () => {
  /** A target whose units stop and start on request; `find` lists what a stop wrote. */
  function target(o: { env?: string; failCat?: boolean } = {}) {
    const active = new Map<string, boolean>();
    const written: string[] = [];
    const commands: string[] = [];
    const run: CommandRunner = async (_dest, command) => {
      commands.push(command);
      const unit = /'(commonair-\w+)\.service'/.exec(command)?.[1]?.replace("commonair-", "");
      if (command.includes("printenv")) return { code: o.env === "" ? 1 : 0, stdout: o.env ?? "/profiles\n" };
      if (command.startsWith("mkdir")) return { code: 0, stdout: "" };
      if (command.includes("is-active") && unit)
        return { code: 0, stdout: active.get(unit) === false ? "inactive\n" : "active\n" };
      if (command.includes(" stop ") && unit) {
        active.set(unit, false);
        written.push(
          `commonair-profiles/${unit}/CPU.1.2.0.001.cpuprofile`,
          `commonair-profiles/${unit}/CPU.1.2.0.002.md`,
        );
        return { code: 0, stdout: "" };
      }
      if ((command.includes(" start ") || command.includes(" restart ")) && unit) {
        active.set(unit, true);
        return { code: 0, stdout: "" };
      }
      if (command.startsWith("find"))
        return { code: 0, stdout: `${written.join("\n")}\ncommonair-profiles/evil/../x\n` };
      if (command.startsWith("cat")) return o.failCat ? { code: 1, stdout: "" } : { code: 0, stdout: '{"nodes":[]}' };
      return { code: 127, stdout: "" };
    };
    return { run, commands };
  }
  const sleep = async () => undefined;

  test("restart, then stop/start each service and copy what it wrote", async () => {
    const t = target();
    const files = new Map<string, string>();
    const d = { run: t.run, target: "ops@t", sleep, write: (p: string, s: string) => void files.set(p, s) };
    await startProfiles(d, ["media", "worker"], "commonair-profiles", "r1");
    expect(t.commands).toContain(markCommand("commonair-profiles", "r1"));
    expect(t.commands.filter((c) => c.includes("restart --no-block"))).toHaveLength(2);
    const got = await collectProfiles(d, ["media", "worker"], "commonair-profiles", "r1", "/reports/profiles/r1");
    expect(got.map((g) => [g.service, g.local])).toEqual([
      ["media", "/reports/profiles/r1/media/CPU.1.2.0.001.cpuprofile"],
      ["media", "/reports/profiles/r1/media/CPU.1.2.0.002.md"],
      ["worker", "/reports/profiles/r1/worker/CPU.1.2.0.001.cpuprofile"],
      ["worker", "/reports/profiles/r1/worker/CPU.1.2.0.002.md"],
    ]);
    expect(files.get("/reports/profiles/r1/media/CPU.1.2.0.001.cpuprofile")).toBe('{"nodes":[]}');
    expect(t.commands).toContain(listCommand("commonair-profiles", "r1"));
  });

  test("a service without the drop-in is refused before anything restarts", async () => {
    const t = target({ env: "" });
    await expect(
      startProfiles({ run: t.run, target: "ops@t", sleep }, ["api"], "commonair-profiles", "r1"),
    ).rejects.toThrow(ProfileError);
    expect(t.commands.some((c) => c.includes("restart"))).toBe(false);
  });

  test("a unit that never comes back times out; an unreadable profile throws", async () => {
    const stuck: CommandRunner = async (_d, c) => ({
      code: 0,
      stdout: c.includes("is-active") ? "activating\n" : "/p\n",
    });
    await expect(
      startProfiles({ run: stuck, target: "t", sleep, timeoutMs: 5, pollMs: 1 }, ["api"], "d", "r"),
    ).rejects.toThrow(/did not become active/);
    const t = target({ failCat: true });
    await expect(
      collectProfiles(
        { run: t.run, target: "t", sleep, write: () => undefined },
        ["api"],
        "commonair-profiles",
        "r",
        "/x",
      ),
    ).rejects.toThrow(/could not read/);
  });

  test("only plain files one level under the directory are collected", () => {
    expect(profilePaths("d/api/a.cpuprofile\nd/api/sub/b.md\nd/../etc/passwd\nother/x.md\nd/a b/c.md\n", "d")).toEqual([
      "d/api/a.cpuprofile",
    ]);
  });
});

/* ---------- the scenario end to end ---------- */

/** Cores each service burns: a base, per live stream, per open viewer, per ladder. */
const RATES = {
  base: 0.05,
  stream: { mediamtx: 0.02, media: 0.12, worker: 0.09, valkey: 0.01 } as Partial<Record<CostService, number>>,
  viewer: { caddy: 0.003, origin: 0.002, api: 0.001 } as Partial<Record<CostService, number>>,
  ladder: { media: 1.5 } as Partial<Record<CostService, number>>,
};

interface World {
  live: Set<string>;
  viewers: number;
  /** Open viewers per channel (a ladder starts per channel at the threshold). */
  perChannel?: Map<string, number>;
  threshold: number;
  /** Channels that drop out the first time the API is asked about them. */
  dropping: Set<string>;
}

/** A stand-in platform: sign-ups, encoders that go live, viewers, the channel and playback API. */
function fakePlatform(world: World) {
  let n = 0;
  let vn = 0;
  const per = (world.perChannel ??= new Map());
  const viewer = (channel: string): Viewer => {
    const id = `v${vn++}`;
    const base = { ...emptyReport(id, "http", "http"), sessionId: `s${id}`, ttffMs: 300, playedSeconds: 1 };
    world.viewers++;
    per.set(channel, (per.get(channel) ?? 0) + 1);
    let stopped = false;
    return {
      id,
      kind: "http",
      start: async () => undefined,
      waitForFirstFrame: async () => 300,
      report: async () => base,
      stop: async () => {
        if (!stopped) {
          world.viewers--;
          per.set(channel, (per.get(channel) ?? 1) - 1);
        }
        stopped = true;
        return base;
      },
    };
  };
  const ladder = (channel: string) => (per.get(channel) ?? 0) >= world.threshold;
  const platform = {
    probe: async () => null,
    signUp: async ({ prefix }: { prefix: string }) => {
      const i = n++;
      return { username: `${prefix}${i}`, me: { channelSlug: `${prefix}-ch${i}` } };
    },
    streamerFor: async (user: { username: string; me: { channelSlug: string } }) => ({
      start: async () => void world.live.add(user.me.channelSlug),
      stop: async () => void world.live.delete(user.me.channelSlug),
    }),
    waitForLive: async () => 0,
    openViewers: async (channel: string, v: { http: number }) => Array.from({ length: v.http }, () => viewer(channel)),
    api: () => ({
      client: {
        playback: {
          start: async ({ channel }: { channel: string }) => ({
            sessionId: "s",
            token: "t",
            renditions: ladder(channel) ? ["source", "720p"] : ["source"],
          }),
          end: async () => ({}),
        },
        channels: {
          get: async ({ channel }: { channel: string }) => {
            if (world.dropping.delete(channel)) world.live.delete(channel);
            return { live: world.live.has(channel) ? { viewerCount: 0 } : null };
          },
        },
      },
    }),
  };
  return platform as unknown as Platform;
}

/** Counters that integrate RATES over real time for the world's current state. */
function fakeCounters(world: World) {
  const cpu: Record<string, number> = {};
  let last = Date.now();
  const read = async (): Promise<CounterRead> => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    const out: CounterRead = {};
    const streams = world.live.size;
    const ladder = [...(world.perChannel?.values() ?? [])].filter((v) => v >= world.threshold).length;
    for (const s of SERVICES) {
      const cores =
        RATES.base +
        streams * (RATES.stream[s] ?? 0) +
        world.viewers * (RATES.viewer[s] ?? 0) +
        ladder * (RATES.ladder[s] ?? 0);
      const name = `${PREFIX}-${s}`;
      cpu[name] = (cpu[name] ?? 0) + cores * dt * 1e6;
      out[name] = { cpuUsec: cpu[name], rxBytes: streams * 1000, txBytes: 0 };
    }
    return out;
  };
  return async () => ({ read, source: "podman" as const });
}

function costTopology() {
  return loadTopology(loadLoadEnv({}), async () => ({ code: 255, stdout: "" }), {
    stats: async () => [],
    snapshot: async () => null,
  });
}

async function runCost(world: World, params: Record<string, string>): Promise<ScenarioResult> {
  const platform = fakePlatform(world);
  const scenario = loadCostScenario({ topology: costTopology, counters: fakeCounters(world), intervalMs: 50 });
  return runOne(scenario, platform, { command: "run", profile: "default", env, log, platform, runId: "r1", params });
}

const SMALL = {
  streams: "2",
  viewers: "3",
  manyStreams: "2",
  ladderThreshold: "5",
  ladderViewers: "6",
  seconds: "1",
  warmupSeconds: "0",
  ladderWarmupSeconds: "0",
  ladderWaitSeconds: "1",
  cooldownSeconds: "0",
  width: "640",
  height: "360",
  testShortCells: "true",
};

/** These hold for real seconds; CI load must not time them out. */
const SLOW_MS = 60_000;

describe("the load-cost scenario", () => {
  test(
    "every cell runs, streams grow then shrink, and each cost comes out at its known rate",
    async () => {
      const world: World = { live: new Set(), viewers: 0, threshold: 5, dropping: new Set() };
      const result = await runCost(world, SMALL);
      expect(result.status).toBe("passed");
      const cost = result.data.cost as ReturnType<typeof summarizeCost>;
      expect(cost.local).toBe(true);
      expect(cost.outcome).toBe("measured");
      expect(cost.cells.map((c) => [c.name, c.streams, c.viewers, c.status])).toEqual([
        ["idle", 0, 0, "measured"],
        ["viewers", 1, 3, "measured"],
        ["viewers-many", 2, 6, "measured"],
        ["ingest", 2, 0, "measured"],
        ["ingest-2x", 4, 0, "measured"],
        ["ladder", 1, 6, "measured"],
      ]);
      const c = cost.costs;
      expect(c.ingestPerStream.total).toBeCloseTo(0.24, 2);
      expect(c.moderationPerStream.capture).toBeCloseTo(0.12, 2);
      expect(c.moderationPerStream.classifier).toBeCloseTo(0.09, 2);
      expect(c.linearity.linear).toBe(true);
      expect(c.viewersPerViewer.perService.caddy).toBeCloseTo(0.003, 3);
      expect(c.edgePer100Viewers.onePath).toBeCloseTo(0.5, 1);
      expect(c.edgePer100Viewers.manyPaths).toBeCloseTo(0.5, 1);
      expect(c.ladder.perService.media).toBeCloseTo(1.5, 1);
      expect(c.valkeyBytesPerStream.rx).toBe(0);
      expect(cost.notes).toContain(
        "no HARNESS_LOAD_TARGET_SSH: these are the developer machine's numbers, not a target's",
      );
      expect(result.metrics["cost.ingest.cores_per_stream"]?.unit).toBe("cores");
      expect(result.metrics["cost.cells_measured"]?.value).toBe(6);
      expect(result.steps.map((s) => s.name)).toContain("stop 3 streamers");
      // The idle cell opened no viewers and started no stream: zero is a legal cell.
      expect(result.steps.map((s) => s.name)).toContain("cell idle: open 0 viewers");
      expect(world.viewers).toBe(0);
    },
    SLOW_MS,
  );

  test(
    "a stream that drops out fails its cell, stops the run and fails the scenario",
    async () => {
      const world: World = { live: new Set(), viewers: 0, threshold: 5, dropping: new Set(["load-ch1"]) };
      const result = await runCost(world, { ...SMALL, cells: "idle,ingest,ingest-2x" });
      expect(result.status).toBe("failed");
      const cost = result.data.cost as ReturnType<typeof summarizeCost>;
      expect(cost.outcome).toBe("failed");
      expect(cost.cells.map((c) => c.name)).toEqual(["idle", "ingest"]);
      expect(cost.cells[1]?.failures).toEqual(["1 of 2 streams were not live: load-ch1"]);
      expect(cost.costs.ingestPerStream.unavailable).toBe("the ingest cell is failed");
      expect(result.assertions.filter((a) => !a.passed).map((a) => a.name)).toEqual([
        "cell ingest measured",
        "every planned cell ran",
      ]);
    },
    SLOW_MS,
  );

  test("bad parameters fail before anything starts", async () => {
    const world: World = { live: new Set(), viewers: 0, threshold: 5, dropping: new Set() };
    const result = await runCost(world, { seconds: "10" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/refused/);
    expect(world.live.size).toBe(0);
  });
});

describe("runAudience with no viewers", () => {
  test(
    "opens nothing, holds, and reports an empty audience; `until` ends the hold early",
    async () => {
      const world: World = { live: new Set(), viewers: 0, threshold: 5, dropping: new Set() };
      const platform = fakePlatform(world);
      let r: LoadResult | null = null;
      let held = false;
      const s = defineScenario({
        name: "zero",
        description: "",
        needs: [],
        run: async (ctx: ScenarioContext) => {
          const fleet: StreamerFleet = { users: [], channels: [], streamers: [] };
          r = await runAudience(
            ctx,
            fleet,
            { viewers: 0, durationMs: 60_000, onHoldStart: () => void (held = true), until: Bun.sleep(50) },
            costTopology(),
          );
        },
      });
      const started = Date.now();
      const result = await runOne(s, platform, {
        command: "run",
        profile: "default",
        env,
        log,
        platform,
        runId: "z",
        params: {},
      });
      expect(result.status).toBe("passed");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(held).toBe(true);
      const load = r as unknown as LoadResult;
      expect(load.viewers).toBe(0);
      expect(load.sessions).toBe(0);
      expect(load.all.started).toBe(0);
    },
    SLOW_MS,
  );
});
