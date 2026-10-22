// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Load test: N streamers × M viewers for a duration. Viewers are mostly HTTP-only (cheap) with a
 * slice of real browsers for true glass-to-glass latency. Past `httpPerProcess` HTTP viewers the
 * HTTP audience moves to child harness processes (`load/worker.ts`). Reports origin egress by
 * delivery source (Prometheus when available, viewer-reported bytes otherwise), container CPU
 * (podman stats), p95 glass-to-glass and TTFF, and stalls, as the report's `load` section.
 */
import { fileURLToPath } from "node:url";
import { type LoadReport, buildLoadReport, loadVerdict } from "./load/report.ts";
import {
  SHARD_EXIT_DRAIN_MS,
  ShardLink,
  type ShardSpec,
  type WorkerSpec,
  shardCount,
  shardTotal,
  splitShards,
} from "./load/shard.ts";
import { ORIGIN_EGRESS_QUERY, CpuSampler, Prometheus, summarize } from "./metrics.ts";
import { type Supervised, spawnSupervised } from "./process.ts";
import type { ScenarioContext } from "./scenario.ts";
import type { Streamer } from "./streamer.ts";
import type { SignedInUser } from "./users.ts";
import { type Viewer, type ViewerAggregate, type ViewerReport, aggregateReports } from "./viewer.ts";

export interface LoadOptions {
  streamers: number;
  /** Total viewers, spread round-robin (ignored when `viewersPerStreamer` is set). */
  viewers: number;
  /** Viewers on every channel (total = streamers × this). */
  viewersPerStreamer?: number;
  durationMs: number;
  /** Browser viewers among `viewers` (default: 10 %, at most 20). Split between Chromium and WebKit. */
  browserViewers?: number;
  /** HTTP viewers one process drives; above it they move to child processes (default: never). */
  httpPerProcess?: number;
  protocol?: "rtmp" | "whip";
  width?: number;
  height?: number;
  bitrateKbps?: number;
}

export interface LoadAllocation {
  channelIndex: number;
  chromium: number;
  webkit: number;
  http: number;
}

/** Spread viewers round-robin over channels; browser viewers alternate Chromium/WebKit. Pure. */
export function allocateViewers(streamers: number, viewers: number, browserViewers: number): LoadAllocation[] {
  const plan = Array.from({ length: streamers }, (_, channelIndex) => ({
    channelIndex,
    chromium: 0,
    webkit: 0,
    http: 0,
  }));
  const browsers = Math.min(browserViewers, viewers);
  for (let i = 0; i < viewers; i++) {
    const slot = plan[i % streamers];
    if (!slot) continue;
    if (i < browsers) {
      if (Math.floor(i / streamers) % 2 === 0) slot.chromium++;
      else slot.webkit++;
    } else {
      slot.http++;
    }
  }
  return plan;
}

export function defaultBrowserViewers(viewers: number): number {
  return Math.min(20, Math.floor(viewers / 10));
}

/** Total viewers for the options (per-streamer wins over the total). Pure. */
export function totalViewers(opts: Pick<LoadOptions, "streamers" | "viewers" | "viewersPerStreamer">): number {
  return opts.viewersPerStreamer === undefined ? opts.viewers : opts.streamers * opts.viewersPerStreamer;
}

/** Child processes for an allocation (0 = every HTTP viewer stays in this process). Pure. */
export function plannedShards(allocation: readonly LoadAllocation[], httpPerProcess: number | undefined): number {
  if (httpPerProcess === undefined) return 0;
  const n = shardCount(
    allocation.reduce((s, a) => s + a.http, 0),
    httpPerProcess,
  );
  return n > 1 ? n : 0;
}

export interface LoadResult {
  streamers: number;
  viewers: number;
  durationMs: number;
  windowSeconds: number;
  shards: number;
  all: ViewerAggregate;
  browser: ViewerAggregate;
  http: ViewerAggregate;
  egressBySource: Record<string, number>;
  egressMethod: "prometheus" | "viewer-reported";
  cpu: Record<string, { meanCpuPercent: number; peakCpuPercent: number; samples: number }>;
  report: LoadReport;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

const WORKER_ENTRY = fileURLToPath(new URL("./load/worker.ts", import.meta.url));
/** Generous: a child opens its viewers with a staggered start (~50 ms each). */
const SHARD_START_MS_PER_VIEWER = 150;
const SHARD_STOP_GRACE_MS = 90_000;

/** A child process driving one shard of the HTTP audience. */
class ShardProcess {
  private proc: Supervised;
  private link: ShardLink;

  constructor(ctx: ScenarioContext, spec: ShardSpec, maxMs: number) {
    const link = new ShardLink(spec.index);
    this.link = link;
    const worker: WorkerSpec = { shard: spec, runId: ctx.runId, maxMs };
    this.proc = spawnSupervised(["bun", WORKER_ENTRY, JSON.stringify(worker)], {
      name: `load-shard-${spec.index}`,
      onStdoutLine: (line) => link.onLine(line),
    });
    void this.proc.exited.then((code) => link.onExit(code, () => this.proc.stderr()));
  }

