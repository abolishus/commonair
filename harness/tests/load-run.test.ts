// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The load test's phases (`startStreamers` → `runAudience` → `recordLoadMetrics`) and the
 * `load-sweep` scenario over them, run through the real runner against a stand-in platform: no
 * stack is up in the unit tests, so streams, viewers and the API are fakes that report fixed
 * numbers. Remote hosts are read through an injected command runner (the SSH seam) that answers
 * with `/proc` snapshots, so the target's CPU and NIC go through the real parsers and judges.
 */
import { createLogger } from "@commonair/observability";
import { describe, expect, test } from "vite-plus/test";
import sweepScenario from "../scenarios/load-sweep.ts";
import { loadHarnessEnv, loadLoadEnv } from "../src/env.ts";
import {
  busiestTxP95,
  defaultBrowserViewers,
  judgeLoad,
  judgeLoadRun,
  loadTopology,
  plannedShardsOn,
  recordHostMetrics,
  runLoad,
  startStreamers,
  type LoadResult,
  type LoadTopology,
  allocateViewers,
} from "../src/load.ts";
import { HostSampler, type HostSummary } from "../src/load/host.ts";
import type { CommandRunner } from "../src/load/ssh.ts";
import { buildLoadReport } from "../src/load/report.ts";
import type { Platform } from "../src/platform.ts";
import { runOne } from "../src/runner.ts";
import { type ScenarioContext, type ScenarioResult, defineScenario } from "../src/scenario.ts";
import { type Viewer, type ViewerKind, emptyReport } from "../src/viewer.ts";

const env = loadHarnessEnv({});
const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });

interface FakeOptions {
  /** Per viewer: what its final report says. */
  report?: (kind: ViewerKind, i: number) => Partial<ReturnType<typeof emptyReport>>;
  renditions?: string[] | "throw";
}

/** A stand-in platform: sign-ups, encoders, live waits, viewers and `playback.start`. */
function fakePlatform(o: FakeOptions = {}) {
  const calls = {
    signUps: [] as string[],
    started: [] as string[],
    stopped: 0,
    live: [] as string[],
    opened: [] as string[],
  };
  let n = 0;
  let viewerN = 0;
  const viewer = (kind: ViewerKind): Viewer => {
    const id = `v${viewerN++}`;
    const base = { ...emptyReport(id, kind, kind === "browser" ? "chromium" : "http"), ...o.report?.(kind, viewerN) };
    let stopped = false;
    return {
      id,
      kind,
      start: async () => undefined,
      waitForFirstFrame: async () => base.ttffMs ?? 0,
      report: async () => base,
      stop: async () => {
        if (!stopped) calls.stopped++;
        stopped = true;
        return base;
      },
    };
  };
  const platform = {
    probe: async () => null,
    signUp: async ({ prefix }: { prefix: string }) => {
      const i = n++;
      calls.signUps.push(prefix);
      // Every other one has no channel slug: the username stands in.
      return { username: `${prefix}${i}`, me: { channelSlug: i % 2 === 0 ? `${prefix}-ch${i}` : null } };
    },
    streamerFor: async (user: { username: string }, s: { toneHz: number; width: number }) => ({
      start: async () => void calls.started.push(`${user.username}@${s.width}:${s.toneHz}`),
      stop: async () => undefined,
    }),
    waitForLive: async (channel: string) => void calls.live.push(channel),
    openViewers: async (channel: string, v: { chromium: number; webkit: number; http: number }) => {
      calls.opened.push(`${channel}:${v.chromium}/${v.webkit}/${v.http}`);
      return [
        ...Array.from({ length: v.chromium + v.webkit }, () => viewer("browser")),
        ...Array.from({ length: v.http }, () => viewer("http")),
      ];
    },
    api: () => ({
      client: {
        playback: {
          start: async () => {
            if (o.renditions === "throw") throw new Error("down");
            return { sessionId: "s", token: "t", renditions: o.renditions ?? ["source"] };
          },
          end: async () => ({}),
        },
      },
    }),
  };
  return { platform: platform as unknown as Platform, calls };
}

