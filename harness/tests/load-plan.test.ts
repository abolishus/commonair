// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { parseArgs } from "../src/args.ts";
import { allocateViewers, plannedShards, totalViewers, viewerReportedEgress } from "../src/load.ts";
import { LOAD_PLAN_DEFAULTS, LOAD_SMOKE_DEFAULTS, LoadParamError, parseLoadParams } from "../src/load/params.ts";
import { type LoadMeasurements, buildLoadReport, loadVerdict } from "../src/load/report.ts";
import {
  DEFAULT_HTTP_PER_PROCESS,
  type LineSink,
  ShardLink,
  formatShardLine,
  parseShardLine,
  shardCount,
  shardTotal,
  splitShards,
  writeShardLine,
} from "../src/load/shard.ts";
import { type ViewerReport, aggregateReports, emptyReport } from "../src/viewer.ts";

function viewer(
  id: string,
  kind: "browser" | "http",
  r: Partial<
    Pick<
      ViewerReport,
      "ttffMs" | "stalls" | "stallMs" | "playedSeconds" | "latencyMs" | "bytesHttp" | "bytesP2p" | "source" | "errors"
    >
  >,
): ViewerReport {
  return { ...emptyReport(id, kind, kind === "browser" ? "chromium" : "http"), ...r };
}

describe("load parameters (--set keys)", () => {
  test("load-plan defaults are the PLAN size", () => {
    expect(parseLoadParams({}, LOAD_PLAN_DEFAULTS)).toEqual({
      streamers: 20,
      viewers: 4000,
      seconds: 120,
      browserViewers: 20,
      httpPerProcess: DEFAULT_HTTP_PER_PROCESS,
    });
    expect(parseLoadParams({}, LOAD_SMOKE_DEFAULTS)).toMatchObject({ streamers: 2, viewers: 10, seconds: 30 });
  });

  test("every key is settable; viewers is the total, viewersPerStreamer per channel", () => {
    expect(
      parseLoadParams(
        { streamers: "4", viewersPerStreamer: "50", seconds: "60", browserViewers: "8", httpPerProcess: "64" },
        LOAD_PLAN_DEFAULTS,
      ),
    ).toEqual({ streamers: 4, viewers: 200, seconds: 60, browserViewers: 8, httpPerProcess: 64 });
    expect(parseLoadParams({ viewers: "7" }, LOAD_SMOKE_DEFAULTS).viewers).toBe(7);
  });

  test("bad values are refused with the key named", () => {
    expect(() => parseLoadParams({ streamers: "0" }, LOAD_PLAN_DEFAULTS)).toThrow(/streamers=0/);
    expect(() => parseLoadParams({ seconds: "1.5" }, LOAD_PLAN_DEFAULTS)).toThrow(LoadParamError);
    expect(() => parseLoadParams({ viewersPerStreamer: "" }, LOAD_PLAN_DEFAULTS)).toThrow(/viewersPerStreamer/);
    expect(() => parseLoadParams({ httpPerProcess: "-1" }, LOAD_PLAN_DEFAULTS)).toThrow(/httpPerProcess/);
    expect(() => parseLoadParams({ viewers: "10", viewersPerStreamer: "5" }, LOAD_PLAN_DEFAULTS)).toThrow(/exclusive/);
    expect(() => parseLoadParams({ viewers: "3", browserViewers: "4" }, LOAD_SMOKE_DEFAULTS)).toThrow(/exceeds/);
  });

  test("the CLI passes the new keys through --set", () => {
    const cmd = parseArgs([
      "run",
      "load-plan",
      "--set",
      "viewersPerStreamer=200",
      "--set=httpPerProcess=500",
      "--set",
      "browserViewers=20",
    ]);
    expect(cmd).toMatchObject({
      kind: "run",
      scenarios: ["load-plan"],
      params: { viewersPerStreamer: "200", httpPerProcess: "500", browserViewers: "20" },
    });
    if (cmd.kind !== "run") throw new Error("expected run");
    expect(parseLoadParams(cmd.params, LOAD_PLAN_DEFAULTS)).toMatchObject({ viewers: 4000, httpPerProcess: 500 });
  });
});

