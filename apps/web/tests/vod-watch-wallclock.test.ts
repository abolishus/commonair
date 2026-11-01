// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The VOD and clip player's wall clock (W2-vod-watch, `components/vod-watch/wallclock.ts` and the
 * player's source mapping): hls.js and native HLS fakes, null before the first frame, seeking in
 * and out of range, and the clip window mapping.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  clipOrigin,
  hlsOrigin,
  hlsWallclock,
  mediaTimeAt,
  nativeOrigin,
  originWallclock,
  type HlsClock,
  type VideoClock,
} from "../src/components/vod-watch/wallclock.ts";
import { playerOrigin, playerWallclock, preferredTrack } from "../src/components/vod-watch/vod-player.tsx";

const PDT = Date.parse("2026-11-01T12:00:00.000Z");

const video = (over: Partial<VideoClock> = {}): VideoClock & HTMLVideoElement =>
  ({ readyState: 4, currentTime: 0, duration: 600, ...over }) as VideoClock & HTMLVideoElement;

const hls = (over: Partial<HlsClock> = {}): HlsClock => ({
  playingDate: null,
  currentLevel: 0,
  levels: [
    {
      details: {
        fragments: [
          { programDateTime: PDT, start: 0 },
          { programDateTime: PDT + 4_000, start: 4 },
        ],
      },
    },
  ],
  ...over,
});

describe("hls.js", () => {
  it("the wall clock is playingDate, null before the first frame", () => {
    expect(hlsWallclock(hls())).toBeNull();
    expect(hlsWallclock(hls({ playingDate: new Date(PDT + 7_250) }))?.getTime()).toBe(PDT + 7_250);
    expect(hlsWallclock(hls({ playingDate: new Date(Number.NaN) }))).toBeNull();
  });

  it("the origin is the first fragment's PDT less its start, from any loaded level", () => {
    expect(hlsOrigin(hls())).toBe(PDT);
    // A playlist trimmed at the front: first fragment starts at 8 s.
    expect(hlsOrigin(hls({ levels: [{ details: { fragments: [{ programDateTime: PDT + 8_000, start: 8 }] } }] }))).toBe(
      PDT,
    );
    // The current level has no details yet: another level's do.
    expect(hlsOrigin(hls({ currentLevel: 1, levels: [...hls().levels, {}] }))).toBe(PDT);
    expect(hlsOrigin(hls({ currentLevel: -1 }))).toBe(PDT);
    expect(hlsOrigin(hls({ levels: [] }))).toBeNull();
    expect(hlsOrigin(hls({ levels: [{ details: { fragments: [{ programDateTime: null, start: 0 }] } }] }))).toBeNull();
  });

  it("playerOrigin falls back to playingDate less currentTime without PDT on the levels", () => {
    const h = hls({ levels: [], playingDate: new Date(PDT + 10_000) });
    expect(playerOrigin({ kind: "hls", url: "x" }, video({ currentTime: 10 }), h)).toBe(PDT);
    expect(playerOrigin({ kind: "hls", url: "x" }, video(), hls({ levels: [] }))).toBeNull();
    expect(playerWallclock({ kind: "hls", url: "x" }, video(), h)?.getTime()).toBe(PDT + 10_000);
  });
});

describe("native HLS", () => {
  const start = () => new Date(PDT);

  it("getStartDate() plus currentTime, null before the metadata", () => {
    expect(nativeOrigin(video({ readyState: 0, getStartDate: start }))).toBeNull();
    expect(nativeOrigin(video({ getStartDate: start }))).toBe(PDT);
    expect(nativeOrigin(video({ getStartDate: () => new Date(Number.NaN) }))).toBeNull();
    expect(nativeOrigin(video())).toBeNull();
    const v = video({ currentTime: 12.5, getStartDate: start });
    expect(playerWallclock({ kind: "hls", url: "x" }, v, null)?.getTime()).toBe(PDT + 12_500);
    expect(playerWallclock({ kind: "hls", url: "x" }, video({ readyState: 0, getStartDate: start }), null)).toBeNull();
  });
});

describe("clips", () => {
  const W = "2026-11-01T12:04:50.000Z";

  it("the window start plus currentTime", () => {
    expect(clipOrigin(W)).toBe(Date.parse(W));
    expect(clipOrigin(null)).toBeNull();
    expect(clipOrigin("not a time")).toBeNull();
    const src = { kind: "mp4" as const, url: "c.mp4", windowStartedAt: W };
    expect(playerWallclock(src, video({ currentTime: 3 }), null)?.getTime()).toBe(Date.parse(W) + 3_000);
    expect(playerWallclock(src, video({ readyState: 0 }), null)).toBeNull();
    expect(playerWallclock({ ...src, windowStartedAt: null }, video(), null)).toBeNull();
    expect(playerOrigin(src, video(), null)).toBe(Date.parse(W));
  });
});

describe("seeking", () => {
  it("maps a wall clock inside the media to its media time", () => {
    expect(mediaTimeAt(PDT, 600, new Date(PDT))).toBe(0);
    expect(mediaTimeAt(PDT, 600, new Date(PDT + 61_500))).toBe(61.5);
    expect(mediaTimeAt(PDT, 600, new Date(PDT + 600_000))).toBe(600);
  });

  it("refuses an instant outside the media or without an origin", () => {
    expect(mediaTimeAt(PDT, 600, new Date(PDT - 1))).toBeNull();
    expect(mediaTimeAt(PDT, 600, new Date(PDT + 600_001))).toBeNull();
    expect(mediaTimeAt(null, 600, new Date(PDT))).toBeNull();
    expect(mediaTimeAt(PDT, 600, new Date(Number.NaN))).toBeNull();
    // Duration not known yet: anything from the start on.
    expect(mediaTimeAt(PDT, Number.NaN, new Date(PDT + 9_000_000))).toBe(9_000);
  });

  it("originWallclock needs an origin and metadata", () => {
    expect(originWallclock(video({ currentTime: 2 }), PDT)?.getTime()).toBe(PDT + 2_000);
    expect(originWallclock(video({ currentTime: 2 }), null)).toBeNull();
    expect(originWallclock(video({ readyState: 0 }), PDT)).toBeNull();
  });
});

describe("captions", () => {
  it("prefers the page's language, else the first track", () => {
    const tracks = [
      { language: "en", label: "English", url: "en.vtt" },
      { language: "es", label: "Español", url: "es.vtt" },
    ];
    expect(preferredTrack(tracks, "es-MX")).toBe(1);
    expect(preferredTrack(tracks, "en")).toBe(0);
    expect(preferredTrack(tracks, "de")).toBe(0);
  });
});
