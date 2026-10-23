// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Driver integration tests against a throwaway MediaMTX container: the ffmpeg streamer publishes
 * over RTMP and WHIP, the harness player plays MediaMTX's LL-HLS directly in Chromium (hls.js) and
 * WebKit (native HLS) with measured TTFF and glass-to-glass latency, and the HTTP-only viewer
 * follows the playlist and decodes the timestamp strip from segments.
 */
import { dto } from "@commonair/contracts";
import { webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createApi } from "../src/api/client.ts";
import { BrowserFleet, openBrowserViewers } from "../src/browser-viewer.ts";
import { HttpViewer } from "../src/http-viewer.ts";
import { summarize } from "../src/metrics.ts";
import { type PlayerServer, startPlayerServer } from "../src/player-server.ts";
import { Streamer } from "../src/streamer.ts";
import { type MediaMtxInstance, startMediaMtx } from "../src/testing/mediamtx.ts";
import type { Viewer } from "../src/viewer.ts";
import { waitFor } from "../src/wait.ts";

const RTMP_PATH = "live/rtmptest";
const WHIP_PATH = "live/whiptest";
const SANE_LATENCY_MS = 15_000;

let mtx: MediaMtxInstance;
let rtmp: Streamer;
let server: PlayerServer;
let fleet: BrowserFleet;
const cleanups: (() => Promise<unknown>)[] = [];
/**
 * Whether the player takes the native HLS path in each engine: its rule (prefersNativeHls in
 * apps/web) is native only where the browser can play HLS and is not Chromium. WebKit can on
 * macOS (as Safari and iOS do); Playwright's Linux WebKit has no HLS backend and correctly falls
 * back to hls.js over MSE, as Chromium always does.
 */
const nativeHls: Record<"chromium" | "webkit", boolean> = { chromium: false, webkit: false };

beforeAll(async () => {
  mtx = await startMediaMtx();
  rtmp = new Streamer({
    protocol: "rtmp",
    url: `${mtx.rtmpUrl}/${RTMP_PATH}`,
    width: 640,
    height: 360,
    fps: 30,
    bitrateKbps: 1200,
    keyframeIntervalSeconds: 1,
  });
  await rtmp.start();
  await mtx.waitForPath(RTMP_PATH);
  // The player page proxies /rpc to the API; direct mode never calls it.
  server = await startPlayerServer({ apiUrl: "http://127.0.0.1:9" });
  fleet = new BrowserFleet();
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    nativeHls.webkit = await page.evaluate(
      () => document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "",
    );
  } finally {
    await browser.close();
  }
}, 120_000);

afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => undefined);
  await fleet?.close();
  await server?.stop();
  await rtmp?.stop();
  await mtx?.stop();
}, 60_000);

async function collectLatency(viewer: Viewer, samples: number): Promise<number[]> {
  return waitFor(
    `${samples} latency samples from ${viewer.id}`,
    async () => {
      const r = await viewer.report();
      return r.latencyMs.length >= samples ? r.latencyMs : null;
    },
    { timeoutMs: 30_000, intervalMs: 500 },
  );
}

describe("RTMP streamer → MediaMTX → browser viewers", () => {
  test("the streamer reports encoder progress", () => {
    expect(rtmp.running).toBe(true);
    expect(rtmp.stats.frames).toBeGreaterThan(0);
    expect(rtmp.firstFrameAt).not.toBeNull();
  });

  for (const engine of ["chromium", "webkit"] as const) {
    test(`${engine} plays LL-HLS with sane TTFF and glass-to-glass latency`, async () => {
      const [viewer] = await openBrowserViewers({
        fleet,
        engine,
        target: { playlistUrl: mtx.hlsPlaylist(RTMP_PATH) },
        count: 1,
        server,
        probeScript: server.probeScript,
      });
      if (!viewer) throw new Error("no viewer opened");
      cleanups.push(() => viewer.stop());
      const ttff = await viewer.waitForFirstFrame(45_000);
      expect(ttff).toBeGreaterThan(0);
      expect(ttff).toBeLessThan(15_000);
      const latency = summarize(await collectLatency(viewer, 4));
      expect(latency.p50).not.toBeNull();
      expect(latency.p50 ?? -1).toBeGreaterThan(0);
      expect(latency.p50 ?? Infinity).toBeLessThan(SANE_LATENCY_MS);
      const report = await viewer.stop();
      // Native HLS where the engine has it (WebKit on macOS, as Safari/iOS), else hls.js over MSE.
      expect(report.playbackPath).toBe(nativeHls[engine] ? "native" : "mse");
      expect(report.latencyMethod).toBe("strip");
      expect(report.errors.filter((e) => !e.startsWith("hls.js"))).toEqual([]);
      // hls.js reports bytes; native HLS hides them from the page.
      expect(report.bytesHttp > 0 || nativeHls[engine]).toBe(true);
    }, 120_000);
  }

  test("several players share one page", async () => {
    const viewers = await openBrowserViewers({
      fleet,
      engine: "chromium",
      target: { playlistUrl: mtx.hlsPlaylist(RTMP_PATH) },
      count: 3,
      perPage: 3,
      server,
      probeScript: server.probeScript,
    });
    cleanups.push(() => Promise.all(viewers.map((v) => v.stop())));
    expect(viewers).toHaveLength(3);
    const ttffs = await Promise.all(viewers.map((v) => v.waitForFirstFrame(45_000)));
    for (const t of ttffs) expect(t).toBeLessThan(15_000);
    expect(new Set(viewers.map((v) => v.id)).size).toBe(3);
  }, 120_000);
});

