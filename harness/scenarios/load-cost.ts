// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stream cost (S1-i): what one live stream, one viewer and one ladder cost, each measured alone,
 * in cores per unit and attributed to containers. Fixed cells, not a pass/fail sweep: `idle` (the
 * baseline), `viewers`, `viewers-many`, `ingest`, `ingest-2x` and `ladder` (`src/load/cost.ts`
 * says what each yields). Each cell holds `seconds` (default 180) after a warm-up while the
 * target's containers are read as CPU-time and network-byte counters and the host as `/proc`; the
 * costs come from subtracting cells. Nothing on the instance under test is changed to isolate a
 * cost. A cell where the generator was the limit, or heartbeats failed, is inconclusive, as in the
 * sweep; a stream that never went live, a viewer that never played or a ladder in the wrong cell
 * fails it. Not part of `full`. Meant for a remote instance (docs/operators/capacity.md); against
 * the local stack it measures the developer machine.
 *
 *   bun harness/src/cli.ts run load-cost [--set cells=idle,ingest,ingest-2x] [--set streams=10]
 *                                        [--set viewers=40] [--set manyStreams=10] [--set seconds=180]
 *   bun harness/src/cli.ts run load-cost --set cells=idle,viewers --set fetchSegments=false
 *   bun harness/src/cli.ts run load-cost --set cells=idle,ingest --set profiles=media,worker
 *   bun harness/src/cli.ts run load-cost --set preset=smoke        # tiny cells, local stack only
 */
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { join } from "node:path";
import {
  type LoadTopology,
  type StreamerFleet,
  countLadders,
  loadTopology,
  runAudience,
  startStreamers,
} from "../src/load.ts";
import {
  type CellObservation,
  type CellPlan,
  type CellRow,
  type CostParams,
  type CostSummary,
  byService,
  cellRow,
  costInconclusiveReasons,
  judgeCell,
  parseCostParams,
  planCells,
  planNotes,
  summarizeCost,
} from "../src/load/cost.ts";
import {
  ContainerCounterSampler,
  type CounterReader,
  localCounterReader,
  remoteCounterReader,
} from "../src/load/counters.ts";
import { HostSampler } from "../src/load/host.ts";
import { LOCAL_HOST } from "../src/load/processes.ts";
import { type CollectedProfile, type ProfileDeps, collectProfiles, startProfiles } from "../src/load/profiles.ts";
import { remoteSnapshot, sshRunner } from "../src/load/ssh.ts";
import type { SourceShape } from "../src/load/sweep.ts";
import { type ScenarioContext, defineScenario } from "../src/scenario.ts";

/** Seams for the unit tests: no real `podman`, `/proc`, SSH or clock. */
export interface LoadCostDeps {
  topology?: () => LoadTopology;
  /** The counter reader for one cell (resolved again per cell, so a restart is picked up). */
  counters?: (topo: LoadTopology, prefix: string) => Promise<{ read: CounterReader; source: "cgroup" | "podman" }>;
  /** Sampling interval (5 s, like `podman stats`) and the ladder poll. */
  intervalMs?: number;
  writeProfile?: (path: string, text: string) => void;
}

const defaultCounters = async (topo: LoadTopology, prefix: string) =>
  topo.target
    ? remoteCounterReader(topo.run, topo.target, prefix)
    : { read: localCounterReader(prefix), source: "podman" as const };

/** A sleep that ends early when the scenario is aborted. */
const sleeper =
  (signal: AbortSignal) =>
  (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted || ms <= 0) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });

/** Grow the fleet with `startStreamers`, or stop its last streams until `count` are left. */
async function resizeFleet(
  ctx: ScenarioContext,
  fleet: StreamerFleet,
  count: number,
  source: SourceShape,
  topo: LoadTopology,
): Promise<StreamerFleet> {
  if (count >= fleet.channels.length) return startStreamers(ctx, count, source, topo, fleet);
  const drop = fleet.streamers.slice(count);
  const channels = fleet.channels.slice(count);
  await ctx.step(`stop ${drop.length} streamers`, async () => {
    await Promise.all(drop.map((s) => s.stop()));
    // The reconnect grace (30 s by default) keeps a broadcast open after its encoder drops.
    await Promise.all(channels.map((c) => ctx.platform.waitForLive(c, false, 120_000)));
  });
  return {
    users: fleet.users.slice(0, count),
    channels: fleet.channels.slice(0, count),
    streamers: fleet.streamers.slice(0, count),
  };
}

