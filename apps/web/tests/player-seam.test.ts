// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The player seam (docs/testing/w1-selectors.md "Player seam") with a fake hls.js and a fake
 * native video: the playhead's PDT, seeking by wall clock, the target latency, playback mode, text
 * tracks, the diagnostic query parameters and the heartbeat's playback fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeHls, fakeApi, playbackStart } from "./p2p-fakes.ts";

class SeamHls extends FakeHls {
  static override Events = { ...FakeHls.Events, MANIFEST_PARSED: "hlsManifestParsed" };
  levels: {
    uri: string;
    details?: { fragments: { start: number; duration: number; programDateTime: number | null }[] };
  }[] = [];
  currentLevel = -1;
}

vi.mock("hls.js", () => ({ default: SeamHls }));

const { DIAGNOSTIC_LATENCY_RANGE, PlayerController, TARGET_LATENCY_RANGE, diagnosticParams, mediaTimeOfWallclock } =
  await import("../src/player/controller.ts");

const T0 = Date.parse("2026-10-30T12:00:00.000Z");

beforeEach(() => {
  FakeHls.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A started hls.js session (the fake api answers `playback.start`). */
async function hlsSession(opts: { targetLatency?: number; rendition?: string } = {}) {
  const f = fakeApi(playbackStart({ enabled: false }));
  const video = document.createElement("video");
  // hls.js wherever the element cannot play HLS itself (happy-dom: never).
  vi.spyOn(video, "canPlayType").mockReturnValue("");
  vi.spyOn(video, "play").mockResolvedValue(undefined);
  const c = new PlayerController({ channel: "rivertide", video, api: f.api, onState: () => undefined, ...opts });
  await c.start();
  const hls = FakeHls.instances[0] as SeamHls;
  return { c, f, video, hls };
}

/** A native-HLS video: `getStartDate`, `readyState`, `seekable` under the test's control. */
function nativeVideo(state: { start: number | null; readyState: number; seekable: [number, number][] }) {
  const video = document.createElement("video") as HTMLVideoElement & { getStartDate: () => Date };
  Object.defineProperty(video, "readyState", { get: () => state.readyState, configurable: true });
  video.getStartDate = () => new Date(state.start ?? Number.NaN);
  Object.defineProperty(video, "seekable", {
    get: () => ({
      length: state.seekable.length,
      start: (i: number) => state.seekable[i]?.[0] ?? 0,
      end: (i: number) => state.seekable[i]?.[1] ?? 0,
    }),
    configurable: true,
  });
  return video;
}

/** A controller on the native path without starting a session (the path decision is internal). */
function nativeController(video: HTMLVideoElement) {
  const f = fakeApi(playbackStart({ enabled: false }));
  const c = new PlayerController({ channel: "rivertide", video, api: f.api, onState: () => undefined });
  (c as unknown as { native: boolean }).native = true;
  return c;
}

describe("playheadWallclock", () => {
  it("hls.js: the PDT under the playhead (`playingDate`), as a copy", async () => {
    const { c, hls } = await hlsSession();
    hls.playingDate = new Date(T0);
    const at = c.playheadWallclock();
    expect(at?.getTime()).toBe(T0);
    at?.setTime(0);
    expect(hls.playingDate.getTime()).toBe(T0);
    await c.stop();
  });

  it("hls.js: null before the first frame or without PDT", async () => {
    const { c, hls } = await hlsSession();
    hls.playingDate = null;
    expect(c.playheadWallclock()).toBeNull();
    hls.playingDate = new Date(Number.NaN);
    expect(c.playheadWallclock()).toBeNull();
    await c.stop();
  });

  it("null once stopped", async () => {
    const { c, hls } = await hlsSession();
    hls.playingDate = new Date(T0);
    await c.stop();
    expect(c.playheadWallclock()).toBeNull();
  });

  it("native: getStartDate() + currentTime", () => {
    const video = nativeVideo({ start: T0, readyState: 4, seekable: [[0, 30]] });
    video.currentTime = 12.5;
    const c = nativeController(video);
    expect(c.playheadWallclock()?.getTime()).toBe(T0 + 12_500);
  });

  it("native: null before metadata (first frame) and without PDT", () => {
    const state = { start: T0 as number | null, readyState: 0, seekable: [] as [number, number][] };
    const c = nativeController(nativeVideo(state));
    expect(c.playheadWallclock()).toBeNull();
    state.readyState = 4;
    state.start = null;
    expect(c.playheadWallclock()).toBeNull();
  });

  it("a video without getStartDate (no PDT support) has no playhead", () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "readyState", { get: () => 4 });
    const c = nativeController(video);
    expect(c.playheadWallclock()).toBeNull();
  });
});

