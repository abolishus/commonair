// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The watch-room drift controller (decision (r)): hls.js steers with `setTargetLatency` and seeks
 * only over 2 s; WebKit native seeks with about 1 s tolerance; reduced motion widens both; DVR is
 * left alone. The driver is run against a simulated player to show convergence without overshoot.
 */
import { describe, expect, it } from "vite-plus/test";
import { DRIFT, nextCorrection, RoomSyncDriver, type DriftInput, type RoomPlayer } from "../src/player/room-sync.ts";
import { registerRoomPlayer, roomPlayer } from "../src/player/room-sync-registry.ts";

const NOW = 1_800_000_000_000;
const base: DriftInput = {
  playheadMs: NOW - 8000,
  targetMs: NOW - 8000,
  mode: "live",
  native: false,
  steer: true,
  reducedMotion: false,
  appliedLatency: null,
  measuredLatency: 8,
  sinceLastMs: null,
};

describe("nextCorrection", () => {
  it("in sync: nothing", () => {
    expect(nextCorrection(base)).toEqual({ kind: "none", driftMs: 0 });
    expect(nextCorrection({ ...base, playheadMs: NOW - 8000 + DRIFT.deadbandMs })).toMatchObject({ kind: "none" });
  });

  it("no playhead, no target or DVR: nothing", () => {
    expect(nextCorrection({ ...base, playheadMs: null })).toEqual({ kind: "none", driftMs: null });
    expect(nextCorrection({ ...base, targetMs: null })).toEqual({ kind: "none", driftMs: null });
    expect(nextCorrection({ ...base, mode: "dvr", playheadMs: NOW - 60_000 })).toEqual({ kind: "none", driftMs: null });
  });

  it("hls.js ahead: a longer hold-back by exactly the drift", () => {
    const c = nextCorrection({ ...base, playheadMs: NOW - 7000, appliedLatency: 6 });
    expect(c).toEqual({ kind: "latency", seconds: 7, driftMs: 1000 });
  });

  it("hls.js behind: a shorter hold-back; the first step starts from the measured latency", () => {
    const c = nextCorrection({ ...base, playheadMs: NOW - 9000, measuredLatency: 9 });
    expect(c).toEqual({ kind: "latency", seconds: 8, driftMs: -1000 });
  });

  it("hls.js over 2 s: a seek to the target", () => {
    expect(nextCorrection({ ...base, playheadMs: NOW - 5000, appliedLatency: 5 })).toEqual({
      kind: "seek",
      toMs: NOW - 8000,
      driftMs: 3000,
    });
    expect(nextCorrection({ ...base, playheadMs: NOW - 8000 + DRIFT.seekOverMs, appliedLatency: 6 })).toMatchObject({
      kind: "latency",
    });
  });

  it("the hold-back is capped to the controller's range", () => {
    expect(nextCorrection({ ...base, playheadMs: NOW - 6500, targetMs: NOW - 8000, appliedLatency: 59.5 })).toEqual({
      kind: "latency",
      seconds: 60,
      driftMs: 1500,
    });
    expect(nextCorrection({ ...base, playheadMs: NOW - 6500, targetMs: NOW - 8000, appliedLatency: 60 })).toMatchObject(
      {
        kind: "none",
      },
    );
    expect(nextCorrection({ ...base, playheadMs: NOW - 2500, targetMs: NOW - 1000, appliedLatency: 1.2 })).toEqual({
      kind: "latency",
      seconds: 1,
      driftMs: -1500,
    });
  });

  it("WebKit native: seek-only with about 1 s tolerance", () => {
    const n = { ...base, native: true, steer: false };
    expect(nextCorrection({ ...n, playheadMs: NOW - 7100 })).toMatchObject({ kind: "none", driftMs: 900 });
    expect(nextCorrection({ ...n, playheadMs: NOW - 6900 })).toEqual({ kind: "seek", toMs: NOW - 8000, driftMs: 1100 });
  });

  it("without the steering seam: seek-only, tighter than native", () => {
    const f = { ...base, steer: false };
    expect(nextCorrection({ ...f, playheadMs: NOW - 7700 })).toMatchObject({ kind: "none" });
    expect(nextCorrection({ ...f, playheadMs: NOW - 7600 })).toMatchObject({ kind: "seek" });
  });

  it("reduced motion widens the bands", () => {
    const r = { ...base, reducedMotion: true, appliedLatency: 8 };
    expect(nextCorrection({ ...r, playheadMs: NOW - 7700 })).toMatchObject({ kind: "none" });
    expect(nextCorrection({ ...r, playheadMs: NOW - 7500 })).toMatchObject({ kind: "latency" });
    expect(nextCorrection({ ...r, native: true, steer: false, playheadMs: NOW - 6800 })).toMatchObject({
      kind: "none",
    });
    expect(nextCorrection({ ...r, native: true, steer: false, playheadMs: NOW - 6400 })).toMatchObject({
      kind: "seek",
    });
  });

  it("a correction settles before the next one (no overshoot)", () => {
    const ahead = { ...base, playheadMs: NOW - 7000, appliedLatency: 7 };
    expect(nextCorrection({ ...ahead, sinceLastMs: DRIFT.settleMs - 1 })).toMatchObject({ kind: "none" });
    expect(nextCorrection({ ...ahead, sinceLastMs: DRIFT.settleMs })).toMatchObject({ kind: "latency", seconds: 8 });
  });
});

