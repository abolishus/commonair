// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 (B8-player): a watch-room member reports its live edge as a wall-clock instant
 * (`edgeWallclock`) in `live` mode, from the media clock (PDT under the playhead plus the distance
 * to the edge: hls.js `latency`, else the element's `seekable`), and null in `dvr`.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { registerMediaClock } from "../src/player/media-clock.ts";
import { liveEdgeMs, roomReport, type EdgeInput, type RoomPlayer } from "../src/player/room-sync.ts";
import { registerRoomPlayer, roomPlayer, roomSyncReport } from "../src/player/room-sync-registry.ts";

const NOW = 1_800_000_000_000;
const base: EdgeInput = {
  mode: "live",
  playheadMs: NOW - 8000,
  latencySeconds: null,
  seekableEnd: null,
  currentTime: null,
};

describe("liveEdgeMs", () => {
  it("hls.js: the playhead plus its latency", () => {
    expect(liveEdgeMs({ ...base, latencySeconds: 3.5 })).toBe(NOW - 4500);
  });

  it("native: the playhead plus the distance to seekable's end", () => {
    expect(liveEdgeMs({ ...base, seekableEnd: 120, currentTime: 114 })).toBe(NOW - 2000);
    expect(liveEdgeMs({ ...base, seekableEnd: 120, currentTime: 120 })).toBe(NOW - 8000);
  });

  it("the latency wins over seekable when both are known", () => {
    expect(liveEdgeMs({ ...base, latencySeconds: 2, seekableEnd: 120, currentTime: 100 })).toBe(NOW - 6000);
  });

  it("an unusable latency falls back to seekable", () => {
    for (const latencySeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(liveEdgeMs({ ...base, latencySeconds, seekableEnd: 120, currentTime: 117 })).toBe(NOW - 5000);
  });

  it("null in DVR, before the first frame, or when no distance is known", () => {
    expect(liveEdgeMs({ ...base, mode: "dvr", latencySeconds: 3 })).toBeNull();
    expect(liveEdgeMs({ ...base, playheadMs: null, latencySeconds: 3 })).toBeNull();
    expect(liveEdgeMs(base)).toBeNull();
    // A playhead past seekable's end is not an edge.
    expect(liveEdgeMs({ ...base, seekableEnd: 100, currentTime: 101 })).toBeNull();
    expect(liveEdgeMs({ ...base, seekableEnd: Number.NaN, currentTime: 1 })).toBeNull();
  });
});

const player = (mode: "live" | "dvr", edge: Date | null): RoomPlayer => ({
  playheadWallclock: () => new Date(NOW - 8000),
  playbackMode: () => mode,
  seekToWallclock: () => true,
  native: false,
  edgeWallclock: () => edge,
});

describe("roomReport", () => {
  it("live: the playhead, the mode and the edge", () => {
    expect(roomReport(player("live", new Date(NOW - 3000)))).toEqual({
      at: new Date(NOW - 8000),
      mode: "live",
      edge: new Date(NOW - 3000),
    });
  });

  it("dvr: no edge, whatever the player says", () => {
    expect(roomReport(player("dvr", new Date(NOW - 3000)))?.edge).toBeNull();
  });

  it("no player, an unknown or invalid edge", () => {
    expect(roomReport(null)).toBeNull();
    expect(roomReport(player("live", null))?.edge).toBeNull();
    expect(roomReport(player("live", new Date(Number.NaN)))?.edge).toBeNull();
    // A player without the seam (before batch 8).
    const old: RoomPlayer = { ...player("live", null), edgeWallclock: undefined };
    expect(roomReport(old)?.edge).toBeNull();
  });
});

/** A minimal `player-video` element and the document that holds it. */
function fakeDoc(video: { currentTime: number; end: number | null }): Document {
  const el = {
    currentTime: video.currentTime,
    readyState: 4,
    canPlayType: () => "",
    seekable:
      video.end === null
        ? { length: 0, start: () => 0, end: () => 0 }
        : { length: 1, start: () => 0, end: () => video.end },
  };
  return { querySelector: () => el } as unknown as Document;
}

describe("the registry's edge", () => {
  const offs: (() => void)[] = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  const source = (mode: "live" | "dvr", latency: number | null) => ({
    setTargetLatency: (s: number) => s,
    seekToWallclock: () => true,
    playheadWallclock: () => new Date(NOW - 8000),
    playbackMode: () => mode,
    latencySeconds: () => latency,
  });

  it("hls.js: from the registered player's latency", () => {
    offs.push(registerRoomPlayer("edge-hls", source("live", 4), false));
    expect(roomPlayer("edge-hls", null)?.edgeWallclock?.()).toEqual(new Date(NOW - 4000));
    expect(roomSyncReport("edge-hls", null)).toEqual({
      at: new Date(NOW - 8000),
      mode: "live",
      edge: new Date(NOW - 4000),
    });
  });

  it("native (no latency): from the page's video element", () => {
    offs.push(registerRoomPlayer("edge-native", source("live", null), true));
    const doc = fakeDoc({ currentTime: 50, end: 53 });
    expect(roomSyncReport("edge-native", doc).edge).toEqual(new Date(NOW - 5000));
    // Nothing seekable yet: no edge, the playhead still goes out.
    expect(roomSyncReport("edge-native", fakeDoc({ currentTime: 50, end: null }))).toMatchObject({
      at: new Date(NOW - 8000),
      edge: null,
    });
  });

  it("hls.js players get a playback-rate seam on the page's element; native ones do not", () => {
    offs.push(registerRoomPlayer("rate-hls", source("live", 4), false));
    const el = { playbackRate: 1 };
    const doc = { querySelector: () => el } as unknown as Document;
    const p = roomPlayer("rate-hls", doc);
    expect(p?.setPlaybackRate?.(1.25)).toBe(true);
    expect(el.playbackRate).toBe(1.25);
    expect(p?.setPlaybackRate?.(Number.NaN)).toBe(false);
    expect(p?.setPlaybackRate?.(0)).toBe(false);
    expect(roomPlayer("rate-hls", null)?.setPlaybackRate?.(1)).toBe(false);
    // An element that refuses the value (it throws, or keeps its own).
    const refusing = {
      get playbackRate() {
        return 1;
      },
      set playbackRate(_: number) {
        throw new Error("NotSupportedError");
      },
    };
    const doc2 = { querySelector: () => refusing } as unknown as Document;
    expect(roomPlayer("rate-hls", doc2)?.setPlaybackRate?.(1.1)).toBe(false);
    offs.push(registerRoomPlayer("rate-native", source("live", null), true));
    expect(roomPlayer("rate-native", doc)).not.toHaveProperty("setPlaybackRate");
  });

  it("dvr: null", () => {
    offs.push(registerRoomPlayer("edge-dvr", source("dvr", 4), false));
    expect(roomSyncReport("edge-dvr", fakeDoc({ currentTime: 50, end: 53 }))).toMatchObject({
      mode: "dvr",
      edge: null,
    });
  });

  it("the page fallback (media clock only): from the element's seekable", () => {
    offs.push(
      registerMediaClock("edge-dom", { playheadWallclock: () => new Date(NOW - 8000), playbackMode: () => "live" }),
    );
    expect(roomSyncReport("edge-dom", fakeDoc({ currentTime: 10, end: 16 })).edge).toEqual(new Date(NOW - 2000));
  });

  it("no player and no page: the media clock alone, no edge", () => {
    offs.push(
      registerMediaClock("edge-none", { playheadWallclock: () => new Date(NOW - 8000), playbackMode: () => "live" }),
    );
    expect(roomSyncReport("edge-none", null)).toEqual({ at: new Date(NOW - 8000), mode: "live", edge: null });
  });
});
