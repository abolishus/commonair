// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Capacity sweep (S1-a): steps the load up until one host stops coping, and records where and
 * why. Viewers axis by default (250, 500, 1000, 2000, 4000 viewers over 20 streams); the
 * streamers axis (`--set streamerSteps=1,2,4,8`) adds live streams at `ladderViewers` viewers
 * each to find the transcode limit. Streams stay up across steps; each step holds `seconds` once
 * its viewers are started, then cools down. The sweep stops at the first step that breaks a
 * target (latency, TTFF, stalls, errors, target CPU p95, target NIC) or where the generator was
 * the limit (inconclusive). Not part of `full`. Meant for a remote instance
 * (docs/operators/capacity.md); against the local stack it measures the harness machine.
 *
 *   bun harness/src/cli.ts run load-sweep [--set steps=250,500,1000] [--set streamers=20]
 *                                         [--set seconds=120] [--set cooldownSeconds=30]
 *   bun harness/src/cli.ts run load-sweep --set streamerSteps=1,2,4,8,16 [--set ladderViewers=60]
 */
import {
  type LoadResult,
  type StreamerFleet,
  busiestTxP95,
  loadTopology,
  recordHostMetrics,
  runAudience,
  startStreamers,
} from "../src/load.ts";
import { mapLimit } from "../src/load/async.ts";
import { mbpsToBytesPerSecond } from "../src/load/env.ts";
import { LOCAL_HOST } from "../src/load/processes.ts";
import {
  type SweepRow,
  hasLadder,
  parseSweepParams,
  stepShape,
  stopsSweep,
  summarizeSweep,
  sweepRow,
} from "../src/load/sweep.ts";
import { type ScenarioContext, defineScenario } from "../src/scenario.ts";

/** Streams with a transcode ladder right now, from `playback.start`'s renditions. */
async function countLadders(ctx: ScenarioContext, channels: readonly string[]): Promise<number | null> {
  const api = ctx.platform.api().client;
  const results = await mapLimit(channels, 4, async (channel) => {
    try {
      const s = await api.playback.start({
        channel,
        deviceId: crypto.randomUUID(),
        p2pCapable: false,
        nativeHls: false,
        embed: false,
      });
      await api.playback.end({ sessionId: s.sessionId, token: s.token }).catch(() => undefined);
      return hasLadder(s.renditions);
    } catch {
      return null;
    }
  });
  const known = results.filter((r): r is boolean => r !== null);
  return known.length === 0 ? null : known.filter(Boolean).length;
}

/** Highest CPU p95 over every generator host that was measured. */
function generatorCpuP95(r: LoadResult): number | null {
  const values = Object.values(r.hosts.generators).flatMap((h) => {
    const p95 = h?.cpu.p95 ?? null;
    return p95 === null ? [] : [p95];
  });
  return values.length ? Math.max(...values) : null;
}