describe("HTTP-only viewer", () => {
  test("follows the live playlist, downloads segments and decodes the strip", async () => {
    const viewer = new HttpViewer({ target: { playlistUrl: mtx.hlsPlaylist(RTMP_PATH) }, decodeStripEvery: 1 });
    cleanups.push(() => viewer.stop());
    await viewer.start();
    const ttff = await viewer.waitForFirstFrame(45_000);
    expect(ttff).toBeLessThan(15_000);
    const latency = summarize(await collectLatency(viewer, 3));
    expect(latency.p50 ?? -1).toBeGreaterThanOrEqual(0);
    expect(latency.p50 ?? Infinity).toBeLessThan(SANE_LATENCY_MS);
    const report = await viewer.stop();
    expect(report.latencyMethod).toBe("strip");
    expect(report.bytesHttp).toBeGreaterThan(10_000);
    expect(report.playedSeconds).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  }, 90_000);

  test("a playlist-only client downloads no media", async () => {
    const viewer = new HttpViewer({ target: { playlistUrl: mtx.hlsPlaylist(RTMP_PATH) }, fetchSegments: false });
    cleanups.push(() => viewer.stop());
    await viewer.start();
    await Bun.sleep(3_000);
    const report = await viewer.stop();
    expect(report.ttffMs).toBeNull();
    // Playlists only: a few KiB at most.
    expect(report.bytesHttp).toBeGreaterThan(0);
    expect(report.bytesHttp).toBeLessThan(64 * 1024);
  }, 60_000);
});

describe("WHIP streamer", () => {
  test("publishes over WebRTC and is playable over HLS", async () => {
    const whip = new Streamer({
      protocol: "whip",
      url: mtx.whipEndpoint(WHIP_PATH),
      bearer: "harness-test",
      width: 640,
      height: 360,
      bitrateKbps: 1000,
      keyframeIntervalSeconds: 1,
    });
    cleanups.push(() => whip.stop());
    await whip.start();
    await mtx.waitForPath(WHIP_PATH, 30_000);
    const viewer = new HttpViewer({ target: { playlistUrl: mtx.hlsPlaylist(WHIP_PATH) } });
    cleanups.push(() => viewer.stop());
    await viewer.start();
    await viewer.waitForFirstFrame(45_000);
    const report = await viewer.stop();
    expect(report.bytesHttp).toBeGreaterThan(10_000);
    await whip.stop();
    expect(whip.running).toBe(false);
  }, 120_000);
});

/**
 * Minimal stand-in for the API's oRPC RPC endpoint (`/rpc/playback/*`), so the real playback-
 * session flow (start → heartbeats with token refresh → end) is exercised before services/api
 * exists. Every heartbeat is validated against the contract's Heartbeat schema.
 */
