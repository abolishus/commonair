// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The W2 player seam (docs/testing/w2-selectors.md "Player seam (W2)"): `enterDvr` / `exitDvr` on
 * the same hls.js instance (native: the same element), the DVR token on DVR requests and its
 * refresh from heartbeats, `behindLiveSeconds` in DVR, and the session features the slots read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeHls, fakeApi, playbackStart } from "./p2p-fakes.ts";

class DvrHls extends FakeHls {
  static override Events = { ...FakeHls.Events, MANIFEST_PARSED: "hlsManifestParsed" };
  levels: { uri: string }[] = [];
  currentLevel = -1;
  off(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== fn),
    );
  }
}

vi.mock("hls.js", () => ({ default: DvrHls }));

const { DVR_LOAD_TIMEOUT_MS, NO_SESSION_FEATURES, PlayerController, urlDirectory } =
  await import("../src/player/controller.ts");
type Features = import("../src/player/controller.ts").SessionFeatures;

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const LIVE = "https://play.example/hls/live/rivertide/index.m3u8?t=tok-1";
const DVR = "https://play.example/dvr/019a0000-0000-7000-8000-0000000000aa/index.m3u8?t=dvr-1";
/** What hls.js hands `LEVEL_LOADED` listeners (the controller counts its bytes). */
const LEVEL = { details: {}, stats: { loaded: 0 } };

function started(over: Record<string, unknown> = {}) {
  return {
    ...playbackStart({ enabled: false }),
    captionsState: "off" as const,
    dvrWindowSeconds: 1800,
    dvrPlaylistUrl: DVR,
    ...over,
  };
}

