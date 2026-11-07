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
 * - **hls.js with a playback-rate seam** (every registered hls.js player, and the page fallback)
 *   closes drifts by playing faster or slower (`RATE`), never by seeking, up to `RATE.seekOverMs`;
 *   a larger drift (a member joining far off) is one seek, at most one per `RATE.seekCooldownMs`.
 *   Seeking every tick was the failure on a busy CI runner (exp/sync-diag run 41905217763): each
 *   seek left the element waiting (`readyState` 1, nothing buffered at the new position) for about
 *   1.6 s of the 2 s between targets, so the member was behind again at the next target, which
 *   seeked again. Members spent ~80 % of the time waiting and sat 1-3 s behind the target, 6-7 s
 *   behind the room's edge. A rate change does not flush the decoder. The hold-back follows the
 *   playhead (no seek), so hls.js keeps the distance the rate reached.
 * - **The target** of a rate player is the median of the last few `room.sync` targets (each as an offset from when
 *   it arrived): chat's target moves with the room's edge estimate, which jumps by up to a second
 *   from one frame to the next; every member gets the same frames, so the same filter keeps them
 *   on the same target without chasing that noise.
 * - **hls.js without a rate seam** steers with `setTargetLatency`: the new hold-back is the player's own latency plus
 *   the drift, so hls.js keeps the new distance from then on. The playhead itself lands on the target
 *   from the playhead (`seekBy` the drift, PDT being linear in media time; `seekToWallclock` when
 *   the player cannot, and hls.js's sync position only when neither can), not at hls.js's sync
 *   position: that one is measured from this member's own edge estimate (`edge + age`), which
 *   moves by hundreds of ms between steps (a rendition switch, a late playlist reload,
 *   `edgeStalled`), so a step that seeks there lands off by however far it moved (CI run
 *   41757992200: two members stayed 0.5-1.1 s apart). A drift over 2 s is a plain seek, and the
 *   hold-back follows it. A correction then settles before the next one, so a seek still in
 *   flight is never corrected twice (no overshoot).
 * - **WebKit native** (`prefersNativeHls`) exposes no hold-back: seek only, with about 1 s tolerance.
 *   Its seeks land short by about the same amount each time (a keyframe snap, a flushing seek that
 *   resumes late; CI run 41768120276: ~1.3 s, so it re-seeked to the same miss every tick), so the
 *   driver learns that miss from where each seek ended up and aims the next one ahead by it.
 * - **Rate steering that makes no headway** (the rate is set, the drift does not close: a decoder
 *   that cannot play faster than real time on a starved machine) is one seek to the target, when
 *   the media is buffered there, within the seek cooldown.
 * - **Reachable targets.** Every member reports where its buffered media ends, and chat keeps the
 *   target `ROOM_LIMITS.syncSpareMs` short of the earliest (`RATE.minAheadMs` is that spare): a
 *   member behind the target with too little buffered never plays faster and, under 3 s, never
 *   seeks, so it sat 1.63 s behind for the whole of watch-room CI run 42333642371 (WebKit).
 * - **Reduced motion** widens both bands so the picture jumps less often.
 * - **DVR** members are left alone (the server leaves them out of the target too).
 */
import { ROOM_LIMITS } from "@commonair/contracts/enums";
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
  /**
   * Seek-only players (WebKit native): how far ahead of the target a seek may aim to make up for
   * landing short (a keyframe snap, a flush that resumes late). Bounds a lead learnt from a player
   * that never gets there.
   */
  maxSeekLeadMs: 2500,
} as const;

/** Rate steering (players with `setPlaybackRate`, not native WebKit). */
export const RATE = {
  /** `rate = 1 - drift / horizon`: about half of the drift closed per 2 s target. */
  horizonMs: 4000,
  /** Bounds that keep speech intelligible and the decoder's extra work small. */
  min: 0.8,
  max: 1.25,
  /** Drift under this plays at normal speed. */
  deadbandMs: 80,
  reducedDeadbandMs: 300,
  /** A drift over this is a seek (a member joining far off), at most once per cooldown. */
  seekOverMs: 3000,
  seekCooldownMs: 10_000,
  /**
   * Faster than normal only with this much buffered ahead, and a forward seek only to media
   * buffered with `seekSpareMs` to spare. Chat's target follows hls.js's edge estimate (the
   * playlist's end plus its age), which runs ahead of what has arrived when delivery is late; on a
   * busy CI runner (exp/sync-diag-2, run 41909793712) members playing 1.25x toward it drained
   * their buffers to nothing and waited, which put them further behind than staying put.
   */
  minAheadMs: ROOM_LIMITS.syncSpareMs,
  seekSpareMs: 1000,
  /**
   * Rate steering judged as making no headway once it should have closed this much (ms of drift,
   * `|rate - 1| x time`) and closed under `noHeadwayShare` of it.
   */
  noHeadwayAfterMs: 1000,
  noHeadwayShare: 0.25,
} as const;