/** Channels that are not live (or could not be checked). */
async function offlineChannels(ctx: ScenarioContext, channels: readonly string[]): Promise<string[]> {
  const api = ctx.platform.api().client;
  const states = await Promise.all(
    channels.map(async (channel) => {
      try {
        const c = await api.channels.get({ channel });
        return c.live === null ? channel : null;
      } catch {
        return `${channel} (not checked)`;
      }
    }),
  );
  return states.filter((s): s is string => s !== null);
}

/** One cell: open its audience, warm up, measure `seconds`, collect. */
async function runCell(
  ctx: ScenarioContext,
  fleet: StreamerFleet,
  cell: CellPlan,
  p: CostParams,
  topo: LoadTopology,
  deps: LoadCostDeps,
): Promise<CellObservation> {
  const prefix = ctx.env.HARNESS_CONTAINER_PREFIX;
  const interval = deps.intervalMs ?? 5_000;
  const sleep = sleeper(ctx.signal);
  const counters = await (deps.counters ?? defaultCounters)(topo, prefix);
  const sampler = new ContainerCounterSampler(counters.read, interval);
  const host = topo.target ? new HostSampler(remoteSnapshot(topo.run, topo.target), interval) : null;
  ctx.defer(() => sampler.stop());
  if (host) ctx.defer(() => host.stop());

  const window = { start: 0, end: 0 };
  const ladders: { start: number | null; end: number | null } = { start: null, end: null };
  let offline: string[] = [];
  let measureError: string | undefined;
  const check = (): Promise<number | null> =>
    cell.streams > 0 ? countLadders(ctx, fleet.channels) : Promise.resolve(0);

  let release: () => void = () => undefined;
  const measured = new Promise<void>((resolve) => {
    release = resolve;
  });
  const measure = async () => {
    await sleep(cell.warmupSeconds * 1000);
    if (cell.expectLadder) {
      // The ladder starts 30 s after the threshold; give it until `ladderWaitSeconds` more.
      const deadline = Date.now() + cell.ladderWaitSeconds * 1000;
      while (!ctx.signal.aborted && ((await check()) ?? 0) < 1 && Date.now() < deadline) await sleep(interval);
    }
    ladders.start = await check();
    window.start = Date.now();
    sampler.start();
    host?.start();
    await sleep(cell.seconds * 1000);
    await Promise.all([sampler.stop(), host?.stop()]);
    window.end = Date.now();
    ladders.end = await check();
    offline = await offlineChannels(ctx, fleet.channels);
  };
  const maxHoldMs = (cell.warmupSeconds + cell.ladderWaitSeconds + cell.seconds + 60) * 1000;
  const result = await runAudience(
    ctx,
    fleet,
    {
      viewers: cell.viewers,
      durationMs: maxHoldMs,
      browserViewers: cell.browserViewers,
      httpPerProcess: p.httpPerProcess,
      label: `cell ${cell.name}`,
      generatorThresholds: p.generator,
      http: { heartbeats: cell.heartbeats, fetchSegments: cell.fetchSegments },
      onHoldStart: () => {
        measure()
          .catch((err: unknown) => {
            measureError = err instanceof Error ? err.message : String(err);
          })
          .finally(release);
      },
      until: measured,
    },
    topo,
  );
  await measured;
  const counted = sampler.summary();
  const hs = host?.summary() ?? null;
  const toCores = (pct: number | null) =>
    pct === null || hs?.cpus === null || hs?.cpus === undefined ? null : (pct * hs.cpus) / 100;
  return {
    plan: cell,
    windowSeconds: window.end > window.start ? (window.end - window.start) / 1000 : 0,
    viewers: {
      reports: result.all.viewers,
      sessions: result.sessions,
      started: result.all.started,
      errors: result.all.errors,
      heartbeatErrors: result.heartbeatErrors,
    },
    offline,
    laddersAtStart: ladders.start,
    laddersAtEnd: ladders.end,
    generator: result.generatorVerdict,
    counters: { failures: counted.failures, source: counters.source },
    services: byService(counted.containers, prefix),
    host: hs ? { cores: toCores(hs.cpu.mean), coresP95: toCores(hs.cpu.p95), cpus: hs.cpus } : null,
    ...(measureError ? { error: `measurement: ${measureError}` } : {}),
  };
}

