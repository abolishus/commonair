// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Load test: N streamers × M viewers for a duration. Viewers are mostly HTTP-only (cheap) with a
 * slice of real browsers for true glass-to-glass latency. Past `httpPerProcess` HTTP viewers the
 * HTTP audience moves to child harness processes (`load/worker.ts`), on this machine or on other
 * generator hosts over SSH (`HARNESS_LOAD_GENERATOR_HOSTS`). Reports origin egress by delivery
 * source (Prometheus when available, viewer-reported bytes otherwise), container CPU (`podman
 * stats`, local or on the target over SSH), whole-host CPU, memory, load and NIC bytes for the
 * target and the generators, p95 glass-to-glass and TTFF, and stalls, as the report's `load`
 * section.
 *
 * The phases are separate so `load-sweep` can keep streams up while it steps the audience:
 * `startStreamers` → `runAudience` (repeatable) → `recordLoadMetrics`.
 */
import { mapLimit } from "./load/async.ts";
import { AccountStore, AuthPacer, provisionStreamers } from "./load/accounts.ts";
import { type LoadEnv, loadLoadEnv, mbpsToBytesPerSecond } from "./load/env.ts";
import { type HostSummary, HostSampler, localSnapshot } from "./load/host.ts";
import {
  type GeneratorThresholds,
  type GeneratorVerdict,
  describeLimit,
  heartbeatInvalid,
  judgeGenerators,
} from "./load/judge.ts";
import {
  LOCAL_HOST,
  LOCAL_REPO_ROOT,
  type ShardHandle,
  assignShardHosts,
  forwardedEnv,
  startShard,
} from "./load/processes.ts";
import { type LoadReport, buildLoadReport, loadVerdict } from "./load/report.ts";
import { type ShardSpec, type WorkerSpec, shardCount, shardTotal, splitShards } from "./load/shard.ts";
import { type CommandRunner, remotePodmanStats, remoteSnapshot, sshRunner } from "./load/ssh.ts";
import { ORIGIN_EGRESS_QUERY, CpuSampler, Prometheus, podmanStats, summarize } from "./metrics.ts";
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

/**
 * Shards with a generator-host list: at least one per listed host (so every host takes part),
 * never more than there are HTTP viewers. Without a list, `plannedShards`. Pure.
 */
export function plannedShardsOn(
  allocation: readonly LoadAllocation[],
  httpPerProcess: number | undefined,
  hosts: readonly string[],
): number {
  if (hosts.length === 0) return plannedShards(allocation, httpPerProcess);
  const http = allocation.reduce((s, a) => s + a.http, 0);
  if (http === 0) return 0;
  const base = httpPerProcess === undefined ? 1 : shardCount(http, httpPerProcess);
  return Math.min(http, Math.max(base, hosts.length));
}

/** Where the load test measures and generates: resolved once from the `HARNESS_LOAD_*` env. */
export interface LoadTopology {
  env: LoadEnv;
  /** SSH destination of the instance under test, or null for the local stack. */
  target: string | null;
  run: CommandRunner;
  /** Generator hosts other than this machine (SSH destinations). */
  remoteGenerators: string[];
}

export function loadTopology(env: LoadEnv = loadLoadEnv(), run: CommandRunner = sshRunner()): LoadTopology {
  return {
    env,
    target: env.HARNESS_LOAD_TARGET_SSH ?? null,
    run,
    remoteGenerators: [...new Set(env.HARNESS_LOAD_GENERATOR_HOSTS.filter((h) => h !== LOCAL_HOST))],
  };
}

export interface HostsReport {
  /** Whole-host stats of the target (null without `HARNESS_LOAD_TARGET_SSH`). */
  target: HostSummary | null;
  /** Container CPU source: `podman stats` here, or on the target over SSH. */
  containersSource: "local" | "ssh";
  /** A container sample failed (SSH down, podman error): the container stats are partial. */
  containersIncomplete: boolean;
  /** Generator hosts by name (`local` = this machine; null where `/proc` cannot be read). */
  generators: Record<string, HostSummary | null>;
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
  hosts: HostsReport;
  /** Only for a remote target (the generator is then a different machine to judge). */
  generatorVerdict: GeneratorVerdict | null;
  /**
   * Heartbeats that failed. Against a real instance every simulated viewer shares the generator's
   * address, and playback calls share its per-address `default` rate-limit bucket, so these are
   * the first sign that a run measures the rate limiter rather than capacity (capacity.md).
   */
  heartbeatErrors: number;
}

/** Generous: a child opens its viewers with a staggered start (~50 ms each). */
const SHARD_START_MS_PER_VIEWER = 150;