/** How many of the latest targets the median takes. */
export const TARGET_MEDIAN_OF = 5;

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
  /** The player can change its playback rate (`setPlaybackRate`): small drifts need no seek. */
  rate?: boolean;
  /** Rate players: milliseconds since the last seek, null if none yet. */
  sinceSeekMs?: number | null;
  /** Media buffered ahead of the playhead (ms), null when unknown (no limit then). */
  aheadMs?: number | null;
  /** Rate players: the rate set so far has not closed the drift (`RATE.noHeadwayAfterMs`). */
  noHeadway?: boolean;
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
  const abs = Math.abs(driftMs);
  if (i.rate && !i.native) {
    // No settle: a rate is set afresh with every target, and only a seek needs time to land.
    const sinceSeek = i.sinceSeekMs ?? null;
    const ahead = i.aheadMs ?? null;
    // Behind: forward only as far as the media that has arrived.
    const reachable = driftMs > 0 || ahead === null || ahead >= abs + RATE.seekSpareMs;
    const cooled = sinceSeek === null || sinceSeek >= RATE.seekCooldownMs;
    if ((abs > RATE.seekOverMs || (i.noHeadway && abs > RATE.deadbandMs)) && reachable && cooled)
      return { kind: "seek", toMs: i.targetMs, driftMs };
    const deadband = i.reducedMotion ? RATE.reducedDeadbandMs : RATE.deadbandMs;
    if (abs <= deadband) return { kind: "rate", rate: 1, driftMs };
    if (driftMs < 0 && ahead !== null && ahead < RATE.minAheadMs) return { kind: "rate", rate: 1, driftMs };
    const rate = Math.min(RATE.max, Math.max(RATE.min, 1 - driftMs / RATE.horizonMs));
    return { kind: "rate", rate: Math.round(rate * 100) / 100, driftMs };
  }
  if (i.sinceLastMs !== null && i.sinceLastMs < DRIFT.settleMs) return { kind: "none", driftMs };
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
  /** Set the element's playback rate (1 = normal) for live playback; false when it cannot. */
  setPlaybackRate?(rate: number): boolean;
  /** Media buffered ahead of the playhead in ms (0 outside every buffered range), null when unknown. */
  bufferAheadMs?(): number | null;
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

/** What a member reports with every `room.sync`: its playhead, its mode, its live edge and how far it has buffered. */
export interface RoomReport {
  at: Date | null;
  mode: PlaybackMode;
  /** Null in DVR or while unknown. */
  edge: Date | null;
  /** The PDT where the media buffered under the playhead ends; null in DVR or while unknown. */
  buffered: Date | null;
}

