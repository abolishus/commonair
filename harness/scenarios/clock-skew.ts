// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ADR 0012 (media clock), decision 5: cross-rendition skew p95 < 100 ms and live-to-VOD skew p95
 * < 250 ms (docs/testing/w0-selectors.md). One broadcast over RTMP, then one over WHIP (which adds
 * the AAC copy and Opus over SRT), each from a strip-burning streamer with VODs on:
 *
 * 1. a sampler follows every video rendition through the origin and decodes each new segment's
 *    first frame (`e = PDT − strip`); `ladderViewers` HTTP viewers hold the channel above the
 *    transcode threshold so the ladder runs;
 * 2. mid-broadcast the recorder's ffmpeg is ended inside the media container (a recorder
 *    restart: a new run, re-anchored);
 * 3. (RTMP) the viewers leave until the ladder stops (the 120 s stop hysteresis), come back, and
 *    the ladder restarts; every rendition must be present for ≥ 2 min, including the minute after;
 * 4. after the broadcast ends, every VOD segment is decoded the same way.
 *
 * `--set assert=false` records the metrics (and data `baseline`) without asserting: the baseline
 * run against `main`. Other knobs: `ladderViewers` (above TRANSCODE_VIEWER_THRESHOLD; default 60),
 * `measureSeconds`, `afterRestartSeconds`, `protocols` (`rtmp,whip`), `mediaContainer`.
 */
import type { SignedInUser } from "../src/users.ts";
import {
  type ClockProtocol,
  type ClockSample,
  type ProtocolSkew,
  judgeCoverage,
  protocolSkew,
  skewMetrics,
} from "../src/clock-skew.ts";
import { RenditionSampler, restartRecorder, sampleVod } from "../src/clock-skew-io.ts";
import { type ScenarioContext, defineScenario } from "../src/scenario.ts";
import type { Viewer } from "../src/viewer.ts";
import { waitFor } from "../src/wait.ts";

const CROSS_RENDITION_P95_MS = 100;
const LIVE_TO_VOD_P95_MS = 250;
/** Pairing windows: about one live (LL-HLS) segment, and one 4 s VOD segment. */
const LIVE_GAP_MS = 2_000;
const VOD_GAP_MS = 4_000;
const VOD_READY_TIMEOUT_MS = 5 * 60_000;

interface Run {
  protocol: ClockProtocol;
  live: ClockSample[];
  vod: ClockSample[];
  /** Strip time of the first rung sample after the ladder restart (null: no restart). */
  restartAt: number | null;
}

export default defineScenario({
  name: "clock-skew",
  description: "cross-rendition skew < 100 ms and live-to-VOD < 250 ms (ADR 0012)",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "whip"],
  inFull: true,
  timeoutMs: 40 * 60_000,
  async run(ctx) {
    const enforce = ctx.param("assert", "true") !== "false";
    const protocols = ctx
      .param("protocols", "rtmp,whip")
      .split(",")
      .map((p) => p.trim())
      .filter((p): p is ClockProtocol => p === "rtmp" || p === "whip");
    const runs: Run[] = [];
    for (const protocol of protocols) runs.push(await broadcast(ctx, protocol));

    const results: ProtocolSkew[] = runs.map((r) => protocolSkew(r, { liveGapMs: LIVE_GAP_MS, vodGapMs: VOD_GAP_MS }));
    for (const m of skewMetrics(results)) ctx.metric(m.name, m.value, "ms");
    ctx.data("skew", results);
    const coverage = runs.map((r) => ({
      protocol: r.protocol,
      renditions: judgeCoverage(r.live, {
        minTotalMs: 120_000,
        restartAt: r.restartAt,
        afterRestartMs: 60_000,
        afterRestartFraction: 0.8,
        gapMs: 5_000,
      }),
    }));
    ctx.data("coverage", coverage);
    if (!enforce) {
      ctx.data("baseline", { results, coverage });
      return;
    }
    for (const r of results) {
      ctx.check(
        `${r.protocol}: the ladder ran (rungs sampled)`,
        r.renditions.some((x) => x !== "source"),
        r.renditions,
      );
      ctx.check(
        `${r.protocol}: cross-rendition skew p95 < ${CROSS_RENDITION_P95_MS} ms`,
        r.crossRendition.p95 !== null && r.crossRendition.p95 < CROSS_RENDITION_P95_MS,
        r.crossRendition,
      );
      ctx.check(
        `${r.protocol}: live-to-VOD skew p95 < ${LIVE_TO_VOD_P95_MS} ms`,
        r.liveToVod.p95 !== null && r.liveToVod.p95 < LIVE_TO_VOD_P95_MS,
        r.liveToVod,
      );
    }
    for (const c of coverage)
      ctx.check(
        `${c.protocol}: every rendition present ≥ 2 min${c.protocol === "rtmp" ? ", incl. the minute after the ladder restart" : ""}`,
        c.renditions.length > 1 && c.renditions.every((r) => r.ok),
        c.renditions,
      );
  },
});

