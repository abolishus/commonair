// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * harness `watch-room` `edge-sync`, replayed deterministically through the real `RoomSyncDriver`
 * with a player model calibrated from the CI trajectories (`edgeSyncTrajectory`):
 *
 * - Two Chromium (hls.js) members start 3 s and 9 s behind live; chat's target is the slowest
 *   member capped 5 s behind `max(edgeWallclock)`, sent every 2 s; members report every 2 s.
 * - A seek costs a stall: the playhead stops while the decoder refills. Measured as the playhead
 *   lost between a correction and the member's next frame (~1.2-1.7 s later): ~320 ms on the run
 *   where the Chromium check passed (41768120276), ~750 ms (106-1702) on the one where both members
 *   ended 6.1/6.8 s behind the edge (41771305439). Playback itself is slightly slow (a few %).
 * - WebKit (native) seeks also land ~1.3 s short (41768120276: 1.6 s from both members at p90).
 * - Each member's edge estimate is off by a fixed bias and per-report noise.
 *
 * The harness's three assertions are checked on the same frames the harness would see: both
 * Chromium members within cap + 1.5 s of the room's edge, their p90 spread under 500 ms, and
 * WebKit's p90 spread to each under 1 s.
 */
import { describe, expect, it } from "vite-plus/test";
import { RoomSyncDriver, type RoomPlayer } from "../src/player/room-sync.ts";

const CAP_MS = 5000;
const EDGE_SLACK_MS = 1500;
const TICK_MS = 2000;
const STEP_MS = 50;
/** The PDT at the true live edge trails the wall clock by the packaging delay. */
const EDGE_DELAY_MS = 1000;

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

export interface Calibration {
  /** A seek's stall (ms), drawn uniformly from this range. */
  stallMs: [number, number];
  /** Playback runs this much slower than real time (fraction). */
  deficit: number;
  /** Native seeks land this far short of their aim (ms), plus up to ±200 ms. */
  nativeMissMs: number;
}

interface Frame {
  sentAt: number;
  pdt: number;
  edge: number;
}

class SimMember {
  pos: number;
  rate = 1;
  stallUntil = 0;
  holdS: number;
  readonly frames: Frame[] = [];
  readonly player: RoomPlayer;
  seeks = 0;

  constructor(
    private readonly sim: Sim,
    readonly label: string,
    behindMs: number,
    readonly native: boolean,
    private readonly edgeBiasMs: number,
  ) {
    this.pos = sim.edge() - behindMs;
    this.holdS = behindMs / 1000;
    const base = {
      playheadWallclock: () => new Date(this.pos),
      playbackMode: () => "live" as const,
      seekToWallclock: (t: Date) => this.seek(t.getTime()),
      seekBy: (ms: number) => this.seek(this.pos + ms),
      native,
    };
    const steering = native
      ? {}
      : {
          setTargetLatency: (s: number, o?: { seek?: boolean }) => {
            this.holdS = s;
            if (o?.seek !== false) this.seek(this.ownEdge() - s * 1000);
            return s;
          },
          latencySeconds: () => (this.ownEdge() - this.pos) / 1000,
        };
    const rate = sim.rateSeam ? { setPlaybackRate: (r: number) => ((this.rate = r), true) } : {};
    this.player = { ...base, ...steering, ...rate } as RoomPlayer;
  }

  ownEdge(): number {
    return this.sim.edge() + this.edgeBiasMs;
  }

  seek(to: number): boolean {
    const r = this.sim.random;
    const miss = this.native ? -(this.sim.cal.nativeMissMs + (r() - 0.5) * 400) : 0;
    this.pos = Math.min(to + miss, this.sim.edge() - 500);
    const [lo, hi] = this.sim.cal.stallMs;
    this.stallUntil = this.sim.clock + lo + r() * (hi - lo);
    this.seeks++;
    return true;
  }

  advance(dt: number): void {
    if (this.sim.clock < this.stallUntil) return;
    this.pos = Math.min(this.pos + dt * this.rate * (1 - this.sim.cal.deficit), this.sim.edge());
  }

  report(): void {
    const noise = (this.sim.random() - 0.5) * 300;
    this.frames.push({ sentAt: this.sim.clock, pdt: this.pos, edge: this.ownEdge() + noise });
  }
}

class Sim {
  clock = 1_800_000_000_000;
  readonly start = this.clock;
  readonly random: () => number;
  readonly members: { m: SimMember; driver: RoomSyncDriver; phase: number }[] = [];

  constructor(
    readonly cal: Calibration,
    seed: number,
    readonly rateSeam: boolean,
  ) {
    this.random = prng(seed);
  }

  edge(): number {
    return this.clock - EDGE_DELAY_MS;
  }

  join(label: string, behindMs: number, native: boolean): SimMember {
    const m = new SimMember(this, label, behindMs, native, (this.random() - 0.5) * 800);
    const driver = new RoomSyncDriver({ player: () => m.player, reducedMotion: () => false, now: () => this.clock });
    // Report on the simulation's grid, at a random phase of the 2 s tick (relative to now).
    const phase = (this.clock - this.start + Math.floor((this.random() * TICK_MS) / STEP_MS) * STEP_MS) % TICK_MS;
    this.members.push({ m, driver, phase });
    return m;
  }