describe("seekToWallclock", () => {
  const fragments = [
    { start: 100, duration: 2, programDateTime: T0 },
    { start: 102, duration: 2, programDateTime: T0 + 2_000 },
    { start: 104, duration: 2, programDateTime: T0 + 4_000 },
  ];

  it("maps a PDT to media time inside the playlist window, null outside or without PDT", () => {
    expect(mediaTimeOfWallclock(fragments, T0)).toBe(100);
    expect(mediaTimeOfWallclock(fragments, T0 + 3_250)).toBe(103.25);
    expect(mediaTimeOfWallclock(fragments, T0 - 1)).toBeNull();
    expect(mediaTimeOfWallclock(fragments, T0 + 6_000)).toBeNull();
    expect(mediaTimeOfWallclock([{ start: 0, duration: 2, programDateTime: null }], T0)).toBeNull();
    expect(mediaTimeOfWallclock([], T0)).toBeNull();
  });

  it("hls.js: seeks within the playing level's window, refuses out of range", async () => {
    const { c, hls, video } = await hlsSession();
    hls.levels = [{ uri: "https://play.example/hls/live/rivertide/index.m3u8", details: { fragments } }];
    hls.currentLevel = 0;
    expect(c.seekToWallclock(new Date(T0 + 5_000))).toBe(true);
    expect(video.currentTime).toBe(105);
    expect(c.seekToWallclock(new Date(T0 + 60_000))).toBe(false);
    expect(c.seekToWallclock(new Date(T0 - 60_000))).toBe(false);
    expect(c.seekToWallclock(new Date(Number.NaN))).toBe(false);
    expect(video.currentTime).toBe(105);
    await c.stop();
  });

  it("hls.js: before a level is chosen, any level with details; none at all refuses", async () => {
    const { c, hls, video } = await hlsSession();
    expect(c.seekToWallclock(new Date(T0))).toBe(false);
    hls.levels = [
      { uri: "https://play.example/hls/live/rivertide/720p/index.m3u8" },
      { uri: "x", details: { fragments } },
    ];
    expect(c.seekToWallclock(new Date(T0 + 1_000))).toBe(true);
    expect(video.currentTime).toBe(101);
    await c.stop();
  });

  it("native: currentTime from getStartDate(), within seekable", () => {
    const video = nativeVideo({ start: T0, readyState: 4, seekable: [[10, 40]] });
    const c = nativeController(video);
    expect(c.seekToWallclock(new Date(T0 + 20_000))).toBe(true);
    expect(video.currentTime).toBe(20);
    expect(c.seekToWallclock(new Date(T0 + 5_000))).toBe(false);
    expect(c.seekToWallclock(new Date(T0 + 41_000))).toBe(false);
    expect(video.currentTime).toBe(20);
  });

  it("native: refuses before metadata", () => {
    const video = nativeVideo({ start: T0, readyState: 0, seekable: [[0, 40]] });
    expect(nativeController(video).seekToWallclock(new Date(T0 + 1_000))).toBe(false);
  });
});

