// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch-room rate steering (room-sync.ts `RATE`): hls.js members with a playback-rate seam close
 * drifts by playing faster or slower, seek only past `RATE.seekOverMs` and at most once per
 * cooldown, and steer to the median of the latest targets. Then a simulation of harness
 * `watch-room` `edge-sync` calibrated from the busy CI runner of exp/sync-diag (run 41905217763):
 * each seek leaves the element waiting ~1.2-2 s, chat's target jumps by up to ±0.6 s from frame
 * to frame, members report every 2 s. The seek-per-tick driver failed there; this one must not.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  nextCorrection,
  RATE,
  RoomSyncDriver,
  TARGET_MEDIAN_OF,
  type DriftInput,
  type RoomPlayer,
} from "../src/player/room-sync.ts";

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
  rate: true,
  sinceSeekMs: null,
};
const at = (driftMs: number, extra: Partial<DriftInput> = {}) =>
  nextCorrection({ ...base, playheadMs: NOW - 8000 + driftMs, ...extra });

describe("nextCorrection with a rate seam", () => {
  it("behind: faster, by the drift over the horizon, within the bounds", () => {
    expect(at(-400)).toEqual({ kind: "rate", rate: 1.1, driftMs: -400 });
    expect(at(-2000)).toEqual({ kind: "rate", rate: RATE.max, driftMs: -2000 });
  });

  it("ahead: slower, within the bounds", () => {
    expect(at(400)).toEqual({ kind: "rate", rate: 0.9, driftMs: 400 });
    expect(at(2500)).toEqual({ kind: "rate", rate: RATE.min, driftMs: 2500 });
  });

  it("inside the deadband: normal speed (reduced motion widens it)", () => {
    expect(at(-RATE.deadbandMs)).toEqual({ kind: "rate", rate: 1, driftMs: -RATE.deadbandMs });
    expect(at(-200)).toMatchObject({ kind: "rate", rate: 1.05 });
    expect(at(-200, { reducedMotion: true })).toMatchObject({ kind: "rate", rate: 1 });
  });

  it("no settle between targets: a rate is set afresh every time", () => {
    expect(at(-1000, { sinceLastMs: 100 })).toMatchObject({ kind: "rate", rate: 1.25 });
  });

  it("past the seek threshold: one seek, then rate only until the cooldown is over", () => {
    expect(at(-RATE.seekOverMs - 1)).toEqual({ kind: "seek", toMs: NOW - 8000, driftMs: -RATE.seekOverMs - 1 });
    expect(at(-5000, { sinceSeekMs: RATE.seekCooldownMs - 1 })).toMatchObject({ kind: "rate", rate: RATE.max });
    expect(at(-5000, { sinceSeekMs: RATE.seekCooldownMs })).toMatchObject({ kind: "seek" });
    // Under the threshold, never a seek, however long since the last one.
    expect(at(-RATE.seekOverMs)).toMatchObject({ kind: "rate" });
  });

  it("behind with a thin buffer: normal speed, never faster than the media arrives", () => {
    expect(at(-1000, { aheadMs: RATE.minAheadMs - 1 })).toEqual({ kind: "rate", rate: 1, driftMs: -1000 });
    expect(at(-1000, { aheadMs: RATE.minAheadMs })).toMatchObject({ kind: "rate", rate: 1.25 });
    // Ahead of the target, slowing down needs no buffer.
    expect(at(1000, { aheadMs: 0 })).toMatchObject({ kind: "rate", rate: 0.8 });
  });

  it("a forward seek only into buffered media, with a second to spare; else rate steering", () => {
    expect(at(-4000, { aheadMs: 5000 })).toMatchObject({ kind: "seek" });
    expect(at(-4000, { aheadMs: 4999 })).toMatchObject({ kind: "rate", rate: RATE.max });
    expect(at(-4000, { aheadMs: 1000 })).toMatchObject({ kind: "rate", rate: 1 });
    // Backward seeks land on media already played through: no limit.
    expect(at(4000, { aheadMs: 0 })).toMatchObject({ kind: "seek" });
  });

  it("native WebKit ignores the rate seam (seek only)", () => {
    expect(at(-1500, { native: true, steer: false })).toMatchObject({ kind: "seek" });
  });

  it("DVR and unknowns: nothing", () => {
    expect(at(0, { mode: "dvr" })).toEqual({ kind: "none", driftMs: null });
    expect(at(0, { playheadMs: null })).toEqual({ kind: "none", driftMs: null });
  });
});