  /** Chat's target from the latest report of each member (extrapolated), as `syncState` does. */
  target(): number | null {
    const heads: number[] = [];
    const edges: number[] = [];
    for (const { m } of this.members) {
      const f = m.frames.at(-1);
      if (!f || this.clock - f.sentAt > 10_000) continue;
      const age = this.clock - f.sentAt;
      heads.push(f.pdt + age);
      edges.push(f.edge + age);
    }
    if (heads.length === 0) return null;
    const edge = Math.max(...heads, ...edges);
    return Math.max(Math.min(...heads), edge - CAP_MS);
  }

  run(ms: number): void {
    const end = this.clock + ms;
    while (this.clock < end) {
      this.clock += STEP_MS;
      for (const { m } of this.members) m.advance(STEP_MS);
      const t = this.clock - this.start;
      for (const { m, phase } of this.members) if ((t - phase) % TICK_MS === 0) m.report();
      if ((t - 600) % TICK_MS === 0) {
        const target = this.target();
        if (target !== null) for (const { driver } of this.members) driver.onTarget(new Date(target).toISOString());
      }
    }
  }
}

/** The harness's extrapolation: each member's latest frame at `at`, no older than 4.5 s. */
function latest(frames: readonly Frame[], at: number): Frame | null {
  let out: Frame | null = null;
  for (const f of frames) if (f.sentAt <= at && (!out || f.sentAt > out.sentAt)) out = f;
  return out && at - out.sentAt <= 4500 ? out : null;
}

/** `summarizeDelta`'s p90 over 8 instants 1 s apart ending at `end`. */
function p90Spread(members: readonly SimMember[], end: number): number {
  const spreads: number[] = [];
  for (let i = 0; i < 8; i++) {
    const at = end - i * 1000;
    const heads = members.map((m) => {
      const f = latest(m.frames, at);
      return f ? f.pdt + (at - f.sentAt) : Number.NaN;
    });
    spreads.push(Math.max(...heads) - Math.min(...heads));
  }
  spreads.sort((a, b) => a - b);
  return spreads[Math.ceil(spreads.length * 0.9) - 1] ?? Number.NaN;
}

/** `behindRoomEdgeAt`: `max` of the reported edges minus each member's playhead. */
function behindEdge(members: readonly SimMember[], at: number): number[] {
  const fs = members.map((m) => latest(m.frames, at));
  const edge = Math.max(...fs.map((f) => (f ? f.edge + (at - f.sentAt) : Number.NEGATIVE_INFINITY)));
  return fs.map((f) => (f ? edge - (f.pdt + (at - f.sentAt)) : Number.POSITIVE_INFINITY));
}

export interface EdgeSyncOutcome {
  behind: number[];
  chromiumP90: number;
  webkitP90: number[];
}

/** The step: near 3 s and far 9 s behind, 30 s together after both play; then WebKit, 30 s. */
export function edgeSync(cal: Calibration, seed: number, rateSeam: boolean): EdgeSyncOutcome {
  const sim = new Sim(cal, seed, rateSeam);
  const near = sim.join("near", 3000, false);
  sim.run(2000);
  const far = sim.join("far", 9000, false);
  sim.run(2000 + 30_000 + 6000);
  const behind = behindEdge([near, far], sim.clock);
  const chromiumP90 = p90Spread([near, far], sim.clock);
  sim.run(3000);
  const webkit = sim.join("webkit", 6500, true);
  sim.run(2000 + 30_000);
  const webkitP90 = [p90Spread([near, webkit], sim.clock), p90Spread([far, webkit], sim.clock)];
  return { behind, chromiumP90, webkitP90 };
}

export function passes(o: EdgeSyncOutcome): boolean {
  return (
    o.behind.every((b) => b <= CAP_MS + EDGE_SLACK_MS) && o.chromiumP90 < 500 && o.webkitP90.every((p) => p < 1000)
  );
}

/** Seek stalls as measured on CI: the lighter run (Chromium passed) and the heavier one. */
export const CALIBRATIONS: Record<string, Calibration> = {
  light: { stallMs: [0, 600], deficit: 0.03, nativeMissMs: 1300 },
  heavy: { stallMs: [100, 1500], deficit: 0.05, nativeMissMs: 1300 },
};

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

describe("edge-sync, simulated", () => {
  for (const [name, cal] of Object.entries(CALIBRATIONS)) {
    it(`${name} CI load: every edge-sync assertion holds on all ${SEEDS.length} seeds`, () => {
      const failed = SEEDS.map((s) => ({ s, o: edgeSync(cal, s, true) })).filter(({ o }) => !passes(o));
      expect(failed).toEqual([]);
    });
  }

  it("the mechanism: without the rate seam, seek stalls fail the Chromium check on most heavy-load seeds", () => {
    // Every small correction is then a seek, and each seek's stall undoes about what it corrected
    // (CI run 41771305439: both members 0.3-1.7 s behind the target, 6.1/6.8 s behind the edge).
    const outcomes = SEEDS.map((s) => edgeSync(CALIBRATIONS.heavy!, s, false));
    const chromiumFails = outcomes.filter((o) => o.chromiumP90 >= 500).length;
    expect(chromiumFails).toBeGreaterThan(SEEDS.length / 2);
  });
});