  waitStarted(timeoutMs: number): Promise<number> {
    return withTimeout(this.link.started, timeoutMs, "load shard start");
  }

  async stop(): Promise<ViewerReport[]> {
    if (this.proc.running) void this.proc.stop(SHARD_STOP_GRACE_MS);
    return withTimeout(this.link.reports, SHARD_STOP_GRACE_MS + SHARD_EXIT_DRAIN_MS, "load shard reports");
  }

  kill(): Promise<number> {
    return this.proc.stop(1_000);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Run the load test inside a scenario context (records steps and metrics on it). */
export async function runLoad(ctx: ScenarioContext, opts: LoadOptions): Promise<LoadResult> {
  const p = ctx.platform;
  const viewersTotal = totalViewers(opts);
  const browserViewers = opts.browserViewers ?? defaultBrowserViewers(viewersTotal);
  const users = await ctx.step(`sign up ${opts.streamers} streamers`, () =>
    mapLimit(Array.from({ length: opts.streamers }), 4, () => p.signUp({ prefix: "load" })),
  );
  const channels = users.map((u: SignedInUser) => u.me.channelSlug ?? u.username);

  const streamers: Streamer[] = await ctx.step("start streamers", () =>
    mapLimit(users, 4, async (user, i) => {
      const s = await p.streamerFor(user, {
        protocol: opts.protocol ?? "rtmp",
        width: opts.width ?? 640,
        height: opts.height ?? 360,
        bitrateKbps: opts.bitrateKbps ?? 1200,
        toneHz: 300 + i * 40,
      });
      ctx.defer(() => s.stop());
      await s.start();
      return s;
    }),
  );
  ctx.metric("streamers.started", streamers.length);
  await ctx.step("all channels live", () => Promise.all(channels.map((c) => p.waitForLive(c, true, 60_000))));

  const cpu = new CpuSampler(ctx.env.HARNESS_CONTAINER_PREFIX);
  cpu.start();
  ctx.defer(() => cpu.stop());

  const allocation = allocateViewers(opts.streamers, viewersTotal, browserViewers);
  const shards = plannedShards(allocation, opts.httpPerProcess);
  const shardSpecs =
    shards > 0
      ? splitShards(
          allocation.map((a) => ({ channel: channels[a.channelIndex] as string, http: a.http })),
          shards,
        )
      : [];
  ctx.data("loadPlan", {
    viewers: viewersTotal,
    browserViewers,
    shards: shardSpecs.map((s) => ({ index: s.index, viewers: shardTotal(s) })),
  });

  const children: ShardProcess[] = [];
  const viewers: Viewer[] = await ctx.step(`open ${viewersTotal} viewers`, async () => {
    const opened: Viewer[] = [];
    // Children first: they open their audience while this process opens the browsers.
    const maxMs = opts.durationMs + 30 * 60_000;
    for (const spec of shardSpecs) {
      const child = new ShardProcess(ctx, spec, maxMs);
      children.push(child);
      ctx.defer(() => child.kill());
    }
    for (const a of allocation) {
      const channel = channels[a.channelIndex] as string;
      opened.push(
        ...(await p.openViewers(channel, {
          chromium: a.chromium,
          webkit: a.webkit,
          http: shards > 0 ? 0 : a.http,
          perPage: 5,
        })),
      );
    }
    for (const v of opened) ctx.defer(() => v.stop());
    const started = await Promise.all(
      children.map((c, i) =>
        c.waitStarted(60_000 + SHARD_START_MS_PER_VIEWER * shardTotal(shardSpecs[i] as ShardSpec)),
      ),
    );
    if (children.length > 0) ctx.log.info("load shards started", { shards: children.length, viewers: started });
    return opened;
  });

  const windowStarted = Date.now();
  await ctx.step(`hold for ${Math.round(opts.durationMs / 1000)} s`, async () => {
    const deadline = windowStarted + opts.durationMs;
    while (Date.now() < deadline && !ctx.signal.aborted) {
      await Bun.sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
      const agg = aggregateReports(await Promise.all(viewers.map((v) => v.report())));
      ctx.log.info("load progress", {
        started: agg.started,
        viewers: agg.viewers,
        shardedViewers: viewersTotal - viewers.length,
        stallRatio: Number(agg.stallRatio.toFixed(4)),
        p95LatencyMs: agg.latency.p95,
      });
    }
  });
  const windowSeconds = (Date.now() - windowStarted) / 1000;

  const reports: ViewerReport[] = await ctx.step("collect viewer reports", async () => {
    const [local, ...remote] = await Promise.all([
      Promise.all(viewers.map((v) => v.stop())),
      ...children.map((c) => c.stop()),
    ]);
    return [...(local ?? []), ...remote.flat()];
  });
  await cpu.stop();

  let egressBySource: Record<string, number> = {};
  let egressMethod: LoadResult["egressMethod"] = "viewer-reported";
  if (ctx.env.HARNESS_PROMETHEUS_URL) {
    const rows = await new Prometheus(ctx.env.HARNESS_PROMETHEUS_URL).query(ORIGIN_EGRESS_QUERY(windowSeconds));
    if (rows && rows.length > 0) {
      egressMethod = "prometheus";
      egressBySource = Object.fromEntries(rows.map((r) => [r.labels.source ?? "unknown", Math.round(r.value)]));
    }
  }
  if (egressMethod === "viewer-reported") egressBySource = viewerReportedEgress(reports);

  const all = aggregateReports(reports);
  const browser = aggregateReports(reports.filter((r) => r.kind === "browser"));
  const cpuSummary = cpu.summary();
  const result: LoadResult = {
    streamers: opts.streamers,
    viewers: viewersTotal,
    durationMs: opts.durationMs,
    windowSeconds,
    shards: children.length,
    all,
    browser,
    http: aggregateReports(reports.filter((r) => r.kind === "http")),
    egressBySource,
    egressMethod,
    cpu: cpuSummary,
    report: buildLoadReport({
      streamers: opts.streamers,
      viewers: viewersTotal,
      windowSeconds,
      all,
      browser,
      egressBySource,
      egressMethod,
      cpu: cpuSummary,
      shards: children.length,
    }),
  };
  recordLoadMetrics(ctx, result);
  return result;
}

/** Egress by delivery source from the viewers' own byte counts (no Prometheus). Pure. */
export function viewerReportedEgress(reports: readonly ViewerReport[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reports) {
    const source = r.source ?? "direct";
    out[source] = (out[source] ?? 0) + r.bytesHttp;
    if (r.bytesP2p > 0) out.p2p = (out.p2p ?? 0) + r.bytesP2p;
  }
  return out;
}

/** The spec's assertions on a load run: every viewer started (hard); stalls, latency, errors (soft). */
export function judgeLoad(ctx: Pick<ScenarioContext, "assert" | "check">, rep: LoadReport): void {
  const v = loadVerdict(rep);
  ctx.assert("every viewer started playback", v.everyViewerStarted, { started: rep.started, viewers: rep.viewers });
  ctx.check("stall ratio below 5 %", v.stallRatioOk, { stallRatio: rep.stallRatio, stalls: rep.stallCount });
  ctx.check("p95 TTFF under 15 s", v.ttffOk, { ttffP95Ms: rep.ttffP95Ms });
  ctx.check("p95 glass-to-glass under 15 s", v.latencyOk, { glassToGlassP95Ms: rep.glassToGlassP95Ms });
  ctx.check("no viewer errors", v.noErrors, { errors: rep.errors });
}

export function recordLoadMetrics(ctx: Pick<ScenarioContext, "metric" | "data">, r: LoadResult): void {
  const rep = r.report;
  ctx.metric("viewers.total", r.all.viewers);
  ctx.metric("viewers.started", r.all.started);
  ctx.metric("ttff.p95", r.all.ttff.p95, "ms");
  ctx.metric("ttff.p50", r.all.ttff.p50, "ms");
  // Browser latency is true glass-to-glass (pixels); HTTP latency is delivery latency.
  ctx.metric("glass_to_glass.p95", r.browser.latency.p95, "ms");
  ctx.metric("glass_to_glass.p50", r.browser.latency.p50, "ms");
  ctx.metric("http_delivery_latency.p95", r.http.latency.p95, "ms");
  ctx.metric("stall.ratio", r.all.stallRatio);
  ctx.metric("stall.count", r.all.stalls);
  ctx.metric("stall.per_minute", r.all.stallsPerMinute);
  ctx.metric("errors", r.all.errors);
  ctx.metric("egress.total", rep.egress.totalBytes, "bytes");
  ctx.metric("egress.bytes_per_second", rep.egress.bytesPerSecond, "bytes/s");
  ctx.metric("egress.per_viewer", rep.egress.perViewerBytes, "bytes");
  for (const [source, bytes] of Object.entries(r.egressBySource)) ctx.metric(`egress.${source}`, bytes, "bytes");
  const cpuMeans = Object.values(r.cpu).map((c) => c.meanCpuPercent);
  ctx.metric("cpu.containers_mean_total", cpuMeans.length ? cpuMeans.reduce((s, v) => s + v, 0) : null, "%");
  ctx.metric("load.shards", r.shards);
  ctx.data("load", {
    ...rep,
    breakdown: { all: r.all, browser: r.browser, http: r.http },
    cpuSummary: summarize(cpuMeans),
  });
}
