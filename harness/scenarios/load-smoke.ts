// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A small load test (2 streamers × 10 viewers for 30 s) that runs as part of `full`. */
import { runLoad } from "../src/load.ts";
import { defineScenario } from "../src/scenario.ts";

export default defineScenario({
  name: "load-smoke",
  description: "load test 2 streamers × 10 viewers for 30 s (egress, CPU, p95 latency, stalls)",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const result = await runLoad(ctx, {
      streamers: ctx.intParam("streamers", 2),
      viewers: ctx.intParam("viewers", 10),
      durationMs: ctx.intParam("seconds", 30) * 1000,
      browserViewers: ctx.intParam("browserViewers", 2),
    });
    ctx.assert("every viewer started playback", result.all.started === result.all.viewers, {
      started: result.all.started,
      viewers: result.all.viewers,
    });
    ctx.check("stall ratio below 5 %", result.all.stallRatio < 0.05, { stallRatio: result.all.stallRatio });
    ctx.check("p95 TTFF under 15 s", (result.all.ttff.p95 ?? Infinity) < 15_000, result.all.ttff);
    ctx.check(
      "p95 glass-to-glass under 15 s",
      (result.browser.latency.p95 ?? Infinity) < 15_000,
      result.browser.latency,
    );
    ctx.check("no viewer errors", result.all.errors === 0, { errors: result.all.errors });
  },
});
