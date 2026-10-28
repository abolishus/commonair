// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The P2P engine wrapper and its controller seam, with a fake loader (no WebRTC): the config built
 * from `PlaybackStart.p2p` and the ICE servers (no library default survives), the swarm ids, the
 * token hook, tracker refusal, ICE refresh, HTTP-only fallbacks and the byte accounting.
 */
import { P2P_INFOHASH_VECTORS } from "@commonair/contracts/p2p";
import { computeInfoHash, Core } from "p2p-media-loader-core";
import { HlsJsP2PEngine } from "p2p-media-loader-hlsjs";
import type Hls from "hls.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { withToken } from "../src/player/heartbeat.ts";
import {
  P2P_HLS_CONFIG,
  buildCoreConfig,
  renditionOf,
  streamSwarmIdBuilder,
  tokenedSegmentRequest,
} from "../src/player/p2p/config.ts";
import * as engineModule from "../src/player/p2p/engine.ts";
import {
  MAX_PEER_TOUCHED_SEGMENTS,
  MAX_TRACKER_SOCKET_ERRORS,
  PeerTouchedSegments,
  TRACKER_SOCKET_ERROR_GAP_MS,
  countingLoader,
  createP2PHls,
  type EngineCtor,
} from "../src/player/p2p/engine.ts";
import { fetchIceServers, iceRefreshDelay } from "../src/player/p2p/ice.ts";
import { P2PStats } from "../src/player/p2p/stats.ts";
import { FakeBaseLoader, FakeEngine, FakeHls, SWARM_ID, fakeApi, playbackStart } from "./p2p-fakes.ts";

vi.mock("hls.js", () => ({ default: FakeHls }));

const { PlayerController } = await import("../src/player/controller.ts");

const TRACKERS = ["wss://play.example/tracker?t=tok-1"];
const ICE: RTCIceServer[] = [
  { urls: ["stun:play.example:3478"] },
  { urls: ["turn:play.example:3478"], username: "1700000000:abc", credential: "c3VwZXI=" },
];
const SEG = "https://play.example/hls/live/rivertide/seg7.mp4?t=tok";
const SEG2 = "https://play.example/hls/live/rivertide/seg8.mp4?t=tok";
const hooks = (iceServers: RTCIceServer[]) => ({
  iceServers,
  validateP2PSegment: async () => true,
  validateHTTPSegment: async () => true,
  httpRequestSetup: async () => null,
});