describe("setTargetLatency", () => {
  it("hls.js: sets liveSyncDuration through hls.targetLatency and steps to the sync position", async () => {
    const { c, hls, video } = await hlsSession();
    hls.media = video;
    hls.liveSyncPosition = 88;
    expect(c.setTargetLatency(12)).toBe(12);
    expect(hls.targetLatency).toBe(12);
    expect(video.currentTime).toBe(88);
    await c.stop();
  });

  it("hls.js: clamps to the allowed range and keeps the max latency above the target", async () => {
    const { c, hls } = await hlsSession();
    hls.config.liveMaxLatencyDuration = 6;
    expect(c.setTargetLatency(0.1)).toBe(TARGET_LATENCY_RANGE.min);
    expect(c.setTargetLatency(500)).toBe(TARGET_LATENCY_RANGE.max);
    expect(hls.config.liveMaxLatencyDuration).toBeGreaterThan(TARGET_LATENCY_RANGE.max);
    expect(c.setTargetLatency(Number.NaN)).toBe(TARGET_LATENCY_RANGE.max);
    await c.stop();
  });

  it("before hls.js attaches: the low-latency config gets liveSyncDuration instead of the segment count", async () => {
    const { c, hls } = await hlsSession({ targetLatency: 3 });
    expect(hls.config).toMatchObject({ lowLatencyMode: true, liveSyncDuration: 3 });
    expect(hls.config).not.toHaveProperty("liveSyncDurationCount");
    await c.stop();
  });

  it("without a target the low-latency config is unchanged", async () => {
    const { c, hls } = await hlsSession();
    expect(hls.config).toMatchObject({ lowLatencyMode: true, liveSyncDurationCount: 3 });
    expect(hls.config).not.toHaveProperty("liveSyncDuration");
    await c.stop();
  });

  it("native: a no-op returning the current latency (NaN while unknown)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 10_000);
    const state = { start: T0 as number | null, readyState: 4, seekable: [[0, 30]] as [number, number][] };
    const video = nativeVideo(state);
    video.currentTime = 4;
    const c = nativeController(video);
    expect(c.setTargetLatency(3)).toBe(6);
    expect(video.currentTime).toBe(4);
    state.start = null;
    expect(c.setTargetLatency(3)).toBeNaN();
  });
});

describe("diagnostic query parameters", () => {
  it("reads targetLatency (1–30 s) and a known rendition", () => {
    expect(diagnosticParams("?targetLatency=3&rendition=480p")).toEqual({ targetLatency: 3, rendition: "480p" });
    expect(diagnosticParams("targetLatency=12.5&rendition=source")).toEqual({
      targetLatency: 12.5,
      rendition: "source",
    });
    expect(diagnosticParams(`?targetLatency=${DIAGNOSTIC_LATENCY_RANGE.min}`)).toEqual({ targetLatency: 1 });
    expect(diagnosticParams(`?targetLatency=${DIAGNOSTIC_LATENCY_RANGE.max}`)).toEqual({ targetLatency: 30 });
  });

  it("ignores invalid values", () => {
    expect(diagnosticParams("")).toEqual({});
    for (const v of ["0", "0.5", "31", "-3", "abc", "3s", "1e1", "", "Infinity", "NaN"])
      expect(diagnosticParams(`?targetLatency=${v}`)).toEqual({});
    for (const v of ["", "4k", "SOURCE", "../720p", "720"]) expect(diagnosticParams(`?rendition=${v}`)).toEqual({});
  });

  it("applied: the target latency reaches hls.js and the rendition's level is pinned once the manifest is parsed", async () => {
    const { c, hls } = await hlsSession(diagnosticParams("?targetLatency=12&rendition=480p"));
    expect(hls.config).toMatchObject({ liveSyncDuration: 12 });
    hls.levels = [
      { uri: "https://play.example/hls/live/rivertide/index.m3u8?t=tok" },
      { uri: "https://play.example/hls/live/rivertide/720p/index.m3u8?t=tok" },
      { uri: "https://play.example/hls/live/rivertide/480p/index.m3u8?t=tok" },
    ];
    hls.emit(SeamHls.Events.MANIFEST_PARSED, {});
    expect(hls.currentLevel).toBe(2);
    await c.stop();
  });

  it("source pins the level outside any rendition directory; an absent rung pins nothing", async () => {
    const levels = [
      { uri: "https://play.example/hls/live/rivertide/720p/index.m3u8" },
      { uri: "https://play.example/hls/live/rivertide/index.m3u8" },
    ];
    const a = await hlsSession({ rendition: "source" });
    a.hls.levels = levels;
    a.hls.emit(SeamHls.Events.MANIFEST_PARSED, {});
    expect(a.hls.currentLevel).toBe(1);
    await a.c.stop();
    FakeHls.instances = [];
    const b = await hlsSession({ rendition: "1080p" });
    b.hls.levels = levels;
    b.hls.emit(SeamHls.Events.MANIFEST_PARSED, {});
    expect(b.hls.currentLevel).toBe(-1);
    await b.c.stop();
  });

  it("no rendition: no level pinning at all (ABR stays on)", async () => {
    const { c, hls } = await hlsSession();
    expect(hls.handlers.get(SeamHls.Events.MANIFEST_PARSED)).toBeUndefined();
    await c.stop();
  });
});

