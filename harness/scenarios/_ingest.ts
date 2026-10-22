// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared body of the ingest scenarios: publish → `stream.online` observable through
 * `channels.get` → playback through the origin in Chromium and WebKit with measured TTFF and
 * glass-to-glass latency → stop → offline.
 */
import { summarize } from "../src/metrics.ts";
import type { ScenarioContext } from "../src/scenario.ts";
import type { Viewer } from "../src/viewer.ts";
import { waitFor } from "../src/wait.ts";

export const MAX_TTFF_MS = 15_000;
export const MAX_GLASS_TO_GLASS_MS = 15_000;
/**
 * WHIP into WebKit: native HLS plays media's AAC copy, whose LL-HLS parts vary in length (WebRTC
 * timing), and WebKit's low-latency mode degrades on that (spec e6, "WHIP audio for WebKit").
 */
export const MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS = 20_000;

/** The glass-to-glass budget (p50) for one ingest protocol and browser engine. */
export function glassToGlassBudgetMs(protocol: "rtmp" | "whip", engine: string): number {
  return protocol === "whip" && engine === "webkit" ? MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS : MAX_GLASS_TO_GLASS_MS;
}

export async function ingestScenario(ctx: ScenarioContext, protocol: "rtmp" | "whip"): Promise<void> {
  const p = ctx.platform;
  const streamer = await ctx.step("sign up streamer", () => p.signUp({ prefix: `in_${protocol}` }));
  const channel = streamer.me.channelSlug ?? streamer.username;

  const s = await ctx.step("rotate stream key", () =>
    p.streamerFor(streamer, {
      protocol,
      width: ctx.intParam("width", 1280),
      height: ctx.intParam("height", 720),
      bitrateKbps: ctx.intParam("bitrate", 2500),
    }),
  );
  ctx.defer(() => s.stop());
  await ctx.step(`publish over ${protocol.toUpperCase()}`, () => s.start());
  const toLive = await ctx.step("channel goes live", () => p.waitForLive(channel, true, 30_000));
  ctx.metric("time_to_live", toLive, "ms");

  const live = await p.api().client.channels.get({ channel });
  ctx.check("broadcast summary present", live.live !== null);

  const viewers: Viewer[] = await ctx.step("open Chromium and WebKit viewers", () =>
    p.openViewers(channel, { chromium: 1, webkit: 1 }),
  );
  for (const v of viewers) ctx.defer(() => v.stop());

  for (const v of viewers) {
    const engine = v.id.split("-")[0] ?? v.id;
    const ttff = await ctx.step(`${engine}: first frame`, () => v.waitForFirstFrame(45_000));
    ctx.metric(`ttff.${engine}`, ttff, "ms");
    ctx.assert(`${engine}: TTFF under ${MAX_TTFF_MS} ms`, ttff < MAX_TTFF_MS, { ttff });
    const samples = await ctx.step(`${engine}: glass-to-glass samples`, () =>
      waitFor(
        `latency samples from ${v.id}`,
        async () => {
          const r = await v.report();
          return r.latencyMs.length >= 8 ? r.latencyMs : null;
        },
        { timeoutMs: 30_000, intervalMs: 500, signal: ctx.signal },
      ),
    );
    const latency = summarize(samples);
    ctx.metric(`glass_to_glass.${engine}.p50`, latency.p50, "ms");
    ctx.metric(`glass_to_glass.${engine}.p95`, latency.p95, "ms");
    const budget = glassToGlassBudgetMs(protocol, engine);
    ctx.assert(`${engine}: glass-to-glass under ${budget} ms`, (latency.p50 ?? Infinity) < budget, latency);
    const report = await v.report();
    ctx.check(`${engine}: playback path`, report.playbackPath === (engine === "webkit" ? "native" : "mse"), {
      path: report.playbackPath,
    });
    ctx.check(`${engine}: delivered by the origin`, report.source === "origin", { source: report.source });
  }

  const health = await ctx.step("stream health", () => streamer.api.client.stream.health({ channel }));
  ctx.check("health reports the ingest protocol", health.live && health.ingestProtocol === protocol, {
    live: health.live,
    ingestProtocol: health.ingestProtocol,
  });

  // Players heartbeat every ~10 s (with jitter). On a fast stack the steps above can finish first,
  // so wait for one before stopping: the check below must see heartbeats actually accepted.
  await ctx.step("a heartbeat from every viewer", () =>
    Promise.all(
      viewers.map((v) =>
        waitFor(`a heartbeat from ${v.id}`, async () => ((await v.report()).heartbeats > 0 ? true : null), {
          timeoutMs: 25_000,
          intervalMs: 500,
          signal: ctx.signal,
        }).catch(() => false),
      ),
    ),
  );
  const finals = await ctx.step("stop viewers", () => Promise.all(viewers.map((v) => v.stop())));
  for (const r of finals) {
    ctx.check(`${r.engine}: heartbeats accepted`, r.heartbeats > 0 && r.heartbeatErrors === 0, {
      heartbeats: r.heartbeats,
      errors: r.heartbeatErrors,
    });
  }

  await ctx.step("stop publishing", () => s.stop());
  const toOffline = await ctx.step("channel goes offline", () => p.waitForLive(channel, false, 30_000));
  ctx.metric("time_to_offline", toOffline, "ms");
}