/** `/proc` snapshots whose counters grow by `cpuBusy` busy jiffies and `txBytes` per read. */
function procRunner(o: { cpuBusy: number; txBytes: number }): { run: CommandRunner; reads: () => number } {
  let reads = 0;
  const run: CommandRunner = async (_dest, command) => {
    if (command.includes("podman")) return { code: 1, stdout: "" };
    reads++;
    const user = reads * o.cpuBusy;
    const idle = reads * (100 - o.cpuBusy);
    const tx = reads * o.txBytes;
    const stdout = [
      "@@ /proc/stat",
      `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0`,
      `cpu0 ${user} 0 0 ${idle} 0 0 0 0 0 0`,
      "@@ /proc/meminfo",
      "MemTotal:        8000000 kB",
      "MemAvailable:    6000000 kB",
      "@@ /proc/loadavg",
      "0.50 0.50 0.50 1/100 1",
      "@@ /proc/net/dev",
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      `  eth0: ${reads * 10} 1 0 0 0 0 0 0 ${tx} 1 0 0 0 0 0 0`,
    ].join("\n");
    return { code: 0, stdout };
  };
  return { run, reads: () => reads };
}

const offline: CommandRunner = async () => ({ code: 255, stdout: "" });

function topology(o: { target?: string; run?: CommandRunner; source?: Record<string, string> } = {}): LoadTopology {
  return loadTopology(
    loadLoadEnv({ ...(o.target ? { HARNESS_LOAD_TARGET_SSH: o.target } : {}), ...o.source }),
    o.run ?? offline,
  );
}

async function inScenario(
  platform: Platform,
  body: (ctx: ScenarioContext) => Promise<void>,
  params: Record<string, string> = {},
): Promise<ScenarioResult> {
  const s = defineScenario({ name: "load-test", description: "", needs: [], run: body });
  return runOne(s, platform, { command: "run", profile: "default", env, log, platform, runId: "r1", params });
}

describe("loadTopology", () => {
  test("no target: the local stack; generator hosts without `local`, deduplicated", () => {
    const t = topology({ source: { HARNESS_LOAD_GENERATOR_HOSTS: "local, gen1,gen1 ,gen2" } });
    expect(t.target).toBeNull();
    expect(t.remoteGenerators).toEqual(["gen1", "gen2"]);
    expect(t.env.HARNESS_LOAD_GENERATOR_HOSTS).toEqual(["local", "gen1", "gen1", "gen2"]);
  });

  test("a target over SSH", () => {
    expect(topology({ target: "ops@target" }).target).toBe("ops@target");
  });
});

describe("allocation helpers", () => {
  test("defaultBrowserViewers: a tenth, at most 20, none below 10 viewers", () => {
    expect(defaultBrowserViewers(9)).toBe(0);
    expect(defaultBrowserViewers(10)).toBe(1);
    expect(defaultBrowserViewers(199)).toBe(19);
    expect(defaultBrowserViewers(10_000)).toBe(20);
  });

  test("plannedShardsOn: one shard per listed host at least, never more than the HTTP viewers", () => {
    const alloc = allocateViewers(2, 10, 0);
    expect(plannedShardsOn(alloc, undefined, [])).toBe(0);
    expect(plannedShardsOn(alloc, undefined, ["a", "b", "c"])).toBe(3);
    expect(plannedShardsOn(alloc, 2, ["a"])).toBe(5);
    expect(plannedShardsOn(allocateViewers(2, 3, 0), undefined, ["a", "b", "c", "d"])).toBe(3);
    expect(plannedShardsOn(allocateViewers(1, 2, 2), 1, ["a"])).toBe(0);
  });
});