beforeEach(() => {
  FakeHls.instances = [];
  FakeEngine.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("core config", () => {
  it("is built from PlaybackStart.p2p and the ICE servers", () => {
    const config = buildCoreConfig({ trackerUrls: TRACKERS, swarmId: SWARM_ID }, hooks(ICE));
    expect(config).toMatchObject({
      swarmId: SWARM_ID,
      announceTrackers: TRACKERS,
      rtcConfig: { iceServers: ICE },
      highDemandTimeWindow: 2,
      httpDownloadTimeWindow: 3,
      p2pDownloadTimeWindow: 4,
    });
    expect(config.streamSwarmIdBuilder).toBe(streamSwarmIdBuilder);
  });

  it.each([
    ["STUN and TURN", ICE],
    ["an empty list (host candidates only)", []],
  ])("no default tracker or STUN server survives in the real engine: %s", (_name, iceServers) => {
    const engine = new HlsJsP2PEngine({
      core: buildCoreConfig({ trackerUrls: TRACKERS, swarmId: SWARM_ID }, hooks(iceServers)),
    });
    const { core } = engine.getConfig();
    for (const stream of [core.mainStream, core.secondaryStream]) {
      expect(stream.announceTrackers).toEqual(TRACKERS);
      expect(stream.rtcConfig).toEqual({ iceServers });
      expect(stream.swarmId).toBe(SWARM_ID);
    }
    // The library's defaults really are public trackers and STUN, so the check above means something.
    expect(Core.DEFAULT_STREAM_CONFIG.announceTrackers.length).toBeGreaterThan(0);
    expect(Core.DEFAULT_STREAM_CONFIG.rtcConfig.iceServers?.length).toBeGreaterThan(0);
  });

  it("an empty tracker list stays empty too", () => {
    const engine = new HlsJsP2PEngine({ core: buildCoreConfig({ trackerUrls: [], swarmId: SWARM_ID }, hooks([])) });
    expect(engine.getConfig().core.mainStream.announceTrackers).toEqual([]);
  });

  it("refreshed ICE servers replace the old ones at runtime", () => {
    const engine = new HlsJsP2PEngine({
      core: buildCoreConfig({ trackerUrls: TRACKERS, swarmId: SWARM_ID }, hooks(ICE)),
    });
    const fresh = [{ urls: ["turn:play.example:3478"], username: "1700003600:abc", credential: "bmV3" }];
    engine.applyDynamicConfig({ core: { rtcConfig: { iceServers: fresh } } });
    expect(engine.getConfig().core.mainStream.rtcConfig).toEqual({ iceServers: fresh });
  });
});

describe("stream swarm ids", () => {
  const base = "https://play.example/hls/live/rivertide";
  const cases = (swarmId: string) =>
    [
      { runtimeId: `${base}/video1_stream.m3u8?t=x`, streamType: "main" as const, rendition: "source" },
      { runtimeId: `${base}/1080p/video1_stream.m3u8?t=x`, streamType: "main" as const, rendition: "1080p" },
      { runtimeId: `${base}/720p/video1_stream.m3u8?t=x`, streamType: "main" as const, rendition: "720p" },
      { runtimeId: `${base}/480p/video1_stream.m3u8?t=x`, streamType: "main" as const, rendition: "480p" },
      { runtimeId: `${base}/audio/audio1_stream.m3u8?t=x`, streamType: "main" as const, rendition: "audio" },
      { runtimeId: `${base}/audio2_stream.m3u8?t=x`, streamType: "secondary" as const, rendition: "source" },
      { runtimeId: `${base}/1080p/audio2_stream.m3u8?t=x`, streamType: "secondary" as const, rendition: "1080p" },
      { runtimeId: `${base}/720p/audio2_stream.m3u8?t=x`, streamType: "secondary" as const, rendition: "720p" },
      { runtimeId: `${base}/480p/audio2_stream.m3u8?t=x`, streamType: "secondary" as const, rendition: "480p" },
      { runtimeId: `${base}/audio/audio2_stream.m3u8?t=x`, streamType: "secondary" as const, rendition: "audio" },
    ].map((c) => ({ ...c, swarmId }));

  const swarmIds = [...new Set(P2P_INFOHASH_VECTORS.map((v) => v.streamSwarmId.split(":")[1] ?? ""))];

  it("main, audio and rendition playlists give exactly the vectors' stream ids and info hashes", () => {
    expect(swarmIds).toHaveLength(2);
    const built = swarmIds.flatMap((id) => cases(id).map((c) => streamSwarmIdBuilder(c)));
    expect(built.sort()).toEqual(P2P_INFOHASH_VECTORS.map((v) => v.streamSwarmId).sort());
    for (const v of P2P_INFOHASH_VECTORS) expect(computeInfoHash(v.streamSwarmId)).toBe(v.infoHash);
  });

  it("never carries the token or the host: the same rendition from origin, relay or CDN is one swarm", () => {
    const urls = [
      "https://play.example/hls/live/rivertide/720p/video1_stream.m3u8?t=aaa",
      "https://relay-3.example.net/hls/live/rivertide/720p/video1_stream.m3u8?t=bbb",
      "https://cdn.example/cdn/live/rivertide/720p/video1_stream.m3u8?t=ccc",
    ];
    const ids = urls.map((runtimeId) => streamSwarmIdBuilder({ swarmId: SWARM_ID, runtimeId, streamType: "main" }));
    expect(new Set(ids)).toEqual(new Set([`ca1:${SWARM_ID}:main:720p`]));
  });

  it("an unknown directory or a malformed URL counts as the source", () => {
    expect(renditionOf("https://play.example/hls/live/rivertide/4k/v.m3u8")).toBe("source");
    expect(renditionOf("nonsense")).toBe("source");
  });
});

describe("token hook (httpRequestSetup)", () => {
  it("puts the current token on the loader's own segment requests, with its byte range", async () => {
    const req = tokenedSegmentRequest(
      "https://play.example/hls/live/rivertide/seg9.mp4?t=old",
      "new",
      undefined,
      { start: 100 },
      withToken,
    );
    expect(new URL(req.url).searchParams.get("t")).toBe("new");
    expect(req.headers.get("Range")).toBe("bytes=100-");
    const ranged = tokenedSegmentRequest(
      "https://p.example/hls/live/abc/s.mp4?t=o",
      "n",
      undefined,
      { start: 0, end: 9 },
      withToken,
    );
    expect(ranged.headers.get("Range")).toBe("bytes=0-9");
  });

  it("is wired into the engine config with the token current at request time", async () => {
    let token = "first";
    createP2PHls(wrapperOptions({ token: () => token }));
    const setup = FakeEngine.instances[0]?.config.core.httpRequestSetup as (
      u: string,
      r: undefined,
      s: AbortSignal | undefined,
      rr: undefined,
    ) => Promise<Request>;
    token = "refreshed";
    const req = await setup(
      "https://play.example/hls/live/rivertide/seg1.mp4?t=stale",
      undefined,
      undefined,
      undefined,
    );
    expect(new URL(req.url).searchParams.get("t")).toBe("refreshed");
    expect(req.headers.get("Range")).toBeNull();
  });
});

function wrapperOptions(over: Partial<Parameters<typeof createP2PHls>[0]> = {}) {
  return {
    Hls: FakeHls as unknown as typeof Hls,
    hlsConfig: { ...P2P_HLS_CONFIG },
    p2p: { trackerUrls: TRACKERS, swarmId: SWARM_ID },
    iceServers: ICE,
    validateP2PSegment: async () => true,
    token: () => "tok",
    stats: new P2PStats(),
    onHlsHttpBytes: vi.fn<() => void>(),
    onChange: vi.fn<() => void>(),
    Engine: FakeEngine as unknown as EngineCtor,
    ...over,
  };
}

describe("createP2PHls", () => {
  it("plugs the loader into hls.js and hls.js into the loader", () => {
    const p = createP2PHls(wrapperOptions());
    const hls = FakeHls.instances[0];
    const engine = FakeEngine.instances[0];
    expect(hls?.config).toMatchObject({
      fLoader: "FakeFragmentLoader",
      pLoader: "FakePlaylistLoader",
      lowLatencyMode: false,
    });
    expect(engine?.bound).toBe(hls);
    expect(engine?.config.core.announceTrackers).toEqual(TRACKERS);
    expect(engine?.config.core.rtcConfig).toEqual({ iceServers: ICE });
    expect(p.running).toBe(true);
  });

  it("counts peers, P2P bytes, HTTP segment bytes and uploads from the loader's events", () => {
    const opts = wrapperOptions();
    createP2PHls(opts);
    const engine = FakeEngine.instances[0] as FakeEngine;
    engine.emit("onPeerConnect", { peerId: "p1", infoHash: "h1" });
    engine.emit("onPeerConnect", { peerId: "p2", infoHash: "h1" });
    engine.emit("onPeerClose", { peerId: "p1", infoHash: "h1" });
    engine.emit("onChunkDownloaded", 500, "http", undefined);
    engine.emit("onChunkDownloaded", 700, "p2p", "p2");
    engine.emit("onSegmentLoaded", { segment: { url: SEG }, downloadSource: "p2p", bytesLength: 700 });
    engine.emit("onSegmentLoaded", { segment: { url: SEG2 }, downloadSource: "http", bytesLength: 500 });
    engine.emit("onChunkUploaded", 300, "p2");
    expect(opts.stats).toMatchObject({ httpSegmentBytes: 500, p2pBytes: 700, uploadedBytes: 300 });
    expect(opts.stats.peerCount).toBe(1);
    expect(opts.onChange).toHaveBeenCalledTimes(3);
  });

  it("counts hls.js's own requests at its loader", () => {
    const opts = wrapperOptions();
    createP2PHls(opts);
    FakeBaseLoader.bytes = 1234;
    FakeHls.instances[0]?.loadThroughLoader();
    expect(opts.onHlsHttpBytes).toHaveBeenCalledWith(1234);
  });

  it("a tracker refusal turns P2P off for the session, silently", () => {
    const opts = wrapperOptions();
    const p = createP2PHls(opts);
    const engine = FakeEngine.instances[0] as FakeEngine;
    engine.emit("onPeerConnect", { peerId: "p1", infoHash: "h1" });
    engine.emit("onTrackerError", { error: { type: "tracker-response", message: "info_hash not allowed" } });
    expect(p.running).toBe(false);
    expect(engine.dynamic).toContainEqual({ isP2PDisabled: true, isP2PUploadDisabled: true });
    expect(opts.stats.peerCount).toBe(0);
    // Peers that would connect afterwards are not counted.
    engine.emit("onPeerConnect", { peerId: "p2", infoHash: "h1" });
    expect(opts.stats.peerCount).toBe(0);
  });

  it("other tracker errors do not stop P2P", () => {
    const p = createP2PHls(wrapperOptions());
    FakeEngine.instances[0]?.emit("onTrackerError", { error: { type: "announce-failed" } });
    expect(p.running).toBe(true);
  });

  it("repeated tracker socket failures (403 without a grant) turn P2P off", () => {
    const p = createP2PHls(wrapperOptions());
    const hls = FakeHls.instances[0] as FakeHls;
    const engine = FakeEngine.instances[0] as FakeEngine;
    hls.emit(FakeHls.Events.MANIFEST_LOADED, {});
    hls.emit(FakeHls.Events.MANIFEST_LOADED, {});
    expect(engine.core.webTorrentSocketPool.listeners).toHaveLength(1);
    for (let i = 1; i < MAX_TRACKER_SOCKET_ERRORS; i++) engine.core.webTorrentSocketPool.fail();
    expect(p.running).toBe(true);
    engine.core.webTorrentSocketPool.fail();
    expect(p.running).toBe(false);
  });

  it("only a streak of socket failures counts: far apart, after a working socket or a new manifest, it starts over", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = createP2PHls(wrapperOptions());
    const hls = FakeHls.instances[0] as FakeHls;
    const engine = FakeEngine.instances[0] as FakeEngine;
    const pool = engine.core.webTorrentSocketPool;
    hls.emit(FakeHls.Events.MANIFEST_LOADED, {});
    const almost = () => {
      for (let i = 1; i < MAX_TRACKER_SOCKET_ERRORS; i++) pool.fail();
    };
    // Wi-Fi drops hours apart.
    for (let i = 0; i < MAX_TRACKER_SOCKET_ERRORS * 2; i++) {
      pool.fail();
      vi.advanceTimersByTime(TRACKER_SOCKET_ERROR_GAP_MS + 1);
    }
    expect(p.running).toBe(true);
    const resets: (() => void)[] = [
      () => engine.emit("onPeerConnect", { peerId: "p1", infoHash: "h1" }),
      () => engine.emit("onTrackerWarning", { warning: "slow down" }),
      () => hls.emit(FakeHls.Events.MANIFEST_LOADING, {}),
    ];
    for (const reset of resets) {
      reset();
      almost();
      reset();
      almost();
      expect(p.running).toBe(true);
    }
    pool.fail();
    expect(p.running).toBe(false);
  });

  it("disable stops P2P at runtime without reloading; destroy takes the engine down before hls.js", () => {
    const p = createP2PHls(wrapperOptions());
    const hls = FakeHls.instances[0] as FakeHls;
    const engine = FakeEngine.instances[0] as FakeEngine;
    p.disable();
    expect(engine.dynamic).toEqual([{ isP2PDisabled: true, isP2PUploadDisabled: true }]);
    expect(hls.loadSource).not.toHaveBeenCalled();
    let engineDownFirst = false;
    hls.destroy.mockImplementation(() => {
      engineDownFirst = engine.destroyed;
    });
    p.destroy();
    expect(engineDownFirst).toBe(true);
  });

  it("applies fresh ICE servers at runtime", () => {
    const p = createP2PHls(wrapperOptions());
    p.applyIceServers([{ urls: ["stun:other:3478"] }]);
    expect(FakeEngine.instances[0]?.dynamic).toEqual([{ rtcConfig: { iceServers: [{ urls: ["stun:other:3478"] }] } }]);
  });
});

describe("segments a peer started and HTTP finished (validateHTTPSegment)", () => {
  type Validate = (url: string, range: unknown, data: ArrayBuffer) => Promise<boolean>;
  type Setup = (
    u: string,
    r: unknown,
    s: AbortSignal | undefined,
    rr: { start: number } | undefined,
  ) => Promise<Request>;
  const bytes = (n: number) => new Uint8Array(n).buffer;

  function setup(valid: (data: ArrayBuffer) => boolean | Promise<boolean>) {
    const validateP2PSegment = vi.fn<Validate>(async (_u, _r, data) => valid(data));
    const opts = wrapperOptions({ validateP2PSegment });
    createP2PHls(opts);
    const engine = FakeEngine.instances[0] as FakeEngine;
    const core = engine.config.core;
    return {
      opts,
      engine,
      validateP2PSegment,
      validateHTTP: core.validateHTTPSegment as Validate,
      httpSetup: core.httpRequestSetup as Setup,
    };
  }

  it("a pure HTTP segment is not checked (no digest request)", async () => {
    const { validateHTTP, validateP2PSegment } = setup(() => false);
    await expect(validateHTTP(SEG, undefined, bytes(10))).resolves.toBe(true);
    expect(validateP2PSegment).not.toHaveBeenCalled();
  });

  it("a peer's partial bytes finished over HTTP are checked against the digest; a tampered prefix is rejected", async () => {
    const tampered = new Uint8Array([6, 6, 6]);
    const { engine, validateHTTP, httpSetup, validateP2PSegment, opts } = setup(
      (data) => new Uint8Array(data)[0] !== 6,
    );
    // The peer sends a tampered prefix, then stalls; the core resumes over HTTP from byte 3.
    engine.emit("onSegmentStart", { segment: { url: SEG }, downloadSource: "p2p", peerId: "evil" });
    engine.emit("onChunkDownloaded", 3, "p2p", "evil");
    engine.emit("onSegmentError", {
      segment: { url: SEG },
      downloadSource: "p2p",
      error: { type: "bytes-receiving-timeout" },
    });
    engine.emit("onSegmentStart", { segment: { url: SEG }, downloadSource: "http" });
    const req = await httpSetup(SEG, undefined, undefined, { start: 3 });
    expect(req.headers.get("Range")).toBe("bytes=3-");
    const joined = new Uint8Array(10);
    joined.set(tampered);
    await expect(validateHTTP(SEG, undefined, joined.buffer)).resolves.toBe(false);
    expect(validateP2PSegment).toHaveBeenCalledWith(SEG, undefined, joined.buffer);
    // The core drops every byte and fetches again from 0 over HTTP: not checked again.
    await expect(validateHTTP(SEG, undefined, bytes(10))).resolves.toBe(true);
    expect(validateP2PSegment).toHaveBeenCalledTimes(1);
    engine.emit("onSegmentLoaded", { segment: { url: SEG }, downloadSource: "http", bytesLength: 10 });
    expect(opts.stats.p2pBytes).toBe(0);
  });

  it("an honest prefix passes, and its bytes count as P2P (the HTTP rest is counted by chunk)", async () => {
    const { engine, validateHTTP, httpSetup, opts } = setup(() => true);
    engine.emit("onSegmentStart", { segment: { url: SEG }, downloadSource: "p2p", peerId: "p" });
    engine.emit("onSegmentAbort", { segment: { url: SEG }, downloadSource: "p2p" });
    await httpSetup(SEG, undefined, undefined, { start: 4_000 });
    engine.emit("onChunkDownloaded", 6_000, "http", undefined);
    await expect(validateHTTP(SEG, undefined, bytes(10_000))).resolves.toBe(true);
    engine.emit("onSegmentLoaded", { segment: { url: SEG }, downloadSource: "http", bytesLength: 10_000 });
    expect(opts.stats).toMatchObject({ p2pBytes: 4_000, httpSegmentBytes: 6_000 });
    // Loaded: forgotten, the next HTTP load of that URL is not checked.
    await expect(validateHTTP(SEG, undefined, bytes(1))).resolves.toBe(true);
  });

  it("all bytes from a peer that stalled before saying done: HTTP completes them with no request, still checked", async () => {
    const { engine, validateHTTP, validateP2PSegment, opts } = setup(() => true);
    engine.emit("onSegmentStart", { segment: { url: SEG }, downloadSource: "p2p", peerId: "p" });
    await expect(validateHTTP(SEG, undefined, bytes(8_000))).resolves.toBe(true);
    expect(validateP2PSegment).toHaveBeenCalledTimes(1);
    engine.emit("onSegmentLoaded", { segment: { url: SEG }, downloadSource: "http", bytesLength: 8_000 });
    expect(opts.stats.p2pBytes).toBe(8_000);
  });

  it("a digest check that throws rejects the segment", async () => {
    const { engine, validateHTTP } = setup(() => Promise.reject(new Error("offline")));
    engine.emit("onSegmentStart", { segment: { url: SEG }, downloadSource: "p2p", peerId: "p" });
    await expect(validateHTTP(SEG, undefined, bytes(5))).rejects.toThrow("offline");
    // (The core treats a throw as false.) The refetch from 0 is plain HTTP.
    await expect(validateHTTP(SEG, undefined, bytes(5))).resolves.toBe(true);
  });

  it("a segment the peer delivered whole is counted once, as P2P", () => {
    const { engine, opts } = setup(() => true);
    engine.emit("onSegmentStart", { segment: { url: SEG }, downloadSource: "p2p", peerId: "p" });
    engine.emit("onSegmentLoaded", { segment: { url: SEG }, downloadSource: "p2p", bytesLength: 900 });
    expect(opts.stats.p2pBytes).toBe(900);
  });

  it("is bounded: the oldest peer-touched segment is forgotten first", () => {
    const t = new PeerTouchedSegments();
    for (let i = 0; i <= MAX_PEER_TOUCHED_SEGMENTS; i++) t.peerStarted(`u${i}`);
    expect(t.has("u0")).toBe(false);
    expect(t.has("u1")).toBe(true);
    expect(t.has(`u${MAX_PEER_TOUCHED_SEGMENTS}`)).toBe(true);
    // A new peer attempt refreshes a segment's place.
    t.peerStarted("u1");
    t.peerStarted("extra");
    expect(t.has("u1")).toBe(true);
    expect(t.has("u2")).toBe(false);
  });

  it("the first HTTP resume after a peer marks the peer's share; a later one (after truncated HTTP) does not", () => {
    const t = new PeerTouchedSegments();
    t.peerStarted("u");
    t.httpResumed("u", 300);
    t.httpResumed("u", 700);
    t.checked("u", true, 1_000);
    expect(t.loaded("u", "http")).toBe(300);
  });
});

describe("countingLoader", () => {
  it("counts completed requests and passes them on", () => {
    const onBytes = vi.fn<() => void>();
    const onSuccess = vi.fn<() => void>();
    const Counting = countingLoader(FakeBaseLoader as never, onBytes);
    FakeBaseLoader.bytes = 77;
    new Counting({} as never).load({} as never, {} as never, { onSuccess } as never);
    expect(onBytes).toHaveBeenCalledWith(77);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("ICE servers", () => {
  it("maps the answer and drops absent credentials", async () => {
    const client = {
      p2p: {
        iceServers: vi.fn<() => Promise<unknown>>(async () => ({
          iceServers: [{ urls: ["stun:a:3478"] }, { urls: ["turn:a:3478"], username: "u", credential: "c" }],
          expiresAt: "2026-10-27T12:00:00.000Z",
        })),
      },
    };
    const ice = await fetchIceServers(client as never, { sessionId: "s", token: "t" });
    expect(ice).toEqual({
      iceServers: [{ urls: ["stun:a:3478"] }, { urls: ["turn:a:3478"], username: "u", credential: "c" }],
      expiresAt: Date.parse("2026-10-27T12:00:00.000Z"),
    });
  });

  it("any refusal or network error means no P2P", async () => {
    const client = {
      p2p: { iceServers: vi.fn<() => Promise<unknown>>(async () => Promise.reject(new Error("PRECONDITION_FAILED"))) },
    };
    expect(await fetchIceServers(client as never, { sessionId: "s", token: "t" })).toBeNull();
  });

  it("refreshes at about 80 % of the lifetime, never sooner than 5 s, never for STUN only", () => {
    expect(iceRefreshDelay(null)).toBeNull();
    expect(iceRefreshDelay(1_000_000 + 3_600_000, 1_000_000)).toBe(2_880_000);
    expect(iceRefreshDelay(1_000_000 + 1_000, 1_000_000)).toBe(5_000);
  });
});

/** The controller seam with the fake hls.js and engine. */
describe("PlayerController with P2P", () => {
  const loadP2PEngine = async () => ({
    ...engineModule,
    createP2PHls: (o: Parameters<typeof createP2PHls>[0]) =>
      createP2PHls({ ...o, Engine: FakeEngine as unknown as EngineCtor }),
  });

  function controller(f: ReturnType<typeof fakeApi>, wanted = true, onP2P = vi.fn<() => void>()) {
    const video = document.createElement("video");
    const c = new PlayerController({
      channel: "rivertide",
      video,
      api: f.api,
      onState: () => undefined,
      p2pWanted: () => wanted,
      onP2P,
      loadP2PEngine,
    });
    return { c, onP2P, video };
  }

  it("asks for P2P only when the policy says so", async () => {
    const f = fakeApi(playbackStart({ enabled: false }));
    const { c } = controller(f, false);
    await c.start();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ p2pCapable: false, nativeHls: false });
    await c.stop();
    const g = fakeApi(playbackStart());
    const { c: d } = controller(g, true);
    await d.start();
    expect(g.start.mock.calls[0]?.[0]).toMatchObject({ p2pCapable: true });
    await d.stop();
  });

  it("enabled: false means no ICE request, no engine, plain low-latency hls.js, data-p2p off", async () => {
    const f = fakeApi(playbackStart({ enabled: false, available: true }));
    const { c } = controller(f, true);
    await c.start();
    expect(f.iceServers).not.toHaveBeenCalled();
    expect(FakeEngine.instances).toHaveLength(0);
    expect(FakeHls.instances[0]?.config).toMatchObject({ lowLatencyMode: true, liveSyncDurationCount: 3 });
    expect(c.p2pStatus()).toMatchObject({ available: true, state: "off" });
    await c.stop();
  });

  it("an ICE failure falls back to plain hls.js", async () => {
    const f = fakeApi(playbackStart(), async () => Promise.reject(new Error("PRECONDITION_FAILED")));
    const { c } = controller(f);
    await c.start();
    expect(f.iceServers).toHaveBeenCalledWith({ sessionId: "019a0000-0000-7000-8000-0000000000f1", token: "tok-1" });
    expect(FakeEngine.instances).toHaveLength(0);
    expect(FakeHls.instances[0]?.config).toMatchObject({ lowLatencyMode: true });
    expect(c.p2pStatus().state).toBe("off");
    await c.stop();
  });

  it("a granted session runs the loader with the ICE answer and reports on, then sharing", async () => {
    const f = fakeApi(playbackStart());
    const { c, onP2P } = controller(f);
    await c.start();
    const engine = FakeEngine.instances[0] as FakeEngine;
    expect(engine.config.core.rtcConfig).toEqual({ iceServers: [{ urls: ["stun:play.example:3478"] }] });
    expect(engine.config.core.announceTrackers).toEqual(["wss://play.example/tracker?t=tok-1"]);
    expect(FakeHls.instances[0]?.config).toMatchObject(P2P_HLS_CONFIG);
    expect(FakeHls.instances[0]?.config).not.toHaveProperty("liveSyncDurationCount");
    expect(c.p2pStatus().state).toBe("on");
    engine.emit("onPeerConnect", { peerId: "p", infoHash: "h" });
    expect(onP2P).toHaveBeenLastCalledWith(expect.objectContaining({ state: "sharing", peers: 1 }));
    // A tracker refusal later: HTTP carries on, the player says on (not sharing).
    engine.emit("onTrackerError", { error: { type: "tracker-response" } });
    expect(c.p2pStatus()).toMatchObject({ state: "on", peers: 0 });
    await c.stop();
  });

  it("turning P2P off stops the loader at once, no reload, and the status says off", async () => {
    const f = fakeApi(playbackStart());
    const { c } = controller(f);
    await c.start();
    const engine = FakeEngine.instances[0] as FakeEngine;
    engine.emit("onPeerConnect", { peerId: "p", infoHash: "h" });
    c.disableP2P();
    expect(engine.dynamic).toContainEqual({ isP2PDisabled: true, isP2PUploadDisabled: true });
    expect(FakeHls.instances[0]?.loadSource).toHaveBeenCalledTimes(1);
    expect(c.p2pStatus()).toMatchObject({ state: "off", peers: 0, available: true });
    await c.stop();
  });

  it("stop destroys the loader before playback.end", async () => {
    const f = fakeApi(playbackStart());
    const { c } = controller(f);
    await c.start();
    const engine = FakeEngine.instances[0] as FakeEngine;
    f.end.mockImplementation(async () => {
      f.calls.push(engine.destroyed ? "end after destroy" : "end before destroy");
      return { ok: true };
    });
    await c.stop();
    expect(f.calls).toContain("end after destroy");
  });

  it("refreshes TURN credentials at ~80 % of their lifetime and applies them at runtime", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-27T10:00:00.000Z"));
    let n = 0;
    const f = fakeApi(playbackStart(), async () => {
      n += 1;
      return {
        iceServers: [{ urls: ["turn:play.example:3478"], username: `u${n}`, credential: "c" }],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    });
    const { c } = controller(f);
    await c.start();
    const engine = FakeEngine.instances[0] as FakeEngine;
    await vi.advanceTimersByTimeAsync(2_879_000);
    expect(f.iceServers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.iceServers).toHaveBeenCalledTimes(2);
    expect(engine.dynamic).toContainEqual({
      rtcConfig: { iceServers: [{ urls: ["turn:play.example:3478"], username: "u2", credential: "c" }] },
    });
    await c.stop();
  });

  it("no TURN refresh once the engine stopped itself after a tracker refusal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-27T10:00:00.000Z"));
    const f = fakeApi(playbackStart(), async () => ({
      iceServers: [{ urls: ["turn:play.example:3478"], username: "u", credential: "c" }],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    const { c } = controller(f);
    await c.start();
    FakeEngine.instances[0]?.emit("onTrackerError", { error: { type: "tracker-response" } });
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(f.iceServers).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it("switchTo keeps the swarm: same engine, new source on the same hls.js", async () => {
    const f = fakeApi(playbackStart());
    f.heartbeat.mockImplementation(async () => ({
      switchTo: "https://play.example/hls/live/rivertide/index.m3u8?t=t2",
      token: "t2",
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { c } = controller(f);
    await c.start();
    await vi.advanceTimersByTimeAsync(700_000);
    expect(FakeHls.instances).toHaveLength(1);
    expect(FakeEngine.instances).toHaveLength(1);
    expect(FakeHls.instances[0]?.loadSource).toHaveBeenLastCalledWith(
      "https://play.example/hls/live/rivertide/index.m3u8?t=t2",
    );
    expect(FakeEngine.instances[0]?.destroyed).toBe(false);
    await c.stop();
  });

  it("P2P sessions report HTTP bytes from hls.js's loader, never FRAG_LOADED of peer-delivered segments", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fakeApi(playbackStart());
    const { c } = controller(f);
    await c.start();
    const hls = FakeHls.instances[0] as FakeHls;
    const engine = FakeEngine.instances[0] as FakeEngine;
    FakeBaseLoader.bytes = 400; // a playlist through hls.js's own loader
    hls.loadThroughLoader();
    engine.emit("onSegmentLoaded", { segment: { url: SEG }, downloadSource: "p2p", bytesLength: 9_000 });
    hls.emit(FakeHls.Events.FRAG_LOADED, { frag: { stats: { loaded: 9_000 } } });
    engine.emit("onChunkDownloaded", 5_000, "http", undefined);
    engine.emit("onChunkUploaded", 2_500, "p");
    engine.emit("onPeerConnect", { peerId: "p", infoHash: "h" });
    await vi.advanceTimersByTimeAsync(700_000);
    expect(f.heartbeat.mock.calls[0]?.[0]).toMatchObject({
      bytesHttp: 5_400,
      bytesP2p: 9_000,
      bytesP2pUp: 2_500,
      p2pPeers: 1,
      p2pRejected: 0,
    });
    await c.stop();
  });

  it("sessions without P2P keep today's accounting and send no P2P diagnostics", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fakeApi(playbackStart({ enabled: false }));
    const { c } = controller(f, false);
    await c.start();
    const hls = FakeHls.instances[0] as FakeHls;
    hls.emit(FakeHls.Events.FRAG_LOADED, { frag: { stats: { loaded: 1_000 } } });
    hls.emit(FakeHls.Events.LEVEL_LOADED, { stats: { loaded: 200 } });
    await vi.advanceTimersByTimeAsync(700_000);
    const beat = f.heartbeat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(beat).toMatchObject({ bytesHttp: 1_200, bytesP2p: 0 });
    for (const k of ["bytesP2pUp", "p2pPeers", "p2pRejected"]) expect(beat).not.toHaveProperty(k);
    await c.stop();
  });
});