async function broadcast(ctx: ScenarioContext, protocol: ClockProtocol): Promise<Run> {
  const p = ctx.platform;
  const n = ctx.intParam("ladderViewers", 60);
  const measureMs = ctx.intParam("measureSeconds", 130) * 1000;
  const afterRestartMs = ctx.intParam("afterRestartSeconds", 70) * 1000;
  const ladderRestart = protocol === "rtmp";
  const tag = protocol.toUpperCase();

  const streamer: SignedInUser = await ctx.step(`${tag}: sign up streamer`, () =>
    p.signUp({ prefix: `clk_${protocol}` }),
  );
  const channel = streamer.me.channelSlug ?? streamer.username;
  await streamer.api.client.channels.update({ channel, vodEnabled: true });
  const s = await p.streamerFor(streamer, { protocol, width: 1280, height: 720, bitrateKbps: 2500 });
  ctx.defer(() => s.stop());
  await ctx.step(`${tag}: publish`, () => s.start());
  await ctx.step(`${tag}: channel goes live`, () => p.waitForLive(channel, true, 30_000));
  const live = await p.api().client.channels.get({ channel });
  const broadcastId = live.live?.id ?? null;
  ctx.assert(`${tag}: broadcast id known`, broadcastId !== null);

  const sampler = new RenditionSampler({ api: p.api().client, channel, log: p.log });
  ctx.defer(() => sampler.stop());
  await ctx.step(`${tag}: start the rendition sampler`, () => sampler.start());

  let viewers: Viewer[] = [];
  const openViewers = async () => {
    viewers = await p.openViewers(channel, { http: n });
    for (const v of viewers) ctx.defer(() => v.stop());
  };
  const closeViewers = async () => {
    await Promise.allSettled(viewers.map((v) => v.stop()));
    viewers = [];
  };
  const ladderUp = (since: number) =>
    waitFor(`${channel} rungs sampled`, async () => sampler.renditionsSince(since).some((r) => r !== "source"), {
      timeoutMs: 5 * 60_000,
      intervalMs: 2_000,
      signal: ctx.signal,
    });

  const opened = Date.now();
  await ctx.step(`${tag}: ${n} HTTP viewers cross the transcode threshold`, openViewers);
  await ctx.step(`${tag}: the ladder starts`, () => ladderUp(opened));

  await ctx.step(`${tag}: measure ${measureMs / 1000} s with one recorder restart`, async () => {
    await Bun.sleep(measureMs / 2);
    const r = await restartRecorder(broadcastId ?? "", { container: ctx.params.mediaContainer });
    ctx.data(`${protocol}.recorderRestart`, { ...r, at: new Date().toISOString() });
    ctx.check(`${tag}: the recorder's ffmpeg was ended once`, r.signalled === 1, r);
    await Bun.sleep(measureMs / 2);
  });

  let restartAt: number | null = null;
  if (ladderRestart) {
    await ctx.step(`${tag}: viewers leave until the ladder stops`, async () => {
      await closeViewers();
      await waitFor(`${channel} ladder stopped`, async () => sampler.current.every((r) => r === "source"), {
        timeoutMs: 6 * 60_000,
        intervalMs: 2_000,
        signal: ctx.signal,
      });
    });
    const back = Date.now();
    await ctx.step(`${tag}: viewers return, the ladder restarts`, async () => {
      await openViewers();
      await ladderUp(back);
    });
    const firstAfter = sampler.samples.filter((x) => x.seenAt >= back && x.rendition !== "source");
    restartAt = firstAfter.length ? Math.min(...firstAfter.map((x) => x.stripMs)) : null;
    await ctx.step(`${tag}: measure ${afterRestartMs / 1000} s after the ladder restart`, () =>
      Bun.sleep(afterRestartMs),
    );
  }

  await ctx.step(`${tag}: stop sampling and viewing`, async () => {
    await sampler.stop();
    await closeViewers();
  });
  ctx.metric(`${protocol}.samplerErrors`, sampler.errors);
  await ctx.step(`${tag}: stop publishing`, () => s.stop());
  await ctx.step(`${tag}: channel goes offline`, () => p.waitForLive(channel, false, 30_000));

  const vod = await ctx.step(`${tag}: the VOD becomes ready`, () =>
    waitFor(
      `${channel} VOD ready`,
      async () => {
        const page = await streamer.api.client.vods.list({ channel, limit: 5 });
        const v = page.items[0];
        if (v?.status === "failed") throw new Error(`VOD failed (${v.failedReason ?? "no reason"})`);
        return v?.status === "ready" && v.playlistUrl ? v : null;
      },
      { timeoutMs: VOD_READY_TIMEOUT_MS, intervalMs: 3_000, signal: ctx.signal },
    ),
  );
  const vodSamples = await ctx.step(`${tag}: decode the VOD`, () => sampleVod(vod.playlistUrl ?? "", ctx.signal));
  ctx.metric(`${protocol}.liveSamples`, sampler.samples.length);
  ctx.metric(`${protocol}.vodSamples`, vodSamples.length);
  return {
    protocol,
    live: sampler.samples.map(({ rendition, stripMs, pdtMs }) => ({ rendition, stripMs, pdtMs })),
    vod: vodSamples,
    restartAt,
  };
}