describe("startStreamers", () => {
  test("signs up and publishes only what the fleet lacks, each with its own tone", async () => {
    const { platform, calls } = fakePlatform();
    const result = await inScenario(platform, async (ctx) => {
      const topo = topology();
      const first = await startStreamers(ctx, 2, { width: 1280 }, topo);
      expect(first.channels).toEqual(["load-ch0", "load1"]);
      // Already big enough: nothing new.
      expect(await startStreamers(ctx, 1, {}, topo, first)).toBe(first);
      const grown = await startStreamers(ctx, 3, {}, topo, first);
      expect(grown.channels).toEqual(["load-ch0", "load1", "load-ch2"]);
      expect(grown.streamers).toHaveLength(3);
    });
    expect(result.status).toBe("passed");
    expect(calls.signUps).toEqual(["load", "load", "load"]);
    // Tones keep counting across additions (300 + 40 per stream), so every stream sounds apart.
    expect(calls.started).toEqual(["load0@1280:300", "load1@1280:340", "load2@640:380"]);
    expect(result.steps.map((s) => s.name)).toEqual([
      "sign up 2 streamers",
      "start streamers",
      "all channels live",
      "sign up 1 streamers",
      "start 1 more streamers",
      "1 more channels live",
    ]);
  });
});

describe("runLoad against a local stack", () => {
  test("every viewer opens, is held, stopped and reported; egress falls back to the viewers' bytes", async () => {
    const { platform, calls } = fakePlatform({
      report: (kind) => ({
        ttffMs: kind === "browser" ? 900 : 400,
        latencyMs: [1200, 1300],
        bytesHttp: 1_000,
        bytesP2p: kind === "http" ? 0 : 50,
        source: kind === "http" ? "relay" : null,
        playedSeconds: 1,
      }),
    });
    let load: LoadResult | null = null;
    const result = await inScenario(platform, async (ctx) => {
      load = await runLoad(
        ctx,
        { streamers: 2, viewers: 0, viewersPerStreamer: 3, durationMs: 20, browserViewers: 4 },
        topology(),
      );
    });
    expect(result.status).toBe("passed");
    const r = load as unknown as LoadResult;
    expect(r.viewers).toBe(6);
    expect(r.shards).toBe(0);
    expect(r.egressMethod).toBe("viewer-reported");
    // Two HTTP viewers through a relay, four browsers direct with P2P bytes.
    expect(r.egressBySource).toEqual({ relay: 2_000, direct: 4_000, p2p: 200 });
    expect(r.generatorVerdict).toBeNull();
    expect(r.hosts.containersSource).toBe("local");
    expect(r.hosts.target).toBeNull();
    // Browsers round-robin over the channels, Chromium on the first pass and WebKit on the next.
    expect(calls.opened).toEqual(["load-ch0:1/1/1", "load1:1/1/1"]);
    expect(calls.stopped).toBe(6);
    expect(result.metrics["streamers.started"]?.value).toBe(2);
    expect(result.metrics["viewers.total"]?.value).toBe(6);
    expect(result.metrics["egress.relay"]).toEqual({ value: 2_000, unit: "bytes" });
    expect(result.metrics["load.shards"]?.value).toBe(0);
    expect(result.data.loadPlan).toEqual({ viewers: 6, browserViewers: 4, shards: [] });
    expect(result.data.load).toMatchObject({ viewers: 6, generator: { host: null } });
    expect(result.steps.map((s) => s.name)).toContain("hold for 0 s");
  });
});

describe("runAudience against a remote target", () => {
  test("the target's CPU and NIC come over the runner; the generator is judged", async () => {
    const { platform } = fakePlatform({ report: () => ({ ttffMs: 500, playedSeconds: 1 }) });
    const proc = procRunner({ cpuBusy: 40, txBytes: 5_000_000 });
    let load: LoadResult | null = null;
    const result = await inScenario(platform, async (ctx) => {
      const topo = topology({ target: "ops@target", run: proc.run });
      load = await runLoad(ctx, { streamers: 1, viewers: 2, durationMs: 1_100, browserViewers: 0 }, topo);
    });
    expect(result.status).toBe("passed");
    const r = load as unknown as LoadResult;
    expect(proc.reads()).toBeGreaterThanOrEqual(2);
    expect(r.hosts.containersSource).toBe("ssh");
    // podman over SSH failed: the container stats are partial and say so.
    expect(r.hosts.containersIncomplete).toBe(true);
    expect(r.hosts.target?.cpu.p95).toBeCloseTo(40, 0);
    expect(busiestTxP95(r.hosts.target)).toBeGreaterThan(0);
    expect(r.generatorVerdict).not.toBeNull();
    expect(result.metrics["target.cpu.p95"]?.unit).toBe("%");
    expect(result.metrics["target.nic.eth0.tx_bytes_per_second"]?.value).toBeGreaterThan(0);
  });
});

