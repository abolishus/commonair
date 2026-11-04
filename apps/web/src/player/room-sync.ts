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
 * - **hls.js** steers with `setTargetLatency`: the new hold-back is the player's own latency plus
 *   the drift, so hls.js keeps the new distance from then on. The playhead itself lands on the target
 *   from the playhead (`seekBy` the drift, PDT being linear in media time; `seekToWallclock` when
 *   the player cannot, and hls.js's sync position only when neither can), not at hls.js's sync
 *   position: that one is measured from this member's own edge estimate (`edge + age`), which
 *   moves by hundreds of ms between steps (a rendition switch, a late playlist reload,
 *   `edgeStalled`), so a step that seeks there lands off by however far it moved (CI run
 *   41757992200: two members stayed 0.5-1.1 s apart). A drift over 2 s is a plain seek, and the
 *   hold-back follows it. A correction then settles before the next one, so a seek still in
 *   flight is never corrected twice (no overshoot). **With a playback-rate seam** (the page's
 *   element), drifts up to 2 s are closed by playing faster or slower instead (`RATE`): every seek
 *   stalls, and on a loaded machine the stall undoes about as much as the seek corrected.
 * - **WebKit native** (`prefersNativeHls`) exposes no hold-back: seek only, with a 0.7 s tolerance.
 *   Its seeks land short (a keyframe snap, a flushing seek that resumes late; CI run 41768120276:
 *   ~1.3 s, so it re-seeked to the same miss every tick), so the driver learns the typical miss
 *   from where each seek ended up and aims the next one ahead by it. (Its rate is left alone: a
 *   GStreamer rate change may itself be a flushing seek, untested.)
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
  /**
   * WebKit native: seek-only tolerance. Under the 1 s target with room for the hls.js members'
   * own spread (1 s let WebKit sit just inside it while they wobbled around it).
   */
  nativeToleranceMs: 700,
  reducedNativeToleranceMs: 1500,
  /** hls.js without the steering seam (the page fallback): seek-only, tighter than native. */
  seekOnlyToleranceMs: 350,
  reducedSeekOnlyToleranceMs: 600,
  /** No new correction this soon after the last one (a seek or a hold-back step is still settling). */
  settleMs: 1500,
  /**
   * Seek-only players (WebKit native): how far ahead of the target a seek may aim to make up for
   * landing short (a keyframe snap, a flush that resumes late). Bounds a lead learnt from a player
   * that never gets there.
   */
  maxSeekLeadMs: 2500,
  /**
   * How much of each landing's miss the lead takes on. Half: a seek's stall varies (CI: 0.1-1.7 s),
   * so taking all of the last miss chases the noise; half converges on the typical miss.
   */
  seekLeadGain: 0.5,
} as const;

/**
 * hls.js small drifts (deadband to 2 s) by playback rate. Every seek costs a stall while the decoder
 * refills, and on a loaded machine the stall is about the size of the correction: on CI the members
 * lost ~320 ms (one run) and ~750 ms (106-1702, another) between a correction and their next frame,
 * so seeking every tick kept them 0.3-1.7 s behind the target and 6.1/6.8 s behind the edge (run
 * 41771305439). A rate change does not flush. `1 - drift / horizon` closes the drift in about one
 * tick, bounded so speech stays intelligible.
 */
export const RATE = {
  horizonMs: 2000,
  min: 0.75,
  max: 1.33,
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
  /**
   * The player's own latency in seconds (hls.js `latency`; before any step, else `now - playhead`):
   * the base for a step, the applied hold-back only when it is unknown.
   */
  measuredLatency: number | null;
  /** Milliseconds since the last correction, null if none yet. */
  sinceLastMs: number | null;
  /** hls.js: the player can change its playback rate (`setPlaybackRate`), so small drifts need no seek. */
  rate?: boolean;
}

export type Correction =
  | { kind: "none"; driftMs: number | null }
  | { kind: "latency"; seconds: number; driftMs: number }
  | { kind: "rate"; rate: number; driftMs: number }
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
  if (i.rate) {
    // Close the drift over the next tick by playing faster or slower: no seek, so no stall.
    if (abs <= deadband) return { kind: "rate", rate: 1, driftMs };
    const rate = Math.min(RATE.max, Math.max(RATE.min, 1 - driftMs / RATE.horizonMs));
    return { kind: "rate", rate, driftMs };
  }
  if (abs <= deadband) return { kind: "none", driftMs };
  // Where the player is now, not where the last step meant it to be: steps land by seek, so the
  // applied hold-back is never checked against the playhead and drifts (CI run 41764916744: from a
  // 16 s start-up reading down to the 1 s floor).
  const base = i.measuredLatency ?? i.appliedLatency;
  if (base === null) return { kind: "none", driftMs };
  // At the range's end the hold-back stays put, but the playhead still lands by seek.
  return { kind: "latency", seconds: clampLatency(base + driftMs / 1000), driftMs };
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
  /**
   * Move the playhead `ms` of media time from where it is (positive: forward); false, and nothing
   * moves, outside the seekable range. It reads the same mapping `playheadWallclock` does, so a
   * correction lands where the drift says. `seekToWallclock` maps through the playing level's
   * fragment list instead, which hls.js stops refreshing once ABR loads another level: the target
   * is then missing from it (false) or mapped against stale fragment starts.
   */
  seekBy?(ms: number): boolean;
  /** hls.js: set the element's playback rate (1 = normal); false when it cannot. */
  setPlaybackRate?(rate: number): boolean;
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

