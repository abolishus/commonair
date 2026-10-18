// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Load test: N streamers × M viewers for a duration. Viewers are mostly HTTP-only (cheap) with a
 * slice of real browsers for true glass-to-glass latency. Reports origin egress by delivery
 * source (Prometheus when available, viewer-reported bytes otherwise), container CPU (podman
 * stats), p95 glass-to-glass and TTFF, and stall rate.
 */
import { ORIGIN_EGRESS_QUERY, CpuSampler, Prometheus, summarize } from "./metrics.ts";
import type { ScenarioContext } from "./scenario.ts";
import type { Streamer } from "./streamer.ts";
import type { SignedInUser } from "./users.ts";
import { type Viewer, type ViewerAggregate, type ViewerReport, aggregateReports } from "./viewer.ts";

export interface LoadOptions {
  streamers: number;
  viewers: number;
  durationMs: number;
  /** Browser viewers among `viewers` (default: 10 %, at most 20). Split between Chromium and WebKit. */
  browserViewers?: number;
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

export interface LoadResult {
  streamers: number;
  viewers: number;
  durationMs: number;
  all: ViewerAggregate;
  browser: ViewerAggregate;
  http: ViewerAggregate;
  egressBySource: Record<string, number>;
  egressMethod: "prometheus" | "viewer-reported";
  cpu: Record<string, { meanCpuPercent: number; peakCpuPercent: number; samples: number }>;
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

/** Run the load test inside a scenario context (records steps and metrics on it). */
export async function runLoad(ctx: ScenarioContext, opts: LoadOptions): Promise<LoadResult> {
  const p = ctx.platform;
  const browserViewers = opts.browserViewers ?? defaultBrowserViewers(opts.viewers);
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

  const allocation = allocateViewers(opts.streamers, opts.viewers, browserViewers);
  const viewers: Viewer[] = await ctx.step(`open ${opts.viewers} viewers`, async () => {
    const opened: Viewer[] = [];
    for (const a of allocation) {
      const channel = channels[a.channelIndex] as string;
      opened.push(
        ...(await p.openViewers(channel, { chromium: a.chromium, webkit: a.webkit, http: a.http, perPage: 5 })),
      );
    }
    for (const v of opened) ctx.defer(() => v.stop());
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
        stallRatio: Number(agg.stallRatio.toFixed(4)),
        p95LatencyMs: agg.latency.p95,
      });
    }
  });
  const windowSeconds = (Date.now() - windowStarted) / 1000;

  const reports: ViewerReport[] = await ctx.step("collect viewer reports", () =>
    Promise.all(viewers.map((v) => v.stop())),
  );
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
  if (egressMethod === "viewer-reported") {
    for (const r of reports) {
      const source = r.source ?? "direct";
      egressBySource[source] = (egressBySource[source] ?? 0) + r.bytesHttp;
      if (r.bytesP2p > 0) egressBySource.p2p = (egressBySource.p2p ?? 0) + r.bytesP2p;
    }
  }

  const result: LoadResult = {
    streamers: opts.streamers,
    viewers: opts.viewers,
    durationMs: opts.durationMs,
    all: aggregateReports(reports),
    browser: aggregateReports(reports.filter((r) => r.kind === "browser")),
    http: aggregateReports(reports.filter((r) => r.kind === "http")),
    egressBySource,
    egressMethod,
    cpu: cpu.summary(),
  };
  recordLoadMetrics(ctx, result);
  return result;
}

export function recordLoadMetrics(ctx: Pick<ScenarioContext, "metric" | "data">, r: LoadResult): void {
  ctx.metric("viewers.total", r.all.viewers);
  ctx.metric("viewers.started", r.all.started);
  ctx.metric("ttff.p95", r.all.ttff.p95, "ms");
  ctx.metric("ttff.p50", r.all.ttff.p50, "ms");
  // Browser latency is true glass-to-glass (pixels); HTTP latency is delivery latency.
  ctx.metric("glass_to_glass.p95", r.browser.latency.p95, "ms");
  ctx.metric("glass_to_glass.p50", r.browser.latency.p50, "ms");
  ctx.metric("http_delivery_latency.p95", r.http.latency.p95, "ms");
  ctx.metric("stall.ratio", r.all.stallRatio);
  ctx.metric("stall.per_minute", r.all.stallsPerMinute);
  for (const [source, bytes] of Object.entries(r.egressBySource)) ctx.metric(`egress.${source}`, bytes, "bytes");
  const cpuMeans = Object.values(r.cpu).map((c) => c.meanCpuPercent);
  ctx.metric("cpu.containers_mean_total", cpuMeans.length ? cpuMeans.reduce((s, v) => s + v, 0) : null, "%");
  ctx.data("load", { ...r, cpuSummary: summarize(cpuMeans) });
}