/** A host summary from two real reads of a fake `/proc`, with a fixed clock. */
async function hostSummary(txBytes: number): Promise<HostSummary> {
  const proc = procRunner({ cpuBusy: 25, txBytes });
  let t = 0;
  const s = new HostSampler(
    async () => (await proc.run("h", "sh -c snapshot")).stdout,
    5_000,
    () => (t += 1_000),
  );
  await s.tick();
  await s.tick();
  return s.summary();
}

describe("host metrics", () => {
  test("busiestTxP95: null without a host or a measured interface, else the busiest link", async () => {
    expect(busiestTxP95(null)).toBeNull();
    const h = await hostSummary(1_000);
    expect(busiestTxP95(h)).toBe(1_000);
    expect(busiestTxP95({ ...h, nic: {} })).toBeNull();
  });

  test("recordHostMetrics: nothing for an unmeasured host; every series under the prefix", async () => {
    const metrics: Record<string, { value: number | null | undefined; unit?: string }> = {};
    const ctx = {
      metric: (name: string, value: number | null | undefined, unit?: string) => (metrics[name] = { value, unit }),
    };
    recordHostMetrics(ctx, "target", null);
    expect(metrics).toEqual({});
    recordHostMetrics(ctx, "target", await hostSummary(2_000));
    expect(metrics["target.nic.eth0.tx_bytes_per_second"]).toEqual({ value: 2_000, unit: "bytes/s" });
    expect(metrics["target.mem.total_bytes"]).toEqual({ value: 8_000_000 * 1024, unit: "bytes" });
    expect(metrics["target.samples_incomplete"]).toEqual({ value: 0, unit: undefined });
  });
});

describe("judging a run", () => {
  const report = buildLoadReport({
    streamers: 1,
    viewers: 2,
    windowSeconds: 10,
    all: {
      ...emptyAggregate(),
      viewers: 2,
      started: 2,
    },
    browser: emptyAggregate(),
    egressBySource: {},
    egressMethod: "viewer-reported",
    cpu: {},
    shards: 0,
  });

  function recorder() {
    const out = {
      asserts: [] as [string, boolean][],
      checks: [] as [string, boolean][],
      data: {} as Record<string, unknown>,
      metrics: {} as Record<string, unknown>,
      inconclusive: [] as string[],
    };
    const ctx = {
      assert: (name: string, ok: boolean) => void out.asserts.push([name, ok]),
      check: (name: string, ok: boolean) => (out.checks.push([name, ok]), ok),
      data: (k: string, v: unknown) => void (out.data[k] = v),
      metric: (k: string, v: unknown) => void (out.metrics[k] = v),
      log,
      inconclusive: (r: string) => void out.inconclusive.push(r),
    };
    return { out, ctx: ctx as unknown as Parameters<typeof judgeLoadRun>[0] };
  }

  test("judgeLoad: every viewer started is hard; stalls, TTFF, latency and errors are soft", () => {
    const { out, ctx } = recorder();
    judgeLoad(ctx, report);
    expect(out.asserts).toEqual([["every viewer started playback", true]]);
    expect(out.checks.map(([n]) => n)).toEqual([
      "stall ratio below 5 %",
      "p95 TTFF under 15 s",
      "p95 glass-to-glass under 15 s",
      "no viewer errors",
    ]);
  });

  test("a local run (no generator verdict) is always judged, whatever its heartbeats", () => {
    const { out, ctx } = recorder();
    expect(judgeLoadRun(ctx, { report, generatorVerdict: null, heartbeatErrors: 99 })).toBe("judged");
    expect(out.data.verdict).toBeUndefined();
    expect(out.inconclusive).toEqual([]);
  });

  test("a remote run the generator coped with is judged, with the judge's notes", () => {
    const { out, ctx } = recorder();
    const v = { inconclusive: false, limits: [], notes: ["gen1: not measured"] };
    expect(judgeLoadRun(ctx, { report, generatorVerdict: v, heartbeatErrors: 0 })).toBe("judged");
    expect(out.data.verdict).toEqual({ outcome: "judged", notes: ["gen1: not measured"] });
    expect(out.asserts).toHaveLength(1);
  });

  test("a generator limit or failed heartbeats make it inconclusive, each reason recorded", () => {
    const { out, ctx } = recorder();
    const v = {
      inconclusive: true,
      limits: [{ kind: "cpu" as const, host: "local", cpuP95: 97.25, threshold: 85 }],
      notes: [],
    };
    expect(judgeLoadRun(ctx, { report, generatorVerdict: v, heartbeatErrors: 3 }, 1)).toBe("inconclusive");
    expect(out.inconclusive).toEqual([
      "local: CPU p95 97.3 % > 85 %",
      "3 failed heartbeats > 1: the generator's address was rate-limited",
    ]);
    expect(out.metrics["load.inconclusive"]).toBe(1);
    expect(out.asserts).toEqual([]);
  });

  test("heartbeats alone, and an inconclusive verdict with no limit, still say why", () => {
    const a = recorder();
    const coped = { inconclusive: false, limits: [], notes: [] };
    expect(judgeLoadRun(a.ctx, { report, generatorVerdict: coped, heartbeatErrors: 1 })).toBe("inconclusive");
    expect(a.out.inconclusive).toEqual(["1 failed heartbeats > 0: the generator's address was rate-limited"]);
    const b = recorder();
    expect(
      judgeLoadRun(b.ctx, { report, generatorVerdict: { ...coped, inconclusive: true }, heartbeatErrors: 0 }),
    ).toBe("inconclusive");
    expect(b.out.inconclusive).toEqual(["the generator judge found the run inconclusive"]);
  });
});