/** A player whose calls are recorded; the playhead does not move on its own. */
function recordingPlayer(behindMs: number, opts: { refuseRate?: boolean } = {}) {
  let clock = NOW;
  const calls: string[] = [];
  let mode: "live" | "dvr" = "live";
  let rate = 1;
  const player: RoomPlayer = {
    playheadWallclock: () => new Date(clock - behindMs),
    playbackMode: () => mode,
    setTargetLatency: (s: number, o?: { seek?: boolean }) => {
      calls.push(`${o?.seek === false ? "hold" : "latency"} ${s.toFixed(2)}`);
      return s;
    },
    latencySeconds: () => behindMs / 1000 - 1,
    seekToWallclock: () => (calls.push("seekToWallclock"), true),
    seekBy: (ms: number) => {
      calls.push(`seekBy ${ms}`);
      behindMs -= ms;
      return true;
    },
    setPlaybackRate: (r: number) => {
      if (opts.refuseRate) return false;
      calls.push(`rate ${r}`);
      rate = r;
      return true;
    },
    native: false,
  };
  const driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: () => clock });
  return {
    player,
    driver,
    calls,
    rate: () => rate,
    tick: (targetBehindMs: number, ms = 2000) => {
      const c = driver.onTarget(new Date(clock - targetBehindMs).toISOString());
      clock += ms;
      return c;
    },
    setMode: (m: "live" | "dvr") => (mode = m),
    setBehind: (ms: number) => (behindMs = ms),
  };
}