function startFakeApi(playlistUrl: string) {
  const calls: { path: string; input: Record<string, unknown>; xff: string | null }[] = [];
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json().catch(() => ({}))) as { json?: Record<string, unknown> };
      const input = body.json ?? {};
      calls.push({ path, input, xff: req.headers.get("x-forwarded-for") });
      const reply = (json: unknown) => Response.json({ json });
      if (path === "/rpc/playback/start") {
        return reply({
          sessionId: crypto.randomUUID(),
          token: "tok1",
          playlistUrl,
          source: "origin",
          p2p: { enabled: false, trackerUrls: [], swarmId: "s" },
          heartbeatIntervalMs: 1_500,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          renditions: ["source"],
          captions: [],
        });
      }
      if (path === "/rpc/playback/heartbeat") {
        if (!dto.Heartbeat.safeParse(input).success) {
          return Response.json(
            { json: { defined: false, code: "BAD_REQUEST", status: 400, message: "bad heartbeat" } },
            { status: 400 },
          );
        }
        return reply({ ok: true, token: "tok2" });
      }
      if (path === "/rpc/playback/end") return reply({ ok: true });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${fake.port}`, calls, stop: () => fake.stop(true) };
}

describe("API-mode playback sessions", () => {
  for (const engine of ["chromium", "webkit"] as const) {
    test(`${engine}: harness player starts a session, heartbeats with refreshed tokens, ends it`, async () => {
      const api = startFakeApi(mtx.hlsPlaylist(RTMP_PATH));
      cleanups.push(async () => api.stop());
      const apiServer = await startPlayerServer({ apiUrl: api.url });
      cleanups.push(() => apiServer.stop());
      const [viewer] = await openBrowserViewers({
        fleet,
        engine,
        target: { channel: "harness_chan" },
        count: 1,
        server: apiServer,
        probeScript: apiServer.probeScript,
        clientIp: () => "73.10.20.30",
      });
      if (!viewer) throw new Error("no viewer");
      await viewer.waitForFirstFrame(45_000);
      const heartbeats = () => api.calls.filter((c) => c.path.endsWith("/heartbeat"));
      await waitFor("two heartbeats", () => heartbeats().length >= 2, { timeoutMs: 20_000, intervalMs: 250 });
      const report = await viewer.stop();
      await waitFor("session end", () => api.calls.some((c) => c.path.endsWith("/end")), {
        timeoutMs: 10_000,
        intervalMs: 100,
      });

      const start = api.calls.find((c) => c.path.endsWith("/start"));
      expect(start?.input).toMatchObject({
        channel: "harness_chan",
        nativeHls: nativeHls[engine],
        p2pCapable: false,
      });
      expect(String(start?.input.deviceId).length).toBeGreaterThanOrEqual(16);
      const beats = heartbeats().map((c) => c.input);
      expect(beats[0]?.token).toBe("tok1");
      expect(beats[1]?.token).toBe("tok2");
      expect(beats.some((b) => Number(b.playedSeconds) > 0)).toBe(true);
      // Well-behaved viewers do not carry automation tells.
      expect((beats[0]?.fingerprint as Record<string, unknown> | undefined)?.webdriver).toBe(false);
      expect(api.calls.find((c) => c.path.endsWith("/end"))?.input.token).toBe("tok2");
      // The player server's proxy turned the page's simulated address into x-forwarded-for.
      expect(api.calls.every((c) => c.xff === "73.10.20.30")).toBe(true);
      expect(report.heartbeats).toBeGreaterThanOrEqual(2);
      expect(report.heartbeatErrors).toBe(0);
      expect(report.source).toBe("origin");
      expect(report.sessionId).not.toBeNull();
    }, 120_000);
  }

  test("HTTP viewer runs the same session flow through the typed client", async () => {
    const api = startFakeApi(mtx.hlsPlaylist(RTMP_PATH));
    cleanups.push(async () => api.stop());
    const viewer = new HttpViewer({ target: { channel: "harness_chan" }, api: createApi({ baseUrl: api.url }).client });
    await viewer.start();
    await viewer.waitForFirstFrame(45_000);
    await waitFor("heartbeat", () => api.calls.some((c) => c.path.endsWith("/heartbeat")), {
      timeoutMs: 15_000,
      intervalMs: 200,
    });
    const report = await viewer.stop();
    expect(report.heartbeats).toBeGreaterThanOrEqual(1);
    expect(report.heartbeatErrors).toBe(0);
    const beat = api.calls.find((c) => c.path.endsWith("/heartbeat"))?.input;
    expect(Number(beat?.bytesHttp)).toBeGreaterThan(0);
    expect(api.calls.at(-1)?.path).toBe("/rpc/playback/end");
  }, 90_000);
});
