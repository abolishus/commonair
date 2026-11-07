// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch-room CI run 42333642371: a WebKit member sat 1.63 s behind the room's target for 30 s at
 * normal speed. A rate player behind the target speeds up only with `RATE.minAheadMs` buffered, and
 * under 3 s it never seeks, so either a thin buffer or a rate the decoder could not follow left it
 * there. Members now report where their buffered media ends (chat keeps the target reachable), and
 * rate steering that makes no headway is one seek when the media is buffered.
 */
import { describe, expect, it } from "vite-plus/test";
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import { RATE, roomReport, RoomSyncDriver, type RoomPlayer } from "../src/player/room-sync.ts";
import { registerRoomPlayer, roomSyncReport } from "../src/player/room-sync-registry.ts";

const NOW = 1_800_000_000_000;

describe("the buffered end a member reports", () => {
  const player = (mode: "live" | "dvr", ahead: number | null): RoomPlayer => ({
    playheadWallclock: () => new Date(NOW - 6660),
    playbackMode: () => mode,
    seekToWallclock: () => true,
    native: false,
    bufferAheadMs: () => ahead,
  });

  it("live: the playhead plus what is buffered under it", () => {
    expect(roomReport(player("live", 1200))?.buffered).toEqual(new Date(NOW - 5460));
    expect(roomReport(player("live", 0))?.buffered).toEqual(new Date(NOW - 6660));
  });

  it("null in DVR, without a playhead, with an unknown or invalid buffer, or without the seam", () => {
    expect(roomReport(player("dvr", 1200))?.buffered).toBeNull();
    expect(roomReport({ ...player("live", 1200), playheadWallclock: () => null })?.buffered).toBeNull();
    expect(roomReport(player("live", null))?.buffered).toBeNull();
    expect(roomReport(player("live", Number.NaN))?.buffered).toBeNull();
    expect(roomReport(player("live", -1))?.buffered).toBeNull();
    expect(roomReport({ ...player("live", 1200), bufferAheadMs: undefined })?.buffered).toBeNull();
  });

  it("without a mounted player, the media clock alone and no buffer", () => {
    expect(roomSyncReport("reach-none", null).buffered).toBeNull();
  });

  it("a registered player reports from the page's video element", () => {
    const off = registerRoomPlayer(
      "reach-hls",
      {
        playheadWallclock: () => new Date(NOW - 6660),
        playbackMode: () => "live",
        seekToWallclock: () => true,
        setTargetLatency: (s) => s,
      },
      false,
    );
    const ranges = { length: 1, start: () => 10, end: () => 11.2 };
    const video = { currentTime: 10, buffered: ranges, seekable: ranges };
    const doc = { querySelector: () => video } as unknown as Document;
    expect(roomSyncReport("reach-hls", doc).buffered).toEqual(new Date(NOW - 5460));
    off();
  });

  it("the client's speed-up spare is the one chat keeps the target short of", () => {
    expect(RATE.minAheadMs).toBe(ROOM_LIMITS.syncSpareMs);
  });
});

/**
 * A rate player 6.66 s behind live whose target is 5 s behind: `honoursRate` false plays at 1x
 * whatever rate is set (a decoder that cannot play faster), true follows it.
 */
function ratePlayer(opts: { honoursRate: boolean; aheadMs: number }) {
  let clock = NOW;
  let head = NOW - 6660;
  let rate = 1;
  const seeks: number[] = [];
  const player: RoomPlayer = {
    playheadWallclock: () => new Date(head),
    playbackMode: () => "live",
    seekToWallclock: () => false,
    seekBy: (ms) => {
      seeks.push(ms);
      head += ms;
      return true;
    },
    setTargetLatency: (s) => s,
    latencySeconds: () => (clock - head) / 1000,
    setPlaybackRate: (r) => {
      rate = r;
      return true;
    },
    bufferAheadMs: () => opts.aheadMs,
    native: false,
  };
  const advance = (ms: number) => {
    head += ms * (opts.honoursRate ? rate : 1);
    clock += ms;
  };
  return { player, seeks, advance, now: () => clock, drift: () => head - (clock - 5000), rate: () => rate };
}

/** Targets every 2 s for `seconds`, the playhead advancing in between. */
function play(sim: ReturnType<typeof ratePlayer>, driver: RoomSyncDriver, seconds: number): void {
  for (let t = 0; t < seconds; t += 2) {
    driver.onTarget(new Date(sim.now() - 5000).toISOString());
    sim.advance(2000);
  }
}

describe("rate steering that makes no headway", () => {
  it("a rate the player does not follow ends in one seek to the target, with the media buffered there", () => {
    const sim = ratePlayer({ honoursRate: false, aheadMs: 6000 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    play(sim, driver, 30);
    expect(sim.seeks).toHaveLength(1);
    expect(Math.abs(sim.drift())).toBeLessThan(500);
  });

  it("before the fix's evidence threshold it keeps steering: no seek in the first seconds", () => {
    const sim = ratePlayer({ honoursRate: false, aheadMs: 6000 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    play(sim, driver, 4);
    expect(sim.seeks).toEqual([]);
    expect(sim.rate()).toBeGreaterThan(1);
  });

  it("a rate the player follows closes the drift without a seek", () => {
    const sim = ratePlayer({ honoursRate: true, aheadMs: 6000 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    play(sim, driver, 30);
    expect(sim.seeks).toEqual([]);
    expect(Math.abs(sim.drift())).toBeLessThan(150);
  });

  it("with too little buffered it neither speeds up nor seeks (chat's reach bound moves the target instead)", () => {
    const sim = ratePlayer({ honoursRate: true, aheadMs: 1200 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    play(sim, driver, 30);
    expect(sim.seeks).toEqual([]);
    expect(sim.rate()).toBe(1);
    expect(roomReport(sim.player)?.buffered?.getTime()).toBe(sim.player.playheadWallclock()!.getTime() + 1200);
  });

  it("a drift that changes side was closed: steering starts over, no seek", () => {
    let head = NOW - 6660;
    let clock = NOW;
    let rate = 1;
    const seeks: number[] = [];
    const player: RoomPlayer = {
      playheadWallclock: () => new Date(head),
      playbackMode: () => "live",
      seekToWallclock: () => false,
      seekBy: (ms) => {
        seeks.push(ms);
        return true;
      },
      setPlaybackRate: (r) => {
        rate = r;
        return true;
      },
      bufferAheadMs: () => 6000,
      native: false,
    };
    const driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: () => clock });
    // It overshoots by a lot each time (a rate far stronger than asked): side flips every target.
    for (let i = 0; i < 15; i++) {
      driver.onTarget(new Date(clock - 5000).toISOString());
      const drift = head - (clock - 5000);
      head += 2000 + (rate === 1 ? 0 : -2 * drift);
      clock += 2000;
    }
    expect(seeks).toEqual([]);
  });

  it("leaving the room forgets the steering", () => {
    const sim = ratePlayer({ honoursRate: false, aheadMs: 6000 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    play(sim, driver, 4);
    driver.reset();
    expect(sim.rate()).toBe(1);
    play(sim, driver, 4);
    expect(sim.seeks).toEqual([]);
  });
});