function failedObservation(cell: CellPlan, err: unknown): CellObservation {
  return {
    plan: cell,
    windowSeconds: 0,
    viewers: { reports: 0, sessions: 0, started: 0, errors: 0, heartbeatErrors: 0 },
    offline: [],
    laddersAtStart: null,
    laddersAtEnd: null,
    generator: null,
    counters: { failures: 0, source: "podman" },
    services: {},
    host: null,
    error: err instanceof Error ? err.message : String(err),
  };
}

const PROFILE_COLLECT_TIMEOUT_MS = 10 * 60_000;

const round = (v: number | null, digits = 4) => (v === null ? null : Number(v.toFixed(digits)));

function recordCostMetrics(ctx: Pick<ScenarioContext, "metric">, s: CostSummary): void {
  const c = s.costs;
  ctx.metric("cost.ingest.cores_per_stream", round(c.ingestPerStream.total), "cores");
  ctx.metric("cost.ingest_2x.cores_per_stream", round(c.ingest2xPerStream.total), "cores");
  ctx.metric("cost.linearity.ratio", round(c.linearity.ratio));
  ctx.metric("cost.packaging.cores_per_stream", round(c.packagingPerStream), "cores");
  ctx.metric("cost.moderation.cores_per_stream", round(c.moderationPerStream.total), "cores");
  ctx.metric("cost.moderation_2x.cores_per_stream", round(c.moderationPerStream.totalAt2x), "cores");
  ctx.metric("cost.moderation.capture_cores_per_stream", round(c.moderationPerStream.capture), "cores");
  ctx.metric("cost.moderation.classifier_cores_per_stream", round(c.moderationPerStream.classifier), "cores");
  ctx.metric("cost.edge.cores_per_100_viewers", round(c.edgePer100Viewers.onePath), "cores");
  ctx.metric("cost.edge_many.cores_per_100_viewers", round(c.edgePer100Viewers.manyPaths), "cores");
  ctx.metric("cost.ladder.cores", round(c.ladder.allServices), "cores");
  ctx.metric("cost.ladder.media_cores", round(c.ladder.perService.media ?? null), "cores");
  ctx.metric("cost.valkey.rx_bytes_per_stream", round(c.valkeyBytesPerStream.rx, 0), "bytes/s");
  ctx.metric("cost.valkey.tx_bytes_per_stream", round(c.valkeyBytesPerStream.tx, 0), "bytes/s");
  ctx.metric("cost.cells_measured", s.cells.filter((r) => r.status === "measured").length);
  ctx.metric("cost.inconclusive", s.outcome === "inconclusive" ? 1 : 0);
}