function emptyAggregate() {
  return {
    viewers: 0,
    started: 0,
    ttff: { p50: null, p95: null, max: null },
    latency: { p50: null, p95: null, max: null },
    stalls: 0,
    stallMs: 0,
    stallRatio: 0,
    stallsPerMinute: 0,
    errors: 0,
    playedSeconds: 0,
  } as unknown as LoadResult["all"];
}

describe("the load-sweep scenario", () => {
  test("steps the audience over one fleet, counts ladders, and passes when no step breaks", async () => {
    const { platform, calls } = fakePlatform({
      report: () => ({ ttffMs: 300, latencyMs: [800], playedSeconds: 1, bytesHttp: 10 }),
      renditions: ["source", "720p"],
    });
    const r = await runOne(sweepScenario, platform, {
      command: "run",
      profile: "default",
      env,
      log,
      platform,
      runId: "r1",
      params: { steps: "2,4", streamers: "2", seconds: "1", cooldownSeconds: "0", browserViewers: "0" },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("passed");
    // The streams stay up across steps: two sign-ups, not four.
    expect(calls.signUps).toHaveLength(2);
    const rows = r.data.sweep as { viewers: number; status: string; ladders: number | null }[];
    expect(rows.map((x) => [x.viewers, x.status, x.ladders])).toEqual([
      [2, "pass", 2],
      [4, "pass", 2],
    ]);
    expect(r.metrics["sweep.steps_run"]?.value).toBe(2);
    expect(r.metrics["sweep.last_passing.viewers"]?.value).toBe(4);
    expect(r.metrics["sweep.inconclusive"]?.value).toBe(0);
  });

  test("a step that breaks stops the sweep and fails the run when it was the first", async () => {
    const { platform } = fakePlatform({
      // Nobody ever starts playing: every step breaks.
      report: () => ({ ttffMs: null, errors: ["no media"] }),
      renditions: "throw",
    });
    const r = await runOne(sweepScenario, platform, {
      command: "run",
      profile: "default",
      env,
      log,
      platform,
      runId: "r1",
      params: { steps: "2,4", streamers: "1", seconds: "1", cooldownSeconds: "0", browserViewers: "0" },
    });
    expect(r.status).toBe("failed");
    const rows = r.data.sweep as { viewers: number; status: string; ladders: number | null }[];
    expect(rows).toHaveLength(1);
    // playback.start failed on every channel: ladders unknown, not 0.
    expect(rows[0]?.ladders).toBeNull();
    expect(r.assertions.find((a) => a.name === "the first step met the targets")?.passed).toBe(false);
  });
});
