// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A small load test (2 streamers × 5 viewers, 10 in all, for 30 s) that runs as part of `full`.
 * Same report fields as `load-plan`; every `--set` key of `src/load/params.ts` applies.
 */
import { judgeLoad, runLoad } from "../src/load.ts";
import { LOAD_SMOKE_DEFAULTS, parseLoadParams } from "../src/load/params.ts";
import { defineScenario } from "../src/scenario.ts";

export default defineScenario({
  name: "load-smoke",
  description: "load test 2 streamers × 10 viewers for 30 s (egress, CPU, p95 latency and TTFF, stalls, errors)",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const p = parseLoadParams(ctx.params, LOAD_SMOKE_DEFAULTS);
    const result = await runLoad(ctx, {
      streamers: p.streamers,
      viewers: p.viewers,
      durationMs: p.seconds * 1000,
      browserViewers: p.browserViewers,
      httpPerProcess: p.httpPerProcess,
    });
    judgeLoad(ctx, result.report);
  },
});