/**
 * The player's own latency when it reports a usable one. Otherwise the wall-clock estimate, but
 * only before the first step: it mixes the viewer's clock with the encoder's, so once a hold-back
 * was applied that one is the better base (null here lets `nextCorrection` use it).
 */
function measuredLatency(p: RoomPlayer, head: number | null, now: number, applied: number | null): number | null {
  const own = p.latencySeconds?.() ?? null;
  if (own !== null && Number.isFinite(own) && own > 0) return own;
  return head === null || applied !== null ? null : (now - head) / 1000;
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
  /** Seek-only players: how far ahead of the target a seek aims (ms), learnt from where seeks landed. */
  private seekLeadMs = 0;
  /** When the last seek-only seek went out, until its landing is read. */
  private seekedAt: number | null = null;
  /** The playback rate this driver last set (1 until it steers by rate). */
  private rate = 1;
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
    const measured = measuredLatency(p, head, now, this.applied);
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
      rate: p.setPlaybackRate !== undefined && p.setTargetLatency !== undefined,
    });
    this.lastDriftMs = c.driftMs;
    // Normal speed again for a seek, and whenever the room no longer steers this player (DVR, no target).
    if (c.kind === "seek" || c.driftMs === null) this.setRate(p, 1);
    // `nextCorrection` only corrects with a playhead and a target.
    if (head === null || targetMs === null) return c;
    if (c.kind === "rate") {
      if (this.setRate(p, c.rate) || c.rate === 1) return c;
      // The element refused the rate: correct this tick with a hold-back step and a seek instead.
      const base = measured ?? this.applied;
      if (base === null || !p.setTargetLatency) return c;
      const seconds = clampLatency(base + c.driftMs / 1000);
      this.latencyStep(p, head, targetMs, seconds);
      this.lastAt = now;
      return { kind: "latency", seconds, driftMs: c.driftMs };
    }
    const seekOnly = !p.setTargetLatency;
    // The first look after a seek-only seek has settled: where it ended up, against the target, is
    // how far the lead was off (the seek aimed at target + lead).
    if (seekOnly && this.seekedAt !== null && c.driftMs !== null && now - this.seekedAt >= DRIFT.settleMs) {
      this.seekLeadMs = Math.min(
        DRIFT.maxSeekLeadMs,
        Math.max(-DRIFT.maxSeekLeadMs, this.seekLeadMs - DRIFT.seekLeadGain * c.driftMs),
      );
      this.seekedAt = null;
    }
    if (c.kind === "latency" && p.setTargetLatency) {
      this.latencyStep(p, head, targetMs, c.seconds);
      this.lastAt = now;
    } else if (c.kind === "seek") {
      // The hold-back follows the seek, so hls.js keeps the new distance rather than its old one.
      const base = measured ?? this.applied;
      const held = p.setTargetLatency && base !== null ? clampLatency(base + c.driftMs / 1000) : null;
      if (this.land(p, head, seekOnly ? c.toMs + this.seekLeadMs : c.toMs)) {
        if (held !== null) this.hold(p, held);
        if (seekOnly) this.seekedAt = now;
        this.lastAt = now;
      } else if (held !== null && p.setTargetLatency) {
        // Neither seek could: a member left this far off would stay there, so step to hls.js's sync position.
        this.remember(p.setTargetLatency(held), held);
        this.lastAt = now;
      }
    }
    return c;
  }

  /** A hold-back step: hold `seconds`, and land on the target from the playhead. */
  private latencyStep(p: RoomPlayer, headMs: number, targetMs: number, seconds: number): void {
    this.hold(p, seconds);
    // Land from the playhead; hls.js's sync position hangs off its own (moving) edge estimate.
    // Only when neither seek can, step there after all.
    if (!this.land(p, headMs, targetMs) && p.setTargetLatency) this.remember(p.setTargetLatency(seconds), seconds);
  }

  /** Set the playback rate if it changes; true when the player now plays at `rate`. */
  private setRate(p: RoomPlayer, rate: number): boolean {
    if (this.rate === rate) return true;
    if (!p.setPlaybackRate?.(rate)) return false;
    this.rate = rate;
    return true;
  }

  /** Move the playhead to `toMs`: relative to the playhead when the player can, else by its fragments. */
  private land(p: RoomPlayer, headMs: number, toMs: number): boolean {
    if (p.seekBy?.(toMs - headMs)) return true;
    return p.seekToWallclock(new Date(toMs));
  }

  private remember(applied: number, asked: number): void {
    this.applied = Number.isFinite(applied) ? applied : asked;
  }

  /** Set the hold-back without moving the playhead, and remember it. */
  private hold(p: RoomPlayer, seconds: number): void {
    this.remember(p.setTargetLatency?.(seconds, { seek: false }) ?? Number.NaN, seconds);
  }

  /** Leaving the room: forget the target (the player keeps its last hold-back until it reloads). */
  reset(): void {
    this.target = null;
    this.lastAt = null;
    this.lastDriftMs = null;
    // The lead is the player's, not the room's: kept. A landing not yet read is dropped.
    this.seekedAt = null;
    // Out of the room, the player plays at normal speed.
    const p = this.deps.player();
    if (p) this.setRate(p, 1);
  }
}