describe("per-streamer viewers and sharding", () => {
  test("viewersPerStreamer gives every channel exactly that many", () => {
    expect(totalViewers({ streamers: 20, viewers: 0, viewersPerStreamer: 200 })).toBe(4000);
    expect(totalViewers({ streamers: 3, viewers: 10 })).toBe(10);
    const plan = allocateViewers(20, 4000, 20);
    for (const a of plan) expect(a.chromium + a.webkit + a.http).toBe(200);
    expect(plan.reduce((s, a) => s + a.chromium + a.webkit, 0)).toBe(20);
  });

  test("shard counts", () => {
    expect(shardCount(0, 1000)).toBe(0);
    expect(shardCount(1000, 1000)).toBe(1);
    expect(shardCount(1001, 1000)).toBe(2);
    expect(shardCount(3980, 1000)).toBe(4);
    expect(() => shardCount(10, 0)).toThrow(RangeError);
    // One process is no sharding at all; no limit means never.
    expect(plannedShards(allocateViewers(2, 10, 2), 1000)).toBe(0);
    expect(plannedShards(allocateViewers(20, 4000, 20), undefined)).toBe(0);
    expect(plannedShards(allocateViewers(20, 4000, 20), 1000)).toBe(4);
  });

  test("the split keeps every viewer, balances shards within one and spreads channels", () => {
    const perChannel = allocateViewers(20, 4000, 20).map((a) => ({ channel: `c${a.channelIndex}`, http: a.http }));
    const shards = splitShards(perChannel, 4);
    const totals = shards.map(shardTotal);
    expect(totals.reduce((s, n) => s + n, 0)).toBe(3980);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
    for (const s of shards) expect(s.channels.length).toBe(20);
    for (const c of perChannel) {
      const sum = shards.reduce((n, s) => n + (s.channels.find((x) => x.channel === c.channel)?.http ?? 0), 0);
      expect(sum).toBe(c.http);
    }
    expect(splitShards([{ channel: "a", http: 3 }], 5).map(shardTotal)).toEqual([1, 1, 1, 0, 0]);
    expect(() => splitShards([], 0)).toThrow(RangeError);
  });

  test("the child protocol round-trips and ignores log lines", () => {
    const reports = [viewer("v1", "http", { ttffMs: 900 })];
    expect(parseShardLine(formatShardLine({ type: "reports", shard: 2, reports }))).toEqual({
      type: "reports",
      shard: 2,
      reports,
    });
    expect(parseShardLine(formatShardLine({ type: "started", shard: 0, viewers: 995 }))).toEqual({
      type: "started",
      shard: 0,
      viewers: 995,
    });
    expect(parseShardLine('{"level":"info","msg":"x"}')).toBeNull();
    expect(parseShardLine("LOAD_SHARD {not json")).toBeNull();
    expect(parseShardLine('LOAD_SHARD {"type":"reports","shard":1}')).toBeNull();
    expect(parseShardLine('LOAD_SHARD {"type":"started","viewers":3}')).toBeNull();
  });
});