describe("playback mode", () => {
  it("is live in W1; subscribers hear changes until they unsubscribe", async () => {
    const { c } = await hlsSession();
    expect(c.playbackMode()).toBe("live");
    const seen: string[] = [];
    const other: string[] = [];
    const off = c.onPlaybackMode((m) => seen.push(m));
    c.onPlaybackMode((m) => other.push(m));
    c.setPlaybackMode("dvr");
    c.setPlaybackMode("dvr");
    expect(c.playbackMode()).toBe("dvr");
    off();
    c.setPlaybackMode("live");
    expect(seen).toEqual(["dvr"]);
    expect(other).toEqual(["dvr", "live"]);
    await c.stop();
    c.setPlaybackMode("dvr");
    expect(other).toEqual(["dvr", "live"]);
  });
});

describe("onTextTrack", () => {
  it("fires on addtrack/removetrack/change until unsubscribed or stopped", async () => {
    const { c, video } = await hlsSession();
    const tracks = new EventTarget();
    Object.defineProperty(video, "textTracks", { get: () => tracks });
    const seen: unknown[] = [];
    const off = c.onTextTrack((t) => seen.push(t));
    tracks.dispatchEvent(new Event("addtrack"));
    tracks.dispatchEvent(new Event("change"));
    off();
    off();
    tracks.dispatchEvent(new Event("removetrack"));
    expect(seen).toEqual([tracks, tracks]);
    c.onTextTrack((t) => seen.push(t));
    await c.stop();
    tracks.dispatchEvent(new Event("addtrack"));
    expect(seen).toHaveLength(2);
  });

  it("a video without textTracks gives a no-op subscription", async () => {
    const { c, video } = await hlsSession();
    Object.defineProperty(video, "textTracks", { get: () => undefined });
    expect(() => c.onTextTrack(() => undefined)()).not.toThrow();
    await c.stop();
  });
});

describe("heartbeat", () => {
  it("every beat carries playbackMode and behindLiveSeconds: null; latency comes from the playhead", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0 + 5_000);
    const { c, f, hls } = await hlsSession();
    hls.playingDate = new Date(T0);
    await vi.advanceTimersByTimeAsync(700_000);
    expect(f.heartbeat).toHaveBeenCalled();
    const body = f.heartbeat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ playbackMode: "live", behindLiveSeconds: null });
    // Seconds between the playhead's PDT and the beat (5 s plus the jittered heartbeat delay).
    expect(body.latencySeconds as number).toBeGreaterThan(5);
    c.setPlaybackMode("dvr");
    await vi.advanceTimersByTimeAsync(700_000);
    expect(f.heartbeat.mock.calls.at(-1)?.[0]).toMatchObject({ playbackMode: "dvr", behindLiveSeconds: null });
    await c.stop();
  });
});