/** A live player whose PDT is `edge - offset - holdBack` once a step settles. */
function simulatedPlayer(opts: { offsetS: number; holdBackS: number; native?: boolean }) {
  let clock = NOW;
  let holdBack = opts.holdBackS;
  let seekOffsetMs = 0;
  const calls: string[] = [];
  const player: RoomPlayer = {
    playheadWallclock: () => new Date(clock - (opts.offsetS + holdBack) * 1000 + seekOffsetMs),
    playbackMode: () => "live",
    ...(opts.native
      ? {}
      : {
          setTargetLatency: (s: number) => {
            calls.push(`latency ${s.toFixed(2)}`);
            holdBack = s;
            seekOffsetMs = 0;
            return s;
          },
        }),
    seekToWallclock: (t: Date) => {
      calls.push("seek");
      seekOffsetMs += t.getTime() - player.playheadWallclock()!.getTime();
      return true;
    },
    native: opts.native ?? false,
  };
  return {
    player,
    calls,
    tick: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("RoomSyncDriver", () => {
  it("hls.js converges into the deadband within two steps and stays there", () => {
    // The encoder's offset (1.5 s) is unknown to the driver; the target is 1.5 s behind this member.
    const sim = simulatedPlayer({ offsetS: 1.5, holdBackS: 4 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    const target = () => new Date(sim.now() - 7000).toISOString();
    const drift = () => Math.abs(sim.player.playheadWallclock()!.getTime() - (sim.now() - 7000));
    expect(driver.onTarget(target()).kind).toBe("latency");
    // The first step starts from the measured latency, so it lands off by the offset...
    expect(drift()).toBe(1500);
    sim.tick(2000);
    // ...and the second, from the hold-back it applied, lands on the target.
    expect(driver.onTarget(target()).kind).toBe("latency");
    for (let i = 0; i < 5; i++) {
      expect(drift()).toBeLessThanOrEqual(DRIFT.deadbandMs);
      sim.tick(2000);
      expect(driver.onTarget(target()).kind).toBe("none");
    }
    expect(sim.calls).toHaveLength(2);
  });

  it("a member joining slower moves the target, and the driver follows; leaving moves it back", () => {
    const sim = simulatedPlayer({ offsetS: 1, holdBackS: 5 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    const at = (behindMs: number) => new Date(sim.now() - behindMs).toISOString();
    driver.onTarget(at(6000));
    sim.tick(2000);
    driver.onTarget(at(7500)); // a slower member joined
    sim.tick(2000);
    driver.onTarget(at(7500));
    expect(Math.abs(sim.player.playheadWallclock()!.getTime() - (sim.now() - 7500))).toBeLessThanOrEqual(150);
    sim.tick(2000);
    driver.onTarget(at(6000)); // they left
    sim.tick(2000);
    driver.onTarget(at(6000));
    expect(Math.abs(sim.player.playheadWallclock()!.getTime() - (sim.now() - 6000))).toBeLessThanOrEqual(150);
  });

  it("native: seeks once into tolerance", () => {
    const sim = simulatedPlayer({ offsetS: 1, holdBackS: 4, native: true });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    expect(driver.onTarget(new Date(sim.now() - 8000).toISOString()).kind).toBe("seek");
    sim.tick(2000);
    expect(driver.onTarget(new Date(sim.now() - 8000).toISOString()).kind).toBe("none");
    expect(sim.calls).toEqual(["seek"]);
  });

  it("targets age with real time; a malformed target or no player does nothing", () => {
    const sim = simulatedPlayer({ offsetS: 1, holdBackS: 4 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    driver.onTarget(new Date(sim.now() - 5000).toISOString());
    sim.tick(1000);
    expect(driver.targetNow()).toBe(sim.now() - 5000);
    expect(driver.onTarget("nope")).toEqual({ kind: "none", driftMs: null });
    const none = new RoomSyncDriver({ player: () => null, reducedMotion: () => false });
    expect(none.onTarget(new Date().toISOString())).toEqual({ kind: "none", driftMs: null });
    driver.reset();
    expect(driver.targetNow()).toBeNull();
  });
});

describe("room player registry", () => {
  it("the registered player steers; native ones cannot; unregistering falls back", () => {
    const calls: string[] = [];
    const source = {
      setTargetLatency: (s: number) => {
        calls.push(`l${s}`);
        return s;
      },
      seekToWallclock: () => true,
      playheadWallclock: () => new Date(NOW),
      playbackMode: () => "live" as const,
    };
    const off = registerRoomPlayer("chan", source, false);
    const p = roomPlayer("chan", null);
    expect(p?.native).toBe(false);
    p?.setTargetLatency?.(5);
    expect(calls).toEqual(["l5"]);
    const offNative = registerRoomPlayer("chan", source, true);
    expect(roomPlayer("chan", null) ?? {}).not.toHaveProperty("setTargetLatency");
    offNative();
    off();
    off();
    expect(roomPlayer("chan", null)).toBeNull();
  });
});