/** The streams of a run; `startStreamers` can grow it (the sweep's streamers axis). */
export interface StreamerFleet {
  users: SignedInUser[];
  channels: string[];
  streamers: Streamer[];
}

export type StreamOptions = Pick<LoadOptions, "protocol" | "width" | "height" | "bitrateKbps">;

/**
 * Sign up (or reuse, see `load/accounts.ts`) streamers and publish until the fleet has `count`
 * live channels. Pass the fleet back in to add more.
 */
export async function startStreamers(
  ctx: ScenarioContext,
  count: number,
  stream: StreamOptions,
  topo: LoadTopology,
  fleet: StreamerFleet = { users: [], channels: [], streamers: [] },
): Promise<StreamerFleet> {
  const p = ctx.platform;
  const add = count - fleet.users.length;
  if (add <= 0) return fleet;
  const perMinute = topo.env.HARNESS_LOAD_AUTH_PER_MINUTE;
  const store = topo.env.HARNESS_LOAD_ACCOUNTS_FILE
    ? new AccountStore(topo.env.HARNESS_LOAD_ACCOUNTS_FILE, ctx.env.HARNESS_API_URL)
    : null;
  const users = await ctx.step(`sign up ${add} streamers`, () =>
    provisionStreamers(p, add, {
      pacer: perMinute ? AuthPacer.perMinute(perMinute) : null,
      store,
      exclude: new Set(fleet.users.map((u) => u.username)),
      log: ctx.log,
      prefix: "load",
    }),
  );
  const channels = users.map((u: SignedInUser) => u.me.channelSlug ?? u.username);
  const offset = fleet.users.length;
  const streamers: Streamer[] = await ctx.step(offset === 0 ? "start streamers" : `start ${add} more streamers`, () =>
    mapLimit(users, 4, async (user, i) => {
      const s = await p.streamerFor(user, {
        protocol: stream.protocol ?? "rtmp",
        width: stream.width ?? 640,
        height: stream.height ?? 360,
        bitrateKbps: stream.bitrateKbps ?? 1200,
        toneHz: 300 + (offset + i) * 40,
      });
      ctx.defer(() => s.stop());
      await s.start();
      return s;
    }),
  );
  await ctx.step(offset === 0 ? "all channels live" : `${add} more channels live`, () =>
    Promise.all(channels.map((c) => p.waitForLive(c, true, 60_000))),
  );
  return {
    users: [...fleet.users, ...users],
    channels: [...fleet.channels, ...channels],
    streamers: [...fleet.streamers, ...streamers],
  };
}

export interface AudienceOptions {
  viewers: number;
  durationMs: number;
  browserViewers?: number;
  httpPerProcess?: number;
  /** Prefix for step names, so repeated audiences (sweep steps) stay apart in the report. */
  label?: string;
  /** Runs at the end of the hold, viewers still watching (the sweep checks ladders here). */
  beforeStop?: () => Promise<void>;
  /** Generator thresholds for the inconclusive judgment (remote target only). */
  generatorThresholds?: GeneratorThresholds;
}