/** The scenario over `deps` (the unit tests pass fakes). */
export function loadCostScenario(deps: LoadCostDeps = {}) {
  return defineScenario({
    name: "load-cost",
    description:
      "stream cost: cores per live stream, per viewer and per ladder, each measured alone by subtracting fixed cells, attributed to containers",
    needs: ["api", "mail", "media", "origin", "ffmpeg"],
    inFull: false,
    timeoutMs: 4 * 60 * 60_000,
    async run(ctx) {
      const topo = (deps.topology ?? (() => loadTopology()))();
      const remote = topo.target !== null;
      const p = parseCostParams(ctx.params, { remote });
      const plan = planCells(p);
      const addresses = new Set([LOCAL_HOST, ...topo.remoteGenerators]).size;
      const notes = [...p.notes, ...planNotes(plan, addresses)];
      if (!remote) {
        notes.push("no HARNESS_LOAD_TARGET_SSH: these are the developer machine's numbers, not a target's");
        ctx.log.warn("load-cost without HARNESS_LOAD_TARGET_SSH: the numbers are this machine's");
      }
      if (!p.heartbeats)
        notes.push("viewers cell without heartbeats: segments and playlists only, no playback API calls");
      if (!p.fetchSegments) notes.push("viewers cell without segments: playlists and playback API calls only");
      for (const n of notes) ctx.log.warn("load-cost note", { note: n });
      ctx.data("params", { ...p, plan, target: topo.target, generators: topo.env.HARNESS_LOAD_GENERATOR_HOSTS });

      const sleep = sleeper(ctx.signal);
      const profiling: ProfileDeps | null =
        topo.target && p.profiles.length > 0
          ? {
              run: topo.run,
              // A long run's profile can be over 100 MB: give the copy minutes, not the runner's 20 s.
              collect: deps.topology ? topo.run : sshRunner(PROFILE_COLLECT_TIMEOUT_MS),
              target: topo.target,
              sleep,
              ...(deps.writeProfile ? { write: deps.writeProfile } : {}),
              ...(deps.intervalMs ? { pollMs: deps.intervalMs } : {}),
            }
          : null;
      if (profiling) {
        await ctx.step(`restart ${p.profiles.join(", ")} under the CPU profiler`, () =>
          startProfiles(profiling, p.profiles, p.profileDir, ctx.runId),
        );
      }

      let fleet: StreamerFleet = { users: [], channels: [], streamers: [] };
      const rows: CellRow[] = [];
      for (const [i, cell] of plan.entries()) {
        if (ctx.signal.aborted) break;
        let obs: CellObservation;
        try {
          fleet = await resizeFleet(ctx, fleet, cell.streams, p.source, topo);
          obs = await runCell(ctx, fleet, cell, p, topo, deps);
        } catch (err) {
          obs = failedObservation(cell, err);
        }
        const row = cellRow(obs, judgeCell(obs, p.maxHeartbeatErrors));
        rows.push(row);
        ctx.data("cells", rows);
        ctx.log.info("cost cell", {
          cell: row.name,
          streams: row.streams,
          viewers: row.viewers,
          status: row.status,
          cores: round(row.servicesTotalCores),
          failures: row.failures,
          inconclusive: row.inconclusive,
        });
        // A failed cell leaves the fleet in an unknown state; later cells would subtract from it.
        if (row.status === "failed") break;
        if (i < plan.length - 1 && p.cooldownSeconds > 0) {
          await ctx.step(`cool down ${p.cooldownSeconds} s`, () => sleep(p.cooldownSeconds * 1000));
        }
      }

      let profiles: CollectedProfile[] = [];
      if (profiling) {
        const localDir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, "profiles", ctx.runId);
        try {
          profiles = await ctx.step("stop the profiled services and collect their profiles", () =>
            collectProfiles(profiling, p.profiles, p.profileDir, ctx.runId, localDir),
          );
          ctx.data("profiles", profiles);
        } catch (err) {
          ctx.check("CPU profiles collected", false, { error: err instanceof Error ? err.message : String(err) });
        }
        ctx.check(
          "a profile from every profiled service",
          p.profiles.every((s) => profiles.some((f) => f.service === s && f.remote.endsWith(".cpuprofile"))),
          { profiles: profiles.map((f) => f.remote) },
        );
      }

      const summary = summarizeCost(p, rows, { local: !remote, notes, profiled: profiling ? p.profiles : [] });
      ctx.data("cost", summary);
      recordCostMetrics(ctx, summary);
      ctx.log.info("cost done", {
        outcome: summary.outcome,
        ingestPerStream: round(summary.costs.ingestPerStream.total),
        moderationPerStream: round(summary.costs.moderationPerStream.total),
        edgePer100Viewers: round(summary.costs.edgePer100Viewers.onePath),
        ladder: round(summary.costs.ladder.allServices),
      });
      // A measurement, not a pass/fail: it fails only when a cell could not be measured at all.
      for (const reason of costInconclusiveReasons(summary)) ctx.inconclusive(reason);
      for (const row of rows.filter((r) => r.status === "failed")) {
        ctx.check(`cell ${row.name} measured`, false, { failures: row.failures });
      }
      ctx.check("every planned cell ran", rows.length === plan.length || ctx.signal.aborted, {
        planned: plan.map((c) => c.name),
        ran: rows.map((r) => r.name),
      });
    },
  });
}

export default loadCostScenario();