describe("load report", () => {
  const reports = [
    viewer("b1", "browser", {
      ttffMs: 1000,
      latencyMs: [3000, 4000],
      playedSeconds: 100,
      bytesHttp: 500,
      source: "origin",
    }),
    viewer("b2", "browser", {
      ttffMs: 2000,
      latencyMs: [5000, 20000],
      playedSeconds: 90,
      stalls: 1,
      stallMs: 10_000,
      bytesHttp: 400,
      source: "origin",
    }),
    viewer("h1", "http", {
      ttffMs: 1500,
      latencyMs: [2500],
      playedSeconds: 100,
      bytesHttp: 1000,
      bytesP2p: 100,
      source: "relay",
    }),
    viewer("h2", "http", { ttffMs: null, errors: ["playlist 404"] }),
  ];
  const all = aggregateReports(reports);
  const browser = aggregateReports(reports.filter((r) => r.kind === "browser"));
  const m: LoadMeasurements = {
    streamers: 2,
    viewers: 4,
    windowSeconds: 100,
    all,
    browser,
    egressBySource: viewerReportedEgress(reports),
    egressMethod: "viewer-reported",
    cpu: { commonair_origin_1: { meanCpuPercent: 12.345, peakCpuPercent: 40, samples: 20 } },
    shards: 0,
  };

  test("egress: by source, total, per second and per viewer", () => {
    expect(m.egressBySource).toEqual({ origin: 900, relay: 1000, p2p: 100, direct: 0 });
    const r = buildLoadReport(m);
    expect(r.egress.totalBytes).toBe(2000);
    expect(r.egress.bytesPerSecond).toBe(20);
    expect(r.egress.perViewerBytes).toBe(500);
    expect(r.egress.perViewerBytesPerSecond).toBe(5);
    expect(r.egress.bySource.relay).toEqual({ bytes: 1000, bytesPerSecond: 10 });
    expect(buildLoadReport({ ...m, viewers: 0, windowSeconds: 0 }).egress).toMatchObject({
      perViewerBytes: 0,
      bytesPerSecond: 0,
    });
  });

  test("p95 latency (browsers only), p95 TTFF, stalls, errors and CPU", () => {
    const r = buildLoadReport(m);
    // Nearest-rank p95 over [3000, 4000, 5000, 20000] → 20000.
    expect(r.glassToGlassP95Ms).toBe(20_000);
    // Nearest-rank p95 over the three TTFFs → 2000; a viewer that never started has none.
    expect(r.ttffP95Ms).toBe(2000);
    expect(r.started).toBe(3);
    // 10 s stalled of 290 s played + 10 s stalled.
    expect(r.stallRatio).toBeCloseTo(10 / 300, 10);
    expect(r.stallCount).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.cpu).toEqual({ commonair_origin_1: { avgPercent: 12.35, maxPercent: 40, samples: 20 } });
  });

  test("verdict: hard start check, soft quality checks", () => {
    const v = loadVerdict(buildLoadReport(m));
    expect(v).toEqual({
      everyViewerStarted: false,
      stallRatioOk: true,
      latencyOk: false,
      ttffOk: true,
      noErrors: false,
    });
    const good = loadVerdict({
      ...buildLoadReport(m),
      started: 4,
      glassToGlassP95Ms: 6000,
      errors: 0,
    });
    expect(good).toEqual({
      everyViewerStarted: true,
      stallRatioOk: true,
      latencyOk: true,
      ttffOk: true,
      noErrors: true,
    });
    expect(loadVerdict({ ...buildLoadReport(m), glassToGlassP95Ms: null }).latencyOk).toBe(false);
  });
});

describe("ShardLink: a child's exit races its stdout", () => {
  const reportsLine = (n: number) =>
    formatShardLine({
      type: "reports",
      shard: 0,
      reports: Array.from({ length: n }, (_, i) => emptyReport(`v${i}`, "http", "http")),
    });

  test("a clean exit before the reports line is parsed still yields the reports", async () => {
    const link = new ShardLink(0, 200);
    link.onLine(formatShardLine({ type: "started", shard: 0, viewers: 3 }));
    link.onExit(0, () => []);
    await new Promise((r) => setTimeout(r, 20));
    link.onLine(reportsLine(3));
    expect(await link.started).toBe(3);
    expect((await link.reports).length).toBe(3);
  });

  test("an exit with no reports line fails the shard after the drain grace, with the stderr tail", async () => {
    const link = new ShardLink(2, 20);
    link.onExit(1, () => ["a", "b", "boom"]);
    await expect(link.reports).rejects.toThrow(/load shard 2 exited \(1\): a \| b \| boom/);
    await expect(link.started).rejects.toThrow(/exited/);
  });

  test("an exit after the reports line is not an error", async () => {
    const link = new ShardLink(0, 10);
    link.onLine(reportsLine(1));
    link.onExit(0, () => []);
    await new Promise((r) => setTimeout(r, 30));
    expect((await link.reports).length).toBe(1);
  });

  test("an error line fails the shard at once", async () => {
    const link = new ShardLink(1, 10_000);
    link.onLine(formatShardLine({ type: "error", shard: 1, error: "no origin" }));
    await expect(link.reports).rejects.toThrow("load shard 1: no origin");
  });
});

describe("writeShardLine", () => {
  test("resolves only after the sink has flushed the line", async () => {
    let flush: (() => void) | undefined;
    const written: string[] = [];
    const sink: LineSink = {
      write(chunk, cb) {
        written.push(chunk);
        flush = () => cb();
        return false;
      },
    };
    let done = false;
    const p = writeShardLine(sink, { type: "started", shard: 0, viewers: 1 }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    expect(written[0]?.endsWith("\n")).toBe(true);
    flush?.();
    await p;
    expect(done).toBe(true);
  });

  test("rejects on a write error", async () => {
    const sink: LineSink = { write: (_c, cb) => (cb(new Error("EPIPE")), false) };
    await expect(writeShardLine(sink, { type: "started", shard: 0, viewers: 1 })).rejects.toThrow("EPIPE");
  });
});