/** Open an audience on the fleet's channels, hold, collect, measure. Streams stay up. */
export async function runAudience(
  ctx: ScenarioContext,
  fleet: StreamerFleet,
  opts: AudienceOptions,
  topo: LoadTopology,
): Promise<LoadResult> {
  const p = ctx.platform;
  const prefix = opts.label ? `${opts.label}: ` : "";
  const viewersTotal = opts.viewers;
  const browserViewers = opts.browserViewers ?? defaultBrowserViewers(viewersTotal);
  const channels = fleet.channels;

  const cpu = new CpuSampler(
    ctx.env.HARNESS_CONTAINER_PREFIX,
    5_000,
    topo.target ? remotePodmanStats(topo.run, topo.target) : podmanStats,
  );
  cpu.start();
  ctx.defer(() => cpu.stop());

  const allocation = allocateViewers(channels.length, viewersTotal, browserViewers);
  const hostList = topo.env.HARNESS_LOAD_GENERATOR_HOSTS;
  const shards = plannedShardsOn(allocation, opts.httpPerProcess, hostList);
  const shardSpecs =
    shards > 0
      ? splitShards(
          allocation.map((a) => ({ channel: channels[a.channelIndex] as string, http: a.http })),
          shards,
        )
      : [];
  const shardHosts = assignShardHosts(shardSpecs.length, hostList);
  ctx.data(opts.label ? `loadPlan ${opts.label}` : "loadPlan", {
    viewers: viewersTotal,
    browserViewers,
    shards: shardSpecs.map((s, i) => ({ index: s.index, viewers: shardTotal(s), host: shardHosts[i] })),
  });

  const children: ShardHandle[] = [];
  const remote = { repo: topo.env.HARNESS_LOAD_GENERATOR_REPO ?? LOCAL_REPO_ROOT, env: forwardedEnv(process.env) };
  const viewers: Viewer[] = await ctx.step(`${prefix}open ${viewersTotal} viewers`, async () => {
    const opened: Viewer[] = [];
    // Children first: they open their audience while this process opens the browsers.
    const maxMs = opts.durationMs + 30 * 60_000;
    shardSpecs.forEach((spec, i) => {
      const worker: WorkerSpec = { shard: spec, runId: ctx.runId, maxMs };
      const child = startShard(shardHosts[i] ?? LOCAL_HOST, worker, remote);
      children.push(child);
      ctx.defer(() => child.kill());
    });
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

  // Host samplers cover the hold only, so rates and per-viewer bytes match the egress window.
  const targetHost = topo.target ? new HostSampler(remoteSnapshot(topo.run, topo.target)) : null;
  const generatorHosts: Record<string, HostSampler> = { [LOCAL_HOST]: new HostSampler(localSnapshot) };
  for (const g of topo.remoteGenerators) generatorHosts[g] = new HostSampler(remoteSnapshot(topo.run, g));
  const samplers = [targetHost, ...Object.values(generatorHosts)].filter((s): s is HostSampler => s !== null);
  for (const s of samplers) {
    s.start();
    ctx.defer(() => s.stop());
  }

  const windowStarted = Date.now();
  await ctx.step(`${prefix}hold for ${Math.round(opts.durationMs / 1000)} s`, async () => {
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
    if (opts.beforeStop && !ctx.signal.aborted) await opts.beforeStop();
  });
  const windowSeconds = (Date.now() - windowStarted) / 1000;
  await Promise.all(samplers.map((s) => s.stop()));

  const reports: ViewerReport[] = await ctx.step(`${prefix}collect viewer reports`, async () => {
    const [local, ...fromShards] = await Promise.all([
      Promise.all(viewers.map((v) => v.stop())),
      ...children.map((c) => c.stop()),
    ]);
    return [...(local ?? []), ...fromShards.flat()];
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
  const generators = Object.fromEntries(
    Object.entries(generatorHosts).map(([name, s]) => {
      const summary = s.summary();
      // No /proc here (macOS): report it as not measured rather than as an empty host.
      return [name, summary.samples === 0 && name === LOCAL_HOST ? null : summary];
    }),
  );
  const hosts: HostsReport = {
    target: targetHost?.summary() ?? null,
    containersSource: topo.target ? "ssh" : "local",
    containersIncomplete: !cpu.available,
    generators,
  };
  return {
    streamers: channels.length,
    viewers: viewersTotal,
    durationMs: opts.durationMs,
    windowSeconds,
    shards: children.length,
    all,
    browser,
    http: aggregateReports(reports.filter((r) => r.kind === "http")),
    heartbeatErrors: reports.reduce((n, r) => n + r.heartbeatErrors, 0),
    egressBySource,
    egressMethod,
    cpu: cpuSummary,
    hosts,
    generatorVerdict: topo.target
      ? judgeGenerators(
          generators,
          mbpsToBytesPerSecond(topo.env.HARNESS_LOAD_GENERATOR_NIC_MBPS),
          opts.generatorThresholds,
        )
      : null,
    report: buildLoadReport({
      streamers: channels.length,
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
}

/** Run the load test inside a scenario context (records steps and metrics on it). */
export async function runLoad(
  ctx: ScenarioContext,
  opts: LoadOptions,
  topo: LoadTopology = loadTopology(),
): Promise<LoadResult> {
  const fleet = await startStreamers(ctx, opts.streamers, opts, topo);
  ctx.metric("streamers.started", fleet.streamers.length);
  const result = await runAudience(
    ctx,
    fleet,
    {
      viewers: totalViewers(opts),
      durationMs: opts.durationMs,
      browserViewers: opts.browserViewers,
      httpPerProcess: opts.httpPerProcess,
    },
    topo,
  );
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

/**
 * Judge a run, unless the generator was the limit or, against a remote target, more than
 * `maxHeartbeatErrors` heartbeats failed (the generator's address was rate-limited, so the run
 * measured the limiter): then the run is **inconclusive** (recorded as `data.verdict`, metric
 * `load.inconclusive`), and the target is neither passed nor failed on it. Returns the outcome.
 * Local runs (no remote target) are always judged.
 */
export function judgeLoadRun(
  ctx: Pick<ScenarioContext, "assert" | "check" | "data" | "metric" | "log">,
  result: Pick<LoadResult, "report" | "generatorVerdict" | "heartbeatErrors">,
  maxHeartbeatErrors = 0,
): "judged" | "inconclusive" {
  const v = result.generatorVerdict;
  // Remote runs only: locally the harness stack is the target and judged exactly as before.
  const invalid = v ? heartbeatInvalid(result.heartbeatErrors, maxHeartbeatErrors) : null;
  if (v?.inconclusive || invalid !== null) {
    const limits = v?.limits.map(describeLimit) ?? [];
    const reasons = invalid === null ? [] : [invalid];
    ctx.data("verdict", { outcome: "inconclusive", limits, invalid: reasons, notes: v?.notes ?? [] });
    ctx.metric("load.inconclusive", 1);
    ctx.log.warn("load run inconclusive: the generator was the limit or the measurement is invalid", {
      limits,
      invalid: reasons,
    });
    return "inconclusive";
  }
  if (v) ctx.data("verdict", { outcome: "judged", notes: v.notes });
  judgeLoad(ctx, result.report);
  return "judged";
}

/** Busiest interface's transmit p95 (one link = one ceiling). */
export function busiestTxP95(h: HostSummary | null): number | null {
  if (!h) return null;
  const values = Object.values(h.nic).flatMap((n) => (n.tx.p95 === null ? [] : [n.tx.p95]));
  return values.length ? Math.max(...values) : null;
}

/** Host metrics under `prefix` (`target`, `generator`). */
export function recordHostMetrics(ctx: Pick<ScenarioContext, "metric">, prefix: string, h: HostSummary | null): void {
  if (!h) return;
  ctx.metric(`${prefix}.cpu.mean`, h.cpu.mean, "%");
  ctx.metric(`${prefix}.cpu.p95`, h.cpu.p95, "%");
  ctx.metric(`${prefix}.cpu.max`, h.cpu.max, "%");
  ctx.metric(`${prefix}.cpu.steal_p95`, h.steal.p95, "%");
  ctx.metric(`${prefix}.mem.used_bytes_max`, h.memUsedBytes.max, "bytes");
  ctx.metric(`${prefix}.mem.total_bytes`, h.memTotalBytes, "bytes");
  ctx.metric(`${prefix}.load1.max`, h.load1.max);
  ctx.metric(`${prefix}.nic.tx_bytes_per_second`, h.nicTotal.tx.mean, "bytes/s");
  ctx.metric(`${prefix}.nic.tx_bytes_per_second_p95`, h.nicTotal.tx.p95, "bytes/s");
  ctx.metric(`${prefix}.nic.rx_bytes_per_second`, h.nicTotal.rx.mean, "bytes/s");
  ctx.metric(`${prefix}.nic.rx_bytes_per_second_p95`, h.nicTotal.rx.p95, "bytes/s");
  ctx.metric(`${prefix}.nic.tx_bytes`, h.nicTotal.txBytes, "bytes");
  for (const [iface, n] of Object.entries(h.nic)) {
    ctx.metric(`${prefix}.nic.${iface}.tx_bytes_per_second`, n.tx.mean, "bytes/s");
    ctx.metric(`${prefix}.nic.${iface}.rx_bytes_per_second`, n.rx.mean, "bytes/s");
  }
  ctx.metric(`${prefix}.samples_incomplete`, h.incomplete ? 1 : 0);
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
  ctx.metric("heartbeat.errors", r.heartbeatErrors);
  ctx.metric("egress.total", rep.egress.totalBytes, "bytes");
  ctx.metric("egress.bytes_per_second", rep.egress.bytesPerSecond, "bytes/s");
  ctx.metric("egress.per_viewer", rep.egress.perViewerBytes, "bytes");
  for (const [source, bytes] of Object.entries(r.egressBySource)) ctx.metric(`egress.${source}`, bytes, "bytes");
  const cpuMeans = Object.values(r.cpu).map((c) => c.meanCpuPercent);
  ctx.metric("cpu.containers_mean_total", cpuMeans.length ? cpuMeans.reduce((s, v) => s + v, 0) : null, "%");
  ctx.metric("load.shards", r.shards);
  recordHostMetrics(ctx, "target", r.hosts.target);
  recordHostMetrics(ctx, "generator", r.hosts.generators[LOCAL_HOST] ?? null);
  ctx.data("load", {
    ...rep,
    breakdown: { all: r.all, browser: r.browser, http: r.http },
    cpuSummary: summarize(cpuMeans),
    target: {
      host: r.hosts.target,
      containers: { source: r.hosts.containersSource, incomplete: r.hosts.containersIncomplete, cpu: rep.cpu },
    },
    generator: { host: r.hosts.generators[LOCAL_HOST] ?? null, hosts: r.hosts.generators },
  });
}
