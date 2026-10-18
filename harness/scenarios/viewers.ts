// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N well-behaved viewers on one channel; the public (verified) viewer count must converge to
 * exactly N and never overshoot it. Parameters: `--set viewers=10 --set browserViewers=2
 * --set convergeSeconds=120`.
 */
import { defineScenario } from "../src/scenario.ts";
import { aggregateReports } from "../src/viewer.ts";
import { waitFor } from "../src/wait.ts";

export default defineScenario({
  name: "viewers",
  description: "N viewers on one channel; verified viewer count converges to N",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const p = ctx.platform;
    const total = ctx.intParam("viewers", 10);
    const browsers = Math.min(total, ctx.intParam("browserViewers", 2));
    const convergeMs = ctx.intParam("convergeSeconds", 120) * 1000;

    const streamer = await ctx.step("sign up streamer", () => p.signUp({ prefix: "viewers" }));
    const channel = streamer.me.channelSlug ?? streamer.username;
    const s = await p.streamerFor(streamer, { protocol: "rtmp", width: 854, height: 480, bitrateKbps: 1500 });
    ctx.defer(() => s.stop());
    await ctx.step("publish", () => s.start());
    await ctx.step("channel goes live", () => p.waitForLive(channel, true, 30_000));

    const viewers = await ctx.step(`open ${total} viewers`, () =>
      p.openViewers(channel, {
        chromium: Math.ceil(browsers / 2),
        webkit: Math.floor(browsers / 2),
        http: total - browsers,
      }),
    );
    for (const v of viewers) ctx.defer(() => v.stop());
    const firstFrames = await ctx.step("first frames", () =>
      Promise.allSettled(viewers.map((v) => v.waitForFirstFrame(60_000))),
    );
    const started = firstFrames.filter((r) => r.status === "fulfilled").length;
    ctx.metric("viewers.started", started);
    ctx.assert("every viewer started playback", started === total, { started, total });

    let maxSeen = 0;
    const converged = await ctx.step(`verified count converges to ${total}`, async () => {
      const t0 = Date.now();
      await waitFor(
        `viewer count ${total}`,
        async () => {
          const count = (await p.viewerCount(channel)) ?? 0;
          maxSeen = Math.max(maxSeen, count);
          return count === total;
        },
        { timeoutMs: convergeMs, intervalMs: 2_000, signal: ctx.signal },
      );
      return Date.now() - t0;
    });
    ctx.metric("viewer_count.converge", converged, "ms");
    ctx.check("count never exceeded the real audience", maxSeen <= total, { maxSeen, total });

    const reports = await ctx.step("stop viewers", () => Promise.all(viewers.map((v) => v.stop())));
    const agg = aggregateReports(reports);
    ctx.metric("ttff.p95", agg.ttff.p95, "ms");
    ctx.metric("stall.ratio", agg.stallRatio);
    ctx.check("stall ratio below 5 %", agg.stallRatio < 0.05, { stallRatio: agg.stallRatio });

    // Stale sessions drop out of the count once their heartbeats stop (30 s window).
    const decayed = await ctx
      .step("count decays after viewers leave", () =>
        waitFor("viewer count 0", async () => ((await p.viewerCount(channel)) ?? 0) === 0, {
          timeoutMs: 75_000,
          intervalMs: 3_000,
          signal: ctx.signal,
        }),
      )
      .then(() => true)
      .catch(() => false);
    ctx.check("count returns to zero after viewers leave", decayed);
  },
});