/** This member's report, from its player. A DVR member reports no edge and no buffer. */
export function roomReport(p: RoomPlayer | null): RoomReport | null {
  if (!p) return null;
  const mode = p.playbackMode();
  const at = p.playheadWallclock();
  const edge = mode === "live" ? (p.edgeWallclock?.() ?? null) : null;
  const ahead = mode === "live" && at ? (p.bufferAheadMs?.() ?? null) : null;
  const buffered = at && ahead !== null && Number.isFinite(ahead) && ahead >= 0 ? new Date(at.getTime() + ahead) : null;
  return {
    at,
    mode,
    edge: edge && Number.isFinite(edge.getTime()) ? edge : null,
    buffered: buffered && Number.isFinite(buffered.getTime()) ? buffered : null,
  };
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
  /** The latest targets, each as `arrival - target` (ms), newest last; the median is the target. */
  private offsets: number[] = [];
  /** The playback rate this driver last set (1 until it steers by rate). */
  private rate = 1;
  /** When the last seek of a rate player went out. */
  private seekAt: number | null = null;
  /**
   * Rate steering in one direction: the drift it started from, the drift it should have closed by
   * now (`|rate - 1|` x time at each rate), and when that was last added to. Null at normal speed.
   */
  private steer: { fromMs: number; owedMs: number; at: number } | null = null;
  private applied: number | null = null;
  private lastAt: number | null = null;
  /** Seek-only players: how far ahead of the target a seek aims (ms), learnt from where seeks landed. */
  private seekLeadMs = 0;
  /** When the last seek-only seek went out, until its landing is read. */
  private seekedAt: number | null = null;
  /** The last drift seen (ms), for `data-*` and diagnostics. */
  lastDriftMs: number | null = null;

  constructor(private readonly deps: RoomSyncDriverDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The room's target as of now (epoch ms), or null: the latest one, or with `median` (rate
   * players, which re-steer on every target) the median of the latest ones.
   */
  targetNow(median = false): number | null {
    if (this.offsets.length === 0) return null;
    if (!median) return this.now() - this.offsets[this.offsets.length - 1]!;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const offset = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return this.now() - offset;
  }

  /** A `room.sync {target}` arrived: remember it and correct. */
  onTarget(targetIso: string): Correction {
    const ms = Date.parse(targetIso);
    if (!Number.isFinite(ms)) return { kind: "none", driftMs: null };
    const at = this.now();
    this.offsets.push(at - ms);
    if (this.offsets.length > TARGET_MEDIAN_OF) this.offsets.shift();
    return this.step();
  }

  step(): Correction {
    const p = this.deps.player();
    if (!p) return { kind: "none", driftMs: null };
    const now = this.now();
    const head = p.playheadWallclock()?.getTime() ?? null;
    const rate = p.setPlaybackRate !== undefined && !p.native;
    const targetMs = this.targetNow(rate);
    const measured = measuredLatency(p, head, now, this.applied);
    const drift = head !== null && targetMs !== null ? head - targetMs : null;
    const noHeadway = rate && drift !== null && this.noHeadway(drift, now);
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
      rate,
      sinceSeekMs: this.seekAt === null ? null : now - this.seekAt,
      aheadMs: p.bufferAheadMs?.() ?? null,
      noHeadway,
    });
    this.lastDriftMs = c.driftMs;
    // Normal speed whenever the room does not steer this player now (DVR, no playhead or target).
    if (c.driftMs === null) this.setRate(p, 1);
    // `nextCorrection` only corrects with a playhead and a target.
    if (head === null || targetMs === null) return c;
    if (c.kind === "rate") {
      if (!this.setRate(p, c.rate, c.driftMs)) return c;
      // The hold-back follows the playhead without moving it, so hls.js keeps the distance the
      // rate is reaching (a reload or a stall then resumes there, not at the old one).
      const base = measured ?? this.applied;
      if (p.setTargetLatency && base !== null) {
        const seconds = clampLatency(base + c.driftMs / 1000);
        if (this.applied === null || Math.abs(seconds - this.applied) >= 0.25) this.hold(p, seconds);
      }
      return c;
    }
    if (c.kind === "seek" && p.setPlaybackRate && !p.native) {
      this.setRate(p, 1);
      this.steer = null;
      this.seekAt = now;
    }
    const seekOnly = !p.setTargetLatency;
    // The first look after a seek-only seek has settled: where it ended up, against the target, is
    // how far the lead was off (the seek aimed at target + lead).
    if (seekOnly && this.seekedAt !== null && c.driftMs !== null && now - this.seekedAt >= DRIFT.settleMs) {
      this.seekLeadMs = Math.min(DRIFT.maxSeekLeadMs, Math.max(-DRIFT.maxSeekLeadMs, this.seekLeadMs - c.driftMs));
      this.seekedAt = null;
    }
    if (c.kind === "latency" && p.setTargetLatency) {
      this.hold(p, c.seconds);
      // Land from the playhead; hls.js's sync position hangs off its own (moving) edge estimate.
      // Only when neither seek can, step there after all.
      if (!this.land(p, head, targetMs)) this.remember(p.setTargetLatency(c.seconds), c.seconds);
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

  /**
   * Whether the rate steering so far has failed to close the drift: it has owed at least
   * `RATE.noHeadwayAfterMs` and closed under `RATE.noHeadwayShare` of that. Books the time since
   * the last step at the rate that was playing.
   */
  private noHeadway(driftMs: number, now: number): boolean {
    const s = this.steer;
    if (!s) return false;
    // A drift that changed side was closed (and overshot): steering starts over from it.
    if (Math.sign(driftMs) !== Math.sign(s.fromMs)) {
      this.steer = this.rate === 1 ? null : { fromMs: driftMs, owedMs: 0, at: now };
      return false;
    }
    s.owedMs += Math.abs(this.rate - 1) * Math.max(0, now - s.at);
    s.at = now;
    const closed = Math.abs(s.fromMs) - Math.abs(driftMs);
    return s.owedMs >= RATE.noHeadwayAfterMs && closed < RATE.noHeadwayShare * s.owedMs;
  }

  /** Set the playback rate if it changes; true when the player now plays at `rate`. */
  private setRate(p: RoomPlayer, rate: number, driftMs: number | null = null): boolean {
    if (this.rate === rate) return true;
    if (!p.setPlaybackRate?.(rate)) return false;
    // Steering starts (or turns around) from this drift; back at normal speed it ends.
    if (rate === 1) this.steer = null;
    else if (!this.steer || this.rate === 1 || Math.sign(rate - 1) !== Math.sign(this.rate - 1))
      this.steer = { fromMs: driftMs ?? 0, owedMs: 0, at: this.now() };
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
    this.offsets = [];
    this.seekAt = null;
    this.steer = null;
    // Out of the room, the player plays at normal speed.
    const p = this.deps.player();
    if (p) this.setRate(p, 1);
    this.lastAt = null;
    this.lastDriftMs = null;
    // The lead is the player's, not the room's: kept. A landing not yet read is dropped.
    this.seekedAt = null;
  }
}
