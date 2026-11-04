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
          setTargetLatency: (s: number, o?: { seek?: boolean }) => {
            if (o?.seek === false) {
              // Holds the new distance from here on, without moving the playhead now.
              calls.push(`hold ${s.toFixed(2)}`);
              seekOffsetMs += (s - holdBack) * 1000;
              holdBack = s;
              return s;
            }
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
  it("hls.js lands in the deadband in one step and stays there", () => {
    // The encoder's offset (1.5 s) is unknown to the driver; the target is 1.5 s behind this member.
    const sim = simulatedPlayer({ offsetS: 1.5, holdBackS: 4 });
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    const target = () => new Date(sim.now() - 7000).toISOString();
    const drift = () => Math.abs(sim.player.playheadWallclock()!.getTime() - (sim.now() - 7000));
    expect(driver.onTarget(target()).kind).toBe("latency");
    // The playhead lands from the PDT, so the offset plays no part.
    for (let i = 0; i < 5; i++) {
      expect(drift()).toBeLessThanOrEqual(DRIFT.deadbandMs);
      sim.tick(2000);
      expect(driver.onTarget(target()).kind).toBe("none");
    }
    // The hold-back is the wall-clock estimate (5.5 s) plus the drift; the playhead then seeks.
    expect(sim.calls).toEqual(["hold 7.00", "seek"]);
  });

  it("with the player's own latency, the hold-back is that latency plus the drift", () => {
    const sim = simulatedPlayer({ offsetS: 1.5, holdBackS: 4 });
    let holdBack = 4;
    const player: RoomPlayer = {
      ...sim.player,
      setTargetLatency: (sec, opts) => (holdBack = sim.player.setTargetLatency!(sec, opts)),
      latencySeconds: () => holdBack,
    };
    const driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: sim.now });
    expect(driver.onTarget(new Date(sim.now() - 7000).toISOString()).kind).toBe("latency");
    expect(Math.abs(player.playheadWallclock()!.getTime() - (sim.now() - 7000))).toBeLessThanOrEqual(1);
    expect(sim.calls).toEqual(["hold 5.50", "seek"]);
  });

  it("hls.js: when the PDT seek finds no fragment, the step falls back to hls.js's sync position", () => {
    const sim = simulatedPlayer({ offsetS: 1.5, holdBackS: 4 });
    const player: RoomPlayer = { ...sim.player, seekToWallclock: () => false };
    const driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: sim.now });
    expect(driver.onTarget(new Date(sim.now() - 7000).toISOString()).kind).toBe("latency");
    expect(sim.calls).toEqual(["hold 7.00", "latency 7.00"]);
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

  it("hls.js lands on the target in PDT even when its own edge estimate moves between steps", () => {
    // hls.js's sync position is measured from this member's own edge estimate (`edge + age`), which
    // shifts by hundreds of ms between steps: a rendition switch, a playlist reload landing late,
    // `edgeStalled`. CI run 41757992200 (edge-sync): one member read its own latency as ~4.9 s while
    // it sat 5.7 s behind the room's edge, and the two stayed 0.5-1.1 s apart after 30 s. A step
    // that seeks to the sync position lands off by the shift; one that lands from the playhead
    // (PDT is linear in media time) does not.
    let clock = NOW;
    let edgeLagMs = 1500; // how far this member's own edge estimate trails the room's edge
    let behindMs = 3000 + edgeLagMs; // the playhead, behind `clock`
    let holdBack = 3;
    const calls: string[] = [];
    const player: RoomPlayer = {
      playheadWallclock: () => new Date(clock - behindMs),
      playbackMode: () => "live",
      setTargetLatency: (s: number, opts?: { seek?: boolean }) => {
        calls.push(opts?.seek === false ? `hold ${s.toFixed(2)}` : `latency ${s.toFixed(2)}`);
        holdBack = s;
        if (opts?.seek !== false) behindMs = edgeLagMs + s * 1000;
        return s;
      },
      latencySeconds: () => (behindMs - edgeLagMs) / 1000,
      seekToWallclock: (t: Date) => {
        calls.push("seek");
        behindMs = clock - t.getTime();
        return true;
      },
      native: false,
    };
    const driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: () => clock });
    // The room's target moves by a second each tick (members joining, leaving, re-steering), so
    // every tick is a correction, each made while the estimate sits somewhere else.
    let roomBehindMs = 6500;
    const drift = () => Math.abs(player.playheadWallclock()!.getTime() - (clock - roomBehindMs));
    for (let i = 0; i < 8; i++) {
      expect(driver.onTarget(new Date(clock - roomBehindMs).toISOString()).kind).toBe("latency");
      expect(drift()).toBeLessThanOrEqual(DRIFT.deadbandMs);
      clock += 2000;
      // The estimate shifts by 700 ms and back (a rendition switch); the playhead does not move.
      edgeLagMs = edgeLagMs === 1500 ? 2200 : 1500;
      roomBehindMs = roomBehindMs === 6500 ? 7500 : 6500;
    }
    // Each step held the new distance and landed from the playhead.
    expect(calls.slice(0, 4)).toEqual(["hold 5.00", "seek", "hold 6.00", "seek"]);
    expect(Number.isFinite(holdBack)).toBe(true);
  });

  it("hls.js: a seek over 2 s also moves the hold-back, so hls.js does not keep the old one", () => {
    const sim = simulatedPlayer({ offsetS: 0, holdBackS: 9 });
    let holdBack = 9;
    const player: RoomPlayer = {
      ...sim.player,
      setTargetLatency: (sec, opts) => (holdBack = sim.player.setTargetLatency!(sec, opts)),
      latencySeconds: () => holdBack,
    };
    const driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: sim.now });
    expect(driver.onTarget(new Date(sim.now() - 5000).toISOString()).kind).toBe("seek");
    expect(Math.abs(player.playheadWallclock()!.getTime() - (sim.now() - 5000))).toBeLessThanOrEqual(1);
    expect(sim.calls).toEqual(["seek", "hold 5.00"]);
    expect(holdBack).toBe(5);
  });

  /**
   * hls.js once ABR loads another level: the playing level's fragment list is no longer refreshed,
   * so `seekToWallclock` (which maps through it) misses a target past its end (false), while the
   * playhead itself can still move by any amount within the seekable range.
   */
  function staleLevelPlayer(behindS: number) {
    let clock = NOW;
    let behindMs = behindS * 1000;
    let holdBack = behindS;
    const calls: string[] = [];
    const player: RoomPlayer = {
      playheadWallclock: () => new Date(clock - behindMs),
      playbackMode: () => "live",
      setTargetLatency: (s: number, o?: { seek?: boolean }) => {
        calls.push(o?.seek === false ? `hold ${s.toFixed(2)}` : `latency ${s.toFixed(2)}`);
        holdBack = s;
        return s;
      },
      latencySeconds: () => behindMs / 1000,
      seekToWallclock: () => {
        calls.push("seekToWallclock");
        return false;
      },
      seekBy: (ms: number) => {
        calls.push(`seekBy ${ms}`);
        behindMs -= ms;
        return true;
      },
      native: false,
    };
    return { player, calls, holdBack: () => holdBack, tick: (ms: number) => (clock += ms), now: () => clock };
  }

  it("hls.js far behind with a stale level: lands by seekBy, not seekToWallclock (CI run 41761738970)", () => {
    // edge-sync: the far member (9 s) was 4 s behind the target; seekToWallclock found nothing in
    // the stale fragment list, so the member was never pulled up (near 9.4 s, far 7.2 s behind the edge).
    const sim = staleLevelPlayer(9);
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    expect(driver.onTarget(new Date(sim.now() - 5000).toISOString()).kind).toBe("seek");
    expect(sim.player.playheadWallclock()!.getTime()).toBe(sim.now() - 5000);
    expect(sim.calls).toEqual(["seekBy 4000", "hold 5.00"]);
    sim.tick(2000);
    expect(driver.onTarget(new Date(sim.now() - 5000).toISOString()).kind).toBe("none");
  });

  it("hls.js small step with a stale level: lands by seekBy", () => {
    const sim = staleLevelPlayer(3);
    const driver = new RoomSyncDriver({ player: () => sim.player, reducedMotion: () => false, now: sim.now });
    expect(driver.onTarget(new Date(sim.now() - 4000).toISOString()).kind).toBe("latency");
    expect(sim.player.playheadWallclock()!.getTime()).toBe(sim.now() - 4000);
    expect(sim.calls).toEqual(["hold 4.00", "seekBy -1000"]);
  });

  it("hls.js far behind when neither seek can: steps to hls.js's sync position instead of staying put", () => {
    const sim = staleLevelPlayer(9);
    const player: RoomPlayer = { ...sim.player };
    delete player.seekBy;
    const driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: sim.now });
    expect(driver.onTarget(new Date(sim.now() - 5000).toISOString()).kind).toBe("seek");
    expect(sim.calls).toEqual(["seekToWallclock", "latency 5.00"]);
    expect(sim.holdBack()).toBe(5);
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
    expect(p).not.toHaveProperty("seekBy");
    const offBy = registerRoomPlayer(
      "chan",
      { ...source, seekBy: (ms: number) => (calls.push(`b${ms}`), true) },
      false,
    );
    expect(roomPlayer("chan", null)?.seekBy?.(250)).toBe(true);
    expect(calls).toEqual(["l5", "b250"]);
    offBy();
    const offNative = registerRoomPlayer("chan", source, true);
    expect(roomPlayer("chan", null) ?? {}).not.toHaveProperty("setTargetLatency");
    offNative();
    off();
    off();
    expect(roomPlayer("chan", null)).toBeNull();
  });
});
