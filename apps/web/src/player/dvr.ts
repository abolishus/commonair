// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live DVR in the player (ADR 0016), on the W2 player seam only (`enterDvr`, `exitDvr`,
 * `seekToWallclock`, `playheadWallclock`; docs/testing/w2-selectors.md "Player seam"). Positions
 * are seconds behind live; the scrubber shows them as a position in the window (0 = the oldest
 * second the viewer may rewind to, `windowSeconds` = live).
 */
import type { PlayerController } from "./controller.ts";

/** Arrow keys move the scrubber by this much. */
export const DVR_STEP_SECONDS = 10;
/** Page Up / Page Down (and Shift+arrow). */
export const DVR_LARGE_STEP_SECONDS = 60;
/**
 * Closer than this to live plays the live playlist: the DVR playlist ends about two 4 s segments
 * behind the live edge (segments are readable only once uploaded, ADR 0016 decision 1), and the
 * live player itself sits a few seconds back.
 */
export const DVR_LIVE_EDGE_SECONDS = 12;
/** A seek that falls off the old end of the window lands this far inside it instead. */
export const DVR_WINDOW_MARGIN_SECONDS = 15;

/** What DVR needs of the controller (the seam). */
export type DvrSeam = Pick<
  PlayerController,
  "enterDvr" | "exitDvr" | "seekToWallclock" | "playheadWallclock" | "playbackMode" | "dvrGrant"
>;

/** Seconds behind live now: 0 at the live edge or before the first frame. */
export function behindLiveSeconds(c: Pick<DvrSeam, "playbackMode" | "playheadWallclock">, nowMs: number): number {
  if (c.playbackMode() !== "dvr") return 0;
  const at = c.playheadWallclock();
  if (!at) return 0;
  return Math.max(0, (nowMs - at.getTime()) / 1000);
}

/** The scrubber's value (a position in the window) for a distance behind live, and back. */
export const positionOf = (behindSeconds: number, windowSeconds: number): number =>
  Math.min(windowSeconds, Math.max(0, windowSeconds - behindSeconds));
export const behindOf = (position: number, windowSeconds: number): number =>
  Math.min(windowSeconds, Math.max(0, windowSeconds - position));

/**
 * One seeker per controller, so the scrubber and the controls share a single flight: a seek
 * asked for while the DVR playlist is still loading replaces the one waiting, and the latest
 * wins. `live()` cancels anything pending.
 */
export class DvrSeeker {
  private wanted: number | null = null;
  private running: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly c: DvrSeam,
    private readonly now: () => number = Date.now,
  ) {}

  /** Play `behindSeconds` behind live; at or near the edge, back to live. Resolves when applied. */
  seek(behindSeconds: number): Promise<void> {
    this.wanted = Math.max(0, behindSeconds);
    this.running ??= this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Back to live (the "back to live" button, `L`, `End`). */
  live(): void {
    this.generation += 1;
    this.wanted = null;
    this.c.exitDvr();
  }

  private async loop(): Promise<void> {
    while (this.wanted !== null) {
      const behind = this.wanted;
      this.wanted = null;
      await this.apply(behind, this.generation);
    }
  }

  private async apply(behind: number, generation: number): Promise<void> {
    if (behind <= DVR_LIVE_EDGE_SECONDS) {
      this.live();
      return;
    }
    const grant = this.c.dvrGrant();
    if (!grant) return;
    const window = grant.windowSeconds;
    if (this.c.playbackMode() !== "dvr") {
      const ok = await this.c.enterDvr(grant.playlistUrl);
      // A `live()` while loading, or a failed load (the controller is back on live).
      if (!ok || generation !== this.generation) return;
    }
    const clamped = Math.min(behind, window);
    if (this.c.seekToWallclock(new Date(this.now() - clamped * 1000))) return;
    // Past the old end of the window (it slid on while we loaded): just inside it instead.
    if (clamped > window / 2) {
      const inside = Math.max(DVR_LIVE_EDGE_SECONDS, window - DVR_WINDOW_MARGIN_SECONDS);
      this.c.seekToWallclock(new Date(this.now() - inside * 1000));
      return;
    }
    // Newer than the DVR playlist reaches: that is the live stream.
    this.live();
  }
}

/** What a DVR source swap needs of the controller (batch 8, the heartbeat's `dvrSwitchTo`). */
export interface DvrSwapSeam {
  playheadWallclock(): Date | null;
  seekToWallclock(t: Date): boolean;
  /**
   * Load `url` as the DVR playlist being played; false when it fails or a newer load supersedes
   * it. Without `autoplay` the element is not told to play, so a paused viewer hears nothing and
   * sees no `playing` event while the new source loads.
   */
  loadDvr(url: string, opts: { autoplay: boolean }): Promise<boolean>;
  paused(): boolean;
  pause(): void;
  /**
   * Where the swap sent the playhead (`seekOk` false: the new playlist did not reach it yet), so
   * the controller can hold it there while the new source settles.
   */
  landed?(target: Date, seekOk: boolean): void;
}

export type DvrSwapOutcome = "swapped" | "failed";

/**
 * Move the DVR playlist being played to another source (the origin, after the session's relay left)
 * at the current DVR position, never to live. A playing viewer lands where the playhead would be by
 * then (the position plus the load time); a paused viewer is swapped silently and stays paused at
 * the same position (decided over waiting for resume: the relay's playlist answers 403 from now
 * on, so a resume on it would fail). The controller returns to live itself when the load fails,
 * as `enterDvr` does.
 */
export async function swapDvrSource(
  seam: DvrSwapSeam,
  url: string,
  now: () => number = Date.now,
): Promise<DvrSwapOutcome> {
  const at = seam.playheadWallclock();
  const paused = seam.paused();
  const started = now();
  if (!(await seam.loadDvr(url, { autoplay: !paused }))) return "failed";
  if (at) {
    const target = new Date(paused ? at.getTime() : at.getTime() + (now() - started));
    const seekOk = seam.seekToWallclock(target);
    seam.landed?.(target, seekOk);
  }
  // Belt and braces: an element that autoplays on a new source is paused again here.
  if (paused && !seam.paused()) seam.pause();
  return "swapped";
}

const seekers = new WeakMap<DvrSeam, DvrSeeker>();

/** The controller's shared seeker. */
export function seekerFor(c: DvrSeam): DvrSeeker {
  let s = seekers.get(c);
  if (!s) {
    s = new DvrSeeker(c);
    seekers.set(c, s);
  }
  return s;
}

/** Input types that take no text, so a letter key is not typing there. */
const NON_TYPING_INPUTS = new Set([
  "range",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "color",
  "file",
]);

/** Whether a key event comes from somewhere typing happens (chat), where `L` is a letter. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  // The scrubber thumb is an input[type=range]: `L` must still work while stepping through it.
  const type = ((el as HTMLInputElement).type ?? "text").toLowerCase();
  return !NON_TYPING_INPUTS.has(type);
}

/** The `L` shortcut: back to live, unless typing or with a modifier held. */
export function isBackToLiveKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  return (e.key === "l" || e.key === "L") && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target);
}