export default defineScenario({
  name: "load-sweep",
  description:
    "capacity sweep: steps viewers (or live streams) up until latency, TTFF, stalls, errors, target CPU or NIC breaks; one row per step",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  inFull: false,
  timeoutMs: 6 * 60 * 60_000,
  async run(ctx) {
    const sp = parseSweepParams(ctx.params);
    const topo = loadTopology();
    const targetCeiling = mbpsToBytesPerSecond(topo.env.HARNESS_LOAD_TARGET_NIC_MBPS);
    ctx.data("params", { ...sp, target: topo.target, generators: topo.env.HARNESS_LOAD_GENERATOR_HOSTS });
    if (!topo.target) ctx.log.warn("load-sweep without HARNESS_LOAD_TARGET_SSH: no target host CPU or NIC");

    let fleet: StreamerFleet = { users: [], channels: [], streamers: [] };
    const rows: SweepRow[] = [];
    for (const [i, step] of sp.steps.entries()) {
      if (ctx.signal.aborted) break;
      const shape = stepShape(sp, step);
      const label = `step ${i + 1}/${sp.steps.length} (${shape.streamers} streams, ${shape.viewers} viewers)`;
      fleet = await startStreamers(ctx, shape.streamers, {}, topo, fleet);
      let ladders: number | null = null;
      const result = await runAudience(
        ctx,
        fleet,
        {
          viewers: shape.viewers,
          durationMs: sp.seconds * 1000,
          browserViewers: Math.min(sp.browserViewers, shape.viewers),
          httpPerProcess: sp.httpPerProcess,
          label,
          generatorThresholds: sp.generator,
          beforeStop: async () => {
            ladders = await countLadders(ctx, fleet.channels);
          },
        },
        topo,
      );
      const row = sweepRow(
        sp,
        step,
        shape,
        {
          ...result,
          target: {
            cpuP95: result.hosts.target?.cpu.p95 ?? null,
            busiestTxP95: busiestTxP95(result.hosts.target),
            totalTxMean: result.hosts.target?.nicTotal.tx.mean ?? null,
          },
          generatorCpuP95: generatorCpuP95(result),
          generator: result.generatorVerdict ?? { inconclusive: false, limits: [], notes: [] },
        },
        targetCeiling,
        ladders,
      );
      rows.push(row);
      ctx.data("sweep", rows);
      ctx.data(`sweep step ${i + 1}`, {
        load: result.report,
        target: result.hosts.target,
        containers: { source: result.hosts.containersSource, incomplete: result.hosts.containersIncomplete },
        generators: result.hosts.generators,
        verdict: result.generatorVerdict,
      });
      ctx.log.info("sweep step", {
        step: i + 1,
        viewers: shape.viewers,
        streams: shape.streamers,
        status: row.status,
        broke: row.breaches.map((b) => b.metric),
        ladders: row.ladders,
      });
      if (stopsSweep(row)) {
        recordHostMetrics(ctx, "first_failing.target", result.hosts.target);
        break;
      }
      recordHostMetrics(ctx, "last_passing.target", result.hosts.target);
      recordHostMetrics(ctx, "last_passing.generator", result.hosts.generators[LOCAL_HOST] ?? null);
      if (i < sp.steps.length - 1 && sp.cooldownSeconds > 0) {
        await ctx.step(`cool down ${sp.cooldownSeconds} s`, () => Bun.sleep(sp.cooldownSeconds * 1000));
      }
    }

    const summary = summarizeSweep(sp.axis, rows);
    ctx.data("sweepSummary", summary);
    ctx.metric("sweep.steps_run", summary.stepsRun);
    ctx.metric("sweep.last_passing.viewers", summary.lastPassing?.viewers);
    ctx.metric("sweep.last_passing.streams", summary.lastPassing?.streamers);
    ctx.metric("sweep.last_passing.ladders", summary.lastPassing?.ladders);
    ctx.metric("sweep.first_failing.viewers", summary.firstFailing?.viewers);
    ctx.metric("sweep.first_failing.streams", summary.firstFailing?.streamers);
    ctx.metric("sweep.per_viewer_egress", summary.perViewerEgressBytesPerSecond, "bytes/s");
    ctx.metric("sweep.per_viewer_nic_tx", summary.perViewerNicTxBytesPerSecond, "bytes/s");
    ctx.metric("sweep.last_passing.target_cpu_p95", summary.targetCpuP95, "%");
    ctx.metric("sweep.inconclusive", summary.outcome === "inconclusive" ? 1 : 0);
    ctx.log.info("sweep done", {
      outcome: summary.outcome,
      lastPassing: summary.lastPassing && {
        viewers: summary.lastPassing.viewers,
        streams: summary.lastPassing.streamers,
      },
      firstFailing: summary.firstFailing && {
        viewers: summary.firstFailing.viewers,
        streams: summary.firstFailing.streamers,
        brokeBy: summary.brokeBy,
      },
    });
    // A sweep is a measurement: finding the break is the point. It fails only when even the first
    // step broke on the target (the range is wrong, or the instance is broken).
    if (summary.outcome !== "inconclusive") {
      ctx.check("the first step met the targets", summary.lastPassing !== null, {
        firstFailing: summary.firstFailing?.step,
        brokeBy: summary.brokeBy,
      });
    }
  },
});