beforeEach(() => {
  FakeHls.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function session(over: Record<string, unknown> = {}, opts: { native?: boolean } = {}) {
  const f = fakeApi(started(over) as unknown as ReturnType<typeof playbackStart>);
  const video = document.createElement("video");
  vi.spyOn(video, "canPlayType").mockReturnValue(opts.native ? "maybe" : "");
  vi.spyOn(video, "play").mockResolvedValue(undefined);
  const features: Features[] = [];
  const c = new PlayerController({
    channel: "rivertide",
    video,
    api: f.api,
    onState: () => undefined,
    onFeatures: (x) => features.push(x),
  });
  return { c, f, video, features };
}

async function hlsSession(over: Record<string, unknown> = {}) {
  const s = await session(over);
  await s.c.start();
  const hls = FakeHls.instances[0] as DvrHls;
  return { ...s, hls };
}

/** The token hls.js's `xhrSetup` puts on a request for `url`. */
function tokenOn(hls: DvrHls, url: string): string | null {
  const open = vi.fn<(method: string, url: string, async: boolean) => void>();
  (hls.config.xhrSetup as (xhr: unknown, url: string) => void)({ open }, url);
  const sent = open.mock.calls[0]?.[1];
  return sent === undefined ? null : new URL(sent).searchParams.get("t");
}

describe("session features", () => {
  it("reports captions and the DVR grant once the session starts", async () => {
    const tracks = [{ language: "en", label: "English", url: "https://play.example/captions/en.m3u8" }];
    const { c, features } = await hlsSession({ captions: tracks, captionsState: "active" });
    expect(features).toEqual([
      { captions: { tracks, state: "active" }, dvr: { windowSeconds: 1800, playlistUrl: DVR } },
    ]);
    expect(c.dvrGrant()).toEqual({ windowSeconds: 1800, playlistUrl: DVR });
    await c.stop();
    expect(c.dvrGrant()).toBeNull();
  });

  it("no grant when the window is 0 or the URL is null; enterDvr then refuses and loads nothing", async () => {
    for (const over of [{ dvrWindowSeconds: 0, dvrPlaylistUrl: null }, { dvrPlaylistUrl: null }]) {
      FakeHls.instances = [];
      const { c, hls, features } = await hlsSession(over);
      expect(features[0]?.dvr).toBeNull();
      expect(c.dvrGrant()).toBeNull();
      expect(await c.enterDvr(DVR)).toBe(false);
      expect(hls.loadSource).toHaveBeenCalledTimes(1);
      expect(c.playbackMode()).toBe("live");
      await c.stop();
    }
  });

  it("nothing granted before a session", () => {
    expect(NO_SESSION_FEATURES).toEqual({ captions: { tracks: [], state: "off" }, dvr: null });
  });

  it("urlDirectory drops the file and the query", () => {
    expect(urlDirectory(DVR)).toBe("https://play.example/dvr/019a0000-0000-7000-8000-0000000000aa/");
  });
});

describe("enterDvr / exitDvr (hls.js)", () => {
  it("loads the DVR playlist on the same hls.js instance, then reports dvr; exit returns to live", async () => {
    const { c, hls } = await hlsSession();
    const modes: string[] = [];
    c.onPlaybackMode((m) => modes.push(m));
    const entering = c.enterDvr(DVR);
    expect(hls.loadSource).toHaveBeenLastCalledWith(DVR);
    // Not yet: the playlist has not loaded.
    expect(c.playbackMode()).toBe("live");
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    expect(await entering).toBe(true);
    expect(c.playbackMode()).toBe("dvr");
    expect(FakeHls.instances).toHaveLength(1);
    expect(hls.destroy).not.toHaveBeenCalled();
    c.exitDvr();
    expect(hls.loadSource).toHaveBeenLastCalledWith(LIVE);
    expect(c.playbackMode()).toBe("live");
    expect(modes).toEqual(["dvr", "live"]);
    c.exitDvr();
    expect(hls.loadSource).toHaveBeenCalledTimes(3);
    await c.stop();
  });

  it("DVR requests carry the DVR token, live requests the live token", async () => {
    const { c, hls } = await hlsSession();
    const entering = c.enterDvr(DVR);
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    await entering;
    expect(tokenOn(hls, "https://play.example/dvr/019a0000-0000-7000-8000-0000000000aa/seg-1.ts?t=old")).toBe("dvr-1");
    expect(tokenOn(hls, "https://play.example/hls/live/rivertide/720p/index.m3u8?t=old")).toBe("tok-1");
    // Another VOD's DVR path is not this grant's.
    expect(tokenOn(hls, "https://play.example/dvr/other/seg-1.ts?t=old")).toBe("tok-1");
    c.exitDvr();
    expect(tokenOn(hls, "https://play.example/dvr/019a0000-0000-7000-8000-0000000000aa/seg-1.ts?t=old")).toBe("tok-1");
    await c.stop();
  });

  it("gives up after DVR_LOAD_TIMEOUT_MS and returns to the live playlist", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { c, hls } = await hlsSession();
    const entering = c.enterDvr(DVR);
    await vi.advanceTimersByTimeAsync(DVR_LOAD_TIMEOUT_MS);
    expect(await entering).toBe(false);
    expect(c.playbackMode()).toBe("live");
    expect(hls.loadSource).toHaveBeenLastCalledWith(LIVE);
    // The listener is gone: a late level changes nothing.
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    expect(c.playbackMode()).toBe("live");
    await c.stop();
  });

  it("an exit (or a second enter) supersedes a pending enter", async () => {
    const { c, hls } = await hlsSession();
    const first = c.enterDvr(DVR);
    c.exitDvr();
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    expect(await first).toBe(false);
    expect(c.playbackMode()).toBe("live");
    const a = c.enterDvr(DVR);
    const b = c.enterDvr(DVR);
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(c.playbackMode()).toBe("dvr");
    await c.stop();
  });

  it("setPlaybackMode('live') while DVR plays is an exit", async () => {
    const { c, hls } = await hlsSession();
    const entering = c.enterDvr(DVR);
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    await entering;
    c.setPlaybackMode("live");
    expect(hls.loadSource).toHaveBeenLastCalledWith(LIVE);
    expect(c.playbackMode()).toBe("live");
    await c.stop();
  });

  it("turning data mode on cancels a DVR load still pending", async () => {
    const { c, hls } = await hlsSession();
    const entering = c.enterDvr(DVR);
    c.setDataMode(500_000);
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    expect(await entering).toBe(false);
    expect(c.playbackMode()).toBe("live");
    expect(hls.loadSource).toHaveBeenLastCalledWith(LIVE);
    await c.stop();
  });

  it("refuses in data mode, and turning data mode on leaves DVR", async () => {
    const { c, hls } = await hlsSession();
    const entering = c.enterDvr(DVR);
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    await entering;
    c.setDataMode(800_000);
    expect(c.playbackMode()).toBe("live");
    expect(hls.loadSource).toHaveBeenLastCalledWith(LIVE);
    expect(await c.enterDvr(DVR)).toBe(false);
    await c.stop();
  });

  it("DVR is origin-only: a P2P session stops sharing on entering it", async () => {
    const f = fakeApi({
      ...started(),
      ...playbackStart({ enabled: true }),
      dvrWindowSeconds: 1800,
      dvrPlaylistUrl: DVR,
    } as never);
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("");
    vi.spyOn(video, "play").mockResolvedValue(undefined);
    const p2p = {
      hls: null as unknown as DvrHls,
      enable: vi.fn<() => void>(),
      disable: vi.fn<() => void>(),
      destroy: vi.fn<() => void>(),
      running: true,
    };
    const c = new PlayerController({
      channel: "rivertide",
      video,
      api: f.api,
      onState: () => undefined,
      p2pWanted: () => true,
      loadP2PEngine: async () =>
        ({
          createP2PHls: (o: { hlsConfig: Record<string, unknown> }) => {
            p2p.hls = new DvrHls(o.hlsConfig);
            return p2p;
          },
        }) as never,
    });
    await c.start();
    expect(p2p.disable).not.toHaveBeenCalled();
    const entering = c.enterDvr(DVR);
    expect(p2p.disable).toHaveBeenCalledTimes(1);
    expect(p2p.hls.loadSource).toHaveBeenLastCalledWith(DVR);
    p2p.hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    expect(await entering).toBe(true);
    expect(c.p2pStatus().state).toBe("off");
    await c.stop();
  });

  it("refuses once stopped", async () => {
    const { c } = await hlsSession();
    await c.stop();
    expect(await c.enterDvr(DVR)).toBe(false);
  });
});

describe("heartbeats in DVR", () => {
  it("keep the session and its played seconds, send behindLiveSeconds, and refresh the DVR token", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0);
    const { c, f, hls, video } = await hlsSession();
    f.heartbeat.mockResolvedValue({ ok: true, token: "tok-2", dvrToken: "dvr-2" });
    const entering = c.enterDvr(DVR);
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    await entering;
    hls.playingDate = new Date(T0 - 600_000);
    // Played seconds count on the same element across the switch.
    Object.defineProperty(video, "paused", { get: () => false, configurable: true });
    for (const at of [1, 2.5, 4]) {
      video.currentTime = at;
      video.dispatchEvent(new Event("timeupdate"));
    }
    await vi.advanceTimersByTimeAsync(700_000);
    const beat = f.heartbeat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(beat).toMatchObject({ sessionId: started().sessionId, playbackMode: "dvr", latencySeconds: null });
    expect(beat.behindLiveSeconds as number).toBeGreaterThanOrEqual(600);
    expect(beat.playedSeconds).toBe(3);
    expect(c.dvrGrant()?.playlistUrl).toContain("t=dvr-2");
    expect(tokenOn(hls, "https://play.example/dvr/019a0000-0000-7000-8000-0000000000aa/seg-9.ts?t=dvr-1")).toBe(
      "dvr-2",
    );
    // Back at the edge: the live playlist with the refreshed live token.
    c.exitDvr();
    expect(hls.loadSource).toHaveBeenLastCalledWith(LIVE.replace("tok-1", "tok-2"));
    expect(f.start).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it("a switchTo while DVR plays is remembered and played on exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { c, f, hls } = await hlsSession();
    const moved = "https://relay.example/hls/live/rivertide/index.m3u8?t=tok-r";
    f.heartbeat.mockResolvedValue({ ok: true, token: "tok-r", switchTo: moved });
    const entering = c.enterDvr(DVR);
    hls.emit(DvrHls.Events.LEVEL_LOADED, LEVEL);
    await entering;
    const loads = hls.loadSource.mock.calls.length;
    await vi.advanceTimersByTimeAsync(700_000);
    expect(hls.loadSource.mock.calls.length).toBe(loads);
    c.exitDvr();
    expect(hls.loadSource).toHaveBeenLastCalledWith(moved);
    await c.stop();
  });
});

describe("enterDvr (native HLS)", () => {
  it("points the same element at the DVR playlist and waits for its metadata; an error returns to live", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("#EXTM3U", { status: 200 }));
    const { c, video } = await session({}, { native: true });
    await c.start();
    expect(FakeHls.instances).toHaveLength(0);
    expect(video.src).toBe(LIVE);
    const ok = c.enterDvr(DVR);
    expect(video.src).toBe(DVR);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(await ok).toBe(true);
    expect(c.playbackMode()).toBe("dvr");
    c.exitDvr();
    expect(video.src).toBe(LIVE);
    const failed = c.enterDvr(DVR);
    video.dispatchEvent(new Event("error"));
    expect(await failed).toBe(false);
    expect(video.src).toBe(LIVE);
    expect(c.playbackMode()).toBe("live");
    await c.stop();
  });
});
