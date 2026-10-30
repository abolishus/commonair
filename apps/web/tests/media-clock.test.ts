// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The per-channel media-clock registry (player writes, chat reads). */
import { describe, expect, it } from "vite-plus/test";
import { playbackMode, playheadWallclock, registerMediaClock, type PlaybackMode } from "../src/player/media-clock.ts";

const clock = (at: number | null, mode: PlaybackMode = "live") => ({
  playheadWallclock: () => (at === null ? null : new Date(at)),
  playbackMode: () => mode,
});

describe("media clock registry", () => {
  it("without a player: no playhead, live", () => {
    expect(playheadWallclock("nobody")).toBeNull();
    expect(playbackMode("nobody")).toBe("live");
  });

  it("register, read at call time, unregister", () => {
    let at = 1_000;
    const off = registerMediaClock("a", { playheadWallclock: () => new Date(at), playbackMode: () => "live" });
    expect(playheadWallclock("a")?.getTime()).toBe(1_000);
    at = 2_000;
    expect(playheadWallclock("a")?.getTime()).toBe(2_000);
    expect(playheadWallclock("b")).toBeNull();
    off();
    expect(playheadWallclock("a")).toBeNull();
  });

  it("the latest registration wins; unregistering it restores the previous one", () => {
    const first = registerMediaClock("c", clock(1_000, "live"));
    const second = registerMediaClock("c", clock(2_000, "dvr"));
    expect(playheadWallclock("c")?.getTime()).toBe(2_000);
    expect(playbackMode("c")).toBe("dvr");
    second();
    expect(playheadWallclock("c")?.getTime()).toBe(1_000);
    expect(playbackMode("c")).toBe("live");
    first();
    expect(playheadWallclock("c")).toBeNull();
  });

  it("unregistering an older one keeps the latest; unregistering twice is harmless", () => {
    const source = clock(1_000);
    const first = registerMediaClock("d", source);
    const second = registerMediaClock("d", source);
    const third = registerMediaClock("d", clock(3_000));
    first();
    first();
    expect(playheadWallclock("d")?.getTime()).toBe(3_000);
    third();
    expect(playheadWallclock("d")?.getTime()).toBe(1_000);
    second();
    expect(playheadWallclock("d")).toBeNull();
  });

  it("an invalid date or a throwing source reads as unknown and live", () => {
    const offA = registerMediaClock("e", { playheadWallclock: () => new Date(Number.NaN), playbackMode: () => "live" });
    expect(playheadWallclock("e")).toBeNull();
    offA();
    const offB = registerMediaClock("e", {
      playheadWallclock: () => {
        throw new Error("gone");
      },
      playbackMode: () => {
        throw new Error("gone");
      },
    });
    expect(playheadWallclock("e")).toBeNull();
    expect(playbackMode("e")).toBe("live");
    offB();
  });
});
