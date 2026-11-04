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
 *   drift, so hls.js keeps the new distance from then on. The playhead itself lands on the target
 *   from the playhead (`seekToWallclock`; PDT is linear in media time), not at hls.js's sync
 *   position: that one is measured from this member's own edge estimate (`edge + age`), which
 *   moves by hundreds of ms between steps (a rendition switch, a late playlist reload,
 *   `edgeStalled`), so a step that seeks there lands off by however far it moved (CI run
 *   41757992200: two members stayed 0.5-1.1 s apart). A drift over 2 s is a plain seek, and the
 *   hold-back follows it. A correction then settles before the next one, so a seek still in
 *   flight is never corrected twice (no overshoot).
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
  /** The player's latency in seconds (else `now - playhead`): the base for the first step. */
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
  /**
   * hls.js hold-back; absent on players that cannot steer (the fallback, native). `seek: false`
   * holds the new distance without stepping to hls.js's sync position now.
   */
  setTargetLatency?(seconds: number, opts?: { seek?: boolean }): number;
  /**
   * The player's own live latency in seconds (hls.js `latency`), when it knows it. The first
   * hold-back step uses it as its base; without it the base is `now - PDT`, which mixes the
   * viewer's clock with the encoder's and can overshoot into a seek.
   */
  latencySeconds?(): number | null;
  seekToWallclock(t: Date): boolean;
  native: boolean;
  /**
   * Batch 8: the live edge as a wall-clock instant (the PDT at the end of the live playlist), null
   * in DVR or while unknown. Chat measures the room's 5 s cap from `max` of the members' edges.
   */
  edgeWallclock?(): Date | null;
}

/** What `liveEdgeMs` reads. Every field may be unknown (null). */
export interface EdgeInput {
  mode: PlaybackMode;
  /** PDT under the playhead (epoch ms). */
  playheadMs: number | null;
  /** hls.js `latency`: seconds from the playhead to the live edge, from the playlist. */
  latencySeconds: number | null;
  /** Native HLS: the end of `video.seekable` and `currentTime` (seconds, media time). */
  seekableEnd: number | null;
  currentTime: number | null;
}

/**
 * The player's live edge as a wall-clock instant (epoch ms), from the media clock it already has
 * (ADR 0012): the PDT under the playhead plus the distance to the edge. hls.js knows that distance
 * from the playlist (`latency`); native HLS from `seekable`'s end. Both are media time, so the
 * viewer's own clock plays no part. Null in DVR (a DVR member is left out of the target, and its
 * edge with it), before the first frame, or when neither distance is known.
 */
export function liveEdgeMs(i: EdgeInput): number | null {
  if (i.mode !== "live" || i.playheadMs === null || !Number.isFinite(i.playheadMs)) return null;
  if (i.latencySeconds !== null && Number.isFinite(i.latencySeconds) && i.latencySeconds > 0)
    return i.playheadMs + i.latencySeconds * 1000;
  if (
    i.seekableEnd !== null &&
    i.currentTime !== null &&
    Number.isFinite(i.seekableEnd) &&
    Number.isFinite(i.currentTime) &&
    i.seekableEnd >= i.currentTime
  )
    return i.playheadMs + (i.seekableEnd - i.currentTime) * 1000;
  return null;
}

/** What a member reports with every `room.sync`: its playhead, its mode and its live edge. */
export interface RoomReport {
  at: Date | null;
  mode: PlaybackMode;
  /** Null in DVR or while unknown. */
  edge: Date | null;
}

/** This member's report, from its player. A DVR member reports no edge. */
export function roomReport(p: RoomPlayer | null): RoomReport | null {
  if (!p) return null;
  const mode = p.playbackMode();
  const at = p.playheadWallclock();
  const edge = mode === "live" ? (p.edgeWallclock?.() ?? null) : null;
  return { at, mode, edge: edge && Number.isFinite(edge.getTime()) ? edge : null };
}

/** The player's own latency when it reports a usable one, else the wall-clock estimate. */
function measuredLatency(p: RoomPlayer, head: number | null, now: number): number | null {
  const own = p.latencySeconds?.() ?? null;
  if (own !== null && Number.isFinite(own) && own > 0) return own;
  return head === null ? null : (now - head) / 1000;
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
    const targetMs = this.targetNow();
    const measured = measuredLatency(p, head, now);
    const c = nextCorrection({
      playheadMs: head,
      targetMs,
      mode: p.playbackMode(),
      native: p.native,
      steer: p.setTargetLatency !== undefined,
      reducedMotion: this.deps.reducedMotion(),
      appliedLatency: this.applied,
      measuredLatency: measured,
      sinceLastMs: this.lastAt === null ? null : now - this.lastAt,
    });
    this.lastDriftMs = c.driftMs;
    if (c.kind === "latency" && p.setTargetLatency && targetMs !== null) {
      this.hold(p, c.seconds);
      // Land from the playhead; hls.js's sync position hangs off its own (moving) edge estimate.
      if (!p.seekToWallclock(new Date(targetMs))) p.setTargetLatency(c.seconds);
      this.lastAt = now;
    } else if (c.kind === "seek") {
      if (p.seekToWallclock(new Date(c.toMs))) {
        // The hold-back follows the seek, so hls.js keeps the new distance rather than its old one.
        const base = this.applied ?? measured;
        if (p.setTargetLatency && base !== null) this.hold(p, clampLatency(base + c.driftMs / 1000));
        this.lastAt = now;
      }
    }
    return c;
  }

  /** Set the hold-back without moving the playhead, and remember it. */
  private hold(p: RoomPlayer, seconds: number): void {
    const applied = p.setTargetLatency?.(seconds, { seek: false }) ?? Number.NaN;
    this.applied = Number.isFinite(applied) ? applied : seconds;
  }

  /** Leaving the room: forget the target (the player keeps its last hold-back until it reloads). */
  reset(): void {
    this.target = null;
    this.lastAt = null;
    this.lastDriftMs = null;
  }
}