describe("RoomSyncDriver with a rate seam", () => {
  it("a 2 s drift is played off, not seeked; the hold-back follows without a seek", () => {
    const p = recordingPlayer(8000);
    p.tick(6000);
    expect(p.calls).toEqual(["rate 1.25", "hold 5.00"]);
    expect(p.calls.some((c) => c.startsWith("seek") || c.startsWith("latency"))).toBe(false);
  });

  it("a member joining 5 s off seeks once, at normal speed, then steers by rate", () => {
    const p = recordingPlayer(11_000);
    expect(p.tick(6000).kind).toBe("seek");
    expect(p.calls[0]).toBe("seekBy 5000");
    // Still 2 s behind after the seek's stall: rate, not another seek.
    p.setBehind(10_000);
    expect(p.tick(6000)).toMatchObject({ kind: "rate", rate: RATE.max });
    p.setBehind(10_000);
    expect(p.tick(6000).kind).toBe("rate");
    expect(p.calls.filter((c) => c.startsWith("seek"))).toHaveLength(1);
  });

  it("normal speed again in DVR and on leaving the room", () => {
    const p = recordingPlayer(7000);
    p.tick(6000);
    expect(p.rate()).toBe(1.25);
    p.setMode("dvr");
    p.tick(6000);
    expect(p.rate()).toBe(1);
    p.setMode("live");
    p.tick(6000);
    expect(p.rate()).toBe(1.25);
    p.driver.reset();
    expect(p.rate()).toBe(1);
  });

  it("steers to the median of the latest targets: one outlier moves nothing", () => {
    const p = recordingPlayer(6000);
    for (let i = 0; i < TARGET_MEDIAN_OF - 1; i++) expect(p.tick(6000)).toMatchObject({ rate: 1 });
    // Chat's edge estimate jumps 1.5 s for one frame.
    expect(p.tick(4500)).toMatchObject({ kind: "rate", rate: 1, driftMs: 0 });
  });

  it("a refused rate changes nothing and is tried again on the next target", () => {
    const p = recordingPlayer(8000, { refuseRate: true });
    expect(p.tick(6000)).toMatchObject({ kind: "rate", rate: 1.25 });
    expect(p.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- simulation

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP = 50;
const TICK = 2000;
const CAP = 5000;

class Member {
  pos: number;
  rate = 1;
  stallUntil = 0;
  seeks = 0;
  readonly frames: { at: number; pdt: number }[] = [];
  readonly driver: RoomSyncDriver;
  readonly phase: number;

  constructor(
    private readonly sim: Sim,
    behindMs: number,
  ) {
    this.pos = sim.clock - behindMs;
    const player: RoomPlayer = {
      playheadWallclock: () => new Date(this.pos),
      playbackMode: () => "live",
      // The hold-back only matters to hls.js's own start-up and stalls, which the model leaves out.
      setTargetLatency: (s: number) => s,
      // hls.js's latency, from its own (noisy) edge estimate.
      latencySeconds: () => (sim.edge() - this.pos) / 1000 + (sim.random() - 0.5) * 0.6,
      seekToWallclock: (t: Date) => this.seek(t.getTime()),
      seekBy: (ms: number) => this.seek(this.pos + ms),
      ...(sim.rateSeam ? { setPlaybackRate: (r: number) => ((this.rate = r), true) } : {}),
      bufferAheadMs: () => Math.max(0, sim.available() - this.pos),
      native: false,
    };
    this.driver = new RoomSyncDriver({ player: () => player, reducedMotion: () => false, now: () => sim.clock });
    this.phase = Math.floor((sim.random() * TICK) / STEP) * STEP;
  }

  waitedMs = 0;

  seek(to: number): boolean {
    this.pos = Math.min(to, this.sim.edge() - 500);
    const [lo, hi] = this.sim.stallMs;
    this.stallUntil = this.sim.clock + lo + this.sim.random() * (hi - lo);
    this.seeks++;
    return true;
  }

  advance(): void {
    if (this.sim.clock < this.stallUntil) return;
    // Nothing to play past what has arrived: the element waits.
    if (this.pos >= this.sim.available()) {
      this.waitedMs += STEP;
      return;
    }
    this.pos = Math.min(this.pos + STEP * this.rate, this.sim.available());
  }
}

class Sim {
  clock = NOW;
  readonly start = NOW;
  readonly random: () => number;
  readonly members: Member[] = [];
  constructor(
    seed: number,
    readonly stallMs: [number, number],
    readonly targetNoiseMs: number,
    readonly rateSeam = true,
  ) {
    this.random = prng(seed);
  }
  edge(): number {
    return this.clock - 1000;
  }
  /** The newest media the player has: delivery trails the edge by 1.5 s. */
  available(): number {
    return this.edge() - 1500;
  }
  join(behindMs: number): Member {
    const m = new Member(this, behindMs);
    this.members.push(m);
    return m;
  }
  /** Chat's target: the slowest member, capped 5 s behind a noisy edge estimate. */
  target(): number {
    const heads = this.members.map((m) => {
      const f = m.frames.at(-1);
      return f ? f.pdt + (this.clock - f.at) : m.pos;
    });
    const edge = this.edge() + (this.random() - 0.5) * 2 * this.targetNoiseMs;
    return Math.max(Math.min(...heads), edge - CAP);
  }
  run(ms: number): void {
    const end = this.clock + ms;
    while (this.clock < end) {
      this.clock += STEP;
      for (const m of this.members) m.advance();
      const t = this.clock - this.start;
      for (const m of this.members) if ((t - m.phase) % TICK === 0) m.frames.push({ at: this.clock, pdt: m.pos });
      if ((t - 600) % TICK === 0) {
        const target = new Date(this.target()).toISOString();
        for (const m of this.members) m.driver.onTarget(target);
      }
    }
  }
}

/** The harness's figure: the spread of the frames' extrapolated playheads, p90 over 8 s. */
function p90Spread(members: readonly Member[], end: number): number {
  const spreads: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t = end - i * 1000;
    const heads = members.map((m) => {
      const f = [...m.frames].reverse().find((x) => x.at <= t);
      return f ? f.pdt + (t - f.at) : Number.NaN;
    });
    spreads.push(Math.max(...heads) - Math.min(...heads));
  }
  spreads.sort((a, b) => a - b);
  return spreads[Math.ceil(spreads.length * 0.9) - 1] ?? Number.NaN;
}

function edgeSync(seed: number, rateSeam = true) {
  const sim = new Sim(seed, [1200, 2000], 600, rateSeam);
  const near = sim.join(3000);
  const far = sim.join(9000);
  sim.run(30_000);
  const chromium = p90Spread([near, far], sim.clock);
  const behind = [near, far].map((m) => sim.edge() + 1000 - m.pos);
  const webkit = sim.join(6500);
  sim.run(30_000);
  const withWebkit = Math.max(p90Spread([near, webkit], sim.clock), p90Spread([far, webkit], sim.clock));
  return {
    chromium,
    withWebkit,
    behind,
    seeks: sim.members.map((m) => m.seeks),
    waited: sim.members.map((m) => m.waitedMs),
  };
}

describe("edge-sync, simulated on the busy runner's numbers", () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

  it("every seed: Chromium under 500 ms, WebKit under 1 s, both within the cap, one seek and 1 s waiting at most", () => {
    const bad = SEEDS.map((s) => ({ s, o: edgeSync(s) })).filter(
      ({ o }) =>
        o.chromium >= 500 ||
        o.withWebkit >= 1000 ||
        o.behind.some((b) => b > CAP + 1500) ||
        o.seeks.some((n) => n > 1) ||
        o.waited.some((w) => w > 1000),
    );
    expect(bad).toEqual([]);
  });

  it("the model reproduces CI: without the rate seam (a seek per tick) most seeds fail", () => {
    const outcomes = SEEDS.map((s) => edgeSync(s, false));
    expect(outcomes.filter((o) => o.chromium >= 500 || o.behind.some((b) => b > CAP + 1500)).length).toBeGreaterThan(
      SEEDS.length / 2,
    );
  });
});
