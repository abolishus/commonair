// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch-room player sync (decision (r), ADR 0012 part 2): the drift controller and the driver that
 * applies it to this channel's player.
 *
 * The chat service sends `room.sync {target}` every 2 s: the PDT the room's members should be at
 * (the slowest live member, capped 5 s behind the most advanced). The target moves with real time,
 * so a target received at `t0` is `target + (now - t0)` later. Drift is `playhead - target`
 * (positive: this member is ahead).
 *
 * - **hls.js** steers with `setTargetLatency`: the new hold-back is the last one applied plus the
 *   drift, so one step converges whatever the encoder's offset between PDT and hls.js's edge. A
 *   drift over 2 s is a seek (`seekToWallclock`). A correction then settles before the next one,
 *   so a seek still in flight is never corrected twice (no overshoot).
 * - **WebKit native** (`prefersNativeHls`) exposes no hold-back: seek only, with about 1 s tolerance.
 * - **Reduced motion** widens both bands so the picture jumps less often.
 * - **DVR** members are left alone (the server leaves them out of the target too).
 */
import { TARGET_LATENCY_RANGE } from "./controller.ts";
import type { PlaybackMode } from "./media-clock.ts";

export const DRIFT = {
  /** hls.js: drift under this is left alone (the Chromium target is a delta under 500 ms). */
  deadbandMs: 150,
  reducedDeadbandMs: 400,
  /** hls.js: a drift over this is a seek instead of a hold-back step. */
  seekOverMs: 2000,
  /** WebKit native: seek-only tolerance. */
  nativeToleranceMs: 1000,
  reducedNativeToleranceMs: 1500,
  /** hls.js without the steering seam (the page fallback): seek-only, tighter than native. */
  seekOnlyToleranceMs: 350,
  reducedSeekOnlyToleranceMs: 600,
  /** No new correction this soon after the last one (a seek or a hold-back step is still settling). */
  settleMs: 1500,
} as const;

export interface DriftInput {
  /** PDT under this member's playhead now (epoch ms), null before the first frame. */
  playheadMs: number | null;
  /** The room's target PDT now (epoch ms), null without one. */
  targetMs: number | null;
  mode: PlaybackMode;
  /** WebKit native HLS: seek-only. */
  native: boolean;
  /** The player can steer its hold-back (`setTargetLatency`); otherwise seek-only. */
  steer: boolean;
  reducedMotion: boolean;
  /** The hold-back this driver last applied (seconds), null before its first step. */
  appliedLatency: number | null;
  /** `now - playhead` in seconds: the base for the first step. */
  measuredLatency: number | null;
  /** Milliseconds since the last correction, null if none yet. */
  sinceLastMs: number | null;
}

export type Correction =
  | { kind: "none"; driftMs: number | null }
  | { kind: "latency"; seconds: number; driftMs: number }
  | { kind: "seek"; toMs: number; driftMs: number };

const clampLatency = (s: number) => Math.min(TARGET_LATENCY_RANGE.max, Math.max(TARGET_LATENCY_RANGE.min, s));

/** The next correction for one member. Pure. */
export function nextCorrection(i: DriftInput): Correction {
  if (i.mode !== "live" || i.playheadMs === null || i.targetMs === null) return { kind: "none", driftMs: null };
  const driftMs = i.playheadMs - i.targetMs;
  if (i.sinceLastMs !== null && i.sinceLastMs < DRIFT.settleMs) return { kind: "none", driftMs };
  const abs = Math.abs(driftMs);
  if (i.native) {
    const tolerance = i.reducedMotion ? DRIFT.reducedNativeToleranceMs : DRIFT.nativeToleranceMs;
    return abs > tolerance ? { kind: "seek", toMs: i.targetMs, driftMs } : { kind: "none", driftMs };
  }
  if (!i.steer) {
    const tolerance = i.reducedMotion ? DRIFT.reducedSeekOnlyToleranceMs : DRIFT.seekOnlyToleranceMs;
    return abs > tolerance ? { kind: "seek", toMs: i.targetMs, driftMs } : { kind: "none", driftMs };
  }
  if (abs > DRIFT.seekOverMs) return { kind: "seek", toMs: i.targetMs, driftMs };
  const deadband = i.reducedMotion ? DRIFT.reducedDeadbandMs : DRIFT.deadbandMs;
  if (abs <= deadband) return { kind: "none", driftMs };
  const base = i.appliedLatency ?? i.measuredLatency;
  if (base === null) return { kind: "none", driftMs };
  const seconds = clampLatency(base + driftMs / 1000);
  // At the range's end: nothing left to steer with.
  if (Math.abs(seconds - base) < 0.001) return { kind: "none", driftMs };
  return { kind: "latency", seconds, driftMs };
}

/** What the driver needs from this channel's player. */
export interface RoomPlayer {
  playheadWallclock(): Date | null;
  playbackMode(): PlaybackMode;
  /** hls.js hold-back; absent on players that cannot steer (the fallback, native). */
  setTargetLatency?(seconds: number): number;
  seekToWallclock(t: Date): boolean;
  native: boolean;
}

export interface RoomSyncDriverDeps {
  /** This channel's player, resolved at each step (it can remount). */
  player: () => RoomPlayer | null;
  reducedMotion: () => boolean;
  now?: () => number;
}

/** Applies `nextCorrection` each time a target arrives; keeps the hold-back it applied. */
export class RoomSyncDriver {
  private target: { ms: number; at: number } | null = null;
  private applied: number | null = null;
  private lastAt: number | null = null;
  /** The last drift seen (ms), for `data-*` and diagnostics. */
  lastDriftMs: number | null = null;

  constructor(private readonly deps: RoomSyncDriverDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The room's target as of now (ISO), or null. */
  targetNow(): number | null {
    if (!this.target) return null;
    return this.target.ms + (this.now() - this.target.at);
  }

  /** A `room.sync {target}` arrived: remember it and correct. */
  onTarget(targetIso: string): Correction {
    const ms = Date.parse(targetIso);
    if (!Number.isFinite(ms)) return { kind: "none", driftMs: null };
    this.target = { ms, at: this.now() };
    return this.step();
  }

  step(): Correction {
    const p = this.deps.player();
    if (!p) return { kind: "none", driftMs: null };
    const now = this.now();
    const head = p.playheadWallclock()?.getTime() ?? null;
    const c = nextCorrection({
      playheadMs: head,
      targetMs: this.targetNow(),
      mode: p.playbackMode(),
      native: p.native,
      steer: p.setTargetLatency !== undefined,
      reducedMotion: this.deps.reducedMotion(),
      appliedLatency: this.applied,
      measuredLatency: head === null ? null : (now - head) / 1000,
      sinceLastMs: this.lastAt === null ? null : now - this.lastAt,
    });
    this.lastDriftMs = c.driftMs;
    if (c.kind === "latency" && p.setTargetLatency) {
      const applied = p.setTargetLatency(c.seconds);
      this.applied = Number.isFinite(applied) ? applied : c.seconds;
      this.lastAt = now;
    } else if (c.kind === "seek") {
      if (p.seekToWallclock(new Date(c.toMs))) {
        // The hold-back follows the seek, so hls.js does not pull the playhead back afterwards.
        if (this.applied !== null && p.setTargetLatency) this.applied = clampLatency(this.applied + c.driftMs / 1000);
        this.lastAt = now;
      }
    }
    return c;
  }

  /** Leaving the room: forget the target (the player keeps its last hold-back until it reloads). */
  reset(): void {
    this.target = null;
    this.lastAt = null;
    this.lastDriftMs = null;
  }
}
