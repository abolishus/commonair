// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The PLAN-size load test (ADR 0021): 20 streamers × 200 viewers for 120 s, 20 of them real
 * browsers, the HTTP audience spread over child harness processes (`--set httpPerProcess=N`,
 * default 1000). Not part of `full`: run it by hand on a machine that can sustain it.
 *
 * Against a remote instance (`HARNESS_LOAD_TARGET_SSH`, docs/operators/capacity.md) it also
 * samples the target host and its containers over SSH, and a run where the generator was the
 * limit, or where more than `maxHeartbeatErrors` (default 0) heartbeats failed, is reported as
 * inconclusive instead of passed or failed.
 *
 *   bun harness/src/cli.ts run load-plan [--set streamers=20] [--set viewersPerStreamer=200]
 *                                       [--set seconds=120] [--set browserViewers=20]
 *                                       [--set maxHeartbeatErrors=0]
 */
import { judgeLoadRun, runLoad } from "../src/load.ts";
import { LOAD_PLAN_DEFAULTS, parseLoadParams, parseMaxHeartbeatErrors } from "../src/load/params.ts";
import { defineScenario } from "../src/scenario.ts";

export default defineScenario({
  name: "load-plan",
  description:
    "PLAN-size load test 20 streamers × 200 viewers for 120 s (egress total/per viewer/by source, CPU per container, p95 latency and TTFF, stalls, errors)",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  inFull: false,
  timeoutMs: 60 * 60_000,
  async run(ctx) {
    const p = parseLoadParams(ctx.params, LOAD_PLAN_DEFAULTS);
    const maxHeartbeatErrors = parseMaxHeartbeatErrors(ctx.params);
    ctx.data("params", { ...p, maxHeartbeatErrors });
    const result = await runLoad(ctx, {
      streamers: p.streamers,
      viewers: p.viewers,
      durationMs: p.seconds * 1000,
      browserViewers: p.browserViewers,
      httpPerProcess: p.httpPerProcess,
    });
    judgeLoadRun(ctx, result, maxHeartbeatErrors);
  },
});
