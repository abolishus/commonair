// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When to offer "Install CommonAir" (README D7.6, responsive-a11y.md P10). The menus always offer
 * it where the browser can install (or, on Apple's mobile WebKit, add to the Home Screen); the
 * offer in context waits for a second visit with 3+ minutes watched. That check stays in this
 * browser: a small `localStorage` record, never sent anywhere. Pure, so it is unit-tested.
 */

/** The record's key in `localStorage`. */
export const INSTALL_STORAGE_KEY = "commonair.pwa-install.v1";
/** A page load after this long without one is a new visit. */
export const VISIT_GAP_MS = 30 * 60 * 1000;
/** The visit the offer waits for: the second. */
export const MIN_VISITS = 2;
/** Watched time (all visits together) the offer waits for. */
export const WATCH_THRESHOLD_MS = 3 * 60 * 1000;
/** One flush never adds more than this (a suspended tab or a clock jump is not watching). */
export const MAX_WATCH_FLUSH_MS = 5 * 60 * 1000;

export interface Engagement {
  /** Visits so far (page loads at least `VISIT_GAP_MS` apart). */
  visits: number;
  /** When this browser last loaded a page or watched (ms since the epoch); 0 for never. */
  lastSeenAt: number;
  /** Time spent with a video playing, all visits together. */
  watchedMs: number;
  /** "Not now" (or the browser's own install dialog dismissed): the offer never comes back. */
  dismissed: boolean;
}

export const EMPTY_ENGAGEMENT: Engagement = { visits: 0, lastSeenAt: 0, watchedMs: 0, dismissed: false };

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** The stored record, or an empty one for anything missing or malformed. */
export function parseEngagement(raw: string | null): Engagement {
  if (!raw) return EMPTY_ENGAGEMENT;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_ENGAGEMENT;
    const r = value as Record<string, unknown>;
    return {
      visits: count(r.visits),
      lastSeenAt: count(r.lastSeenAt),
      watchedMs: count(r.watchedMs),
      dismissed: r.dismissed === true,
    };
  } catch {
    return EMPTY_ENGAGEMENT;
  }
}

export function serializeEngagement(state: Engagement): string {
  return JSON.stringify(state);
}

/** A page load at `now`: a new visit when the last activity was `VISIT_GAP_MS` or more ago. */
export function recordVisit(state: Engagement, now: number): Engagement {
  const fresh = state.lastSeenAt === 0 || now - state.lastSeenAt >= VISIT_GAP_MS || now < state.lastSeenAt;
  return { ...state, visits: fresh ? state.visits + 1 : state.visits, lastSeenAt: now };
}

/** Watched time from one flush (clamped to `0..MAX_WATCH_FLUSH_MS`); watching is activity too. */
export function addWatched(state: Engagement, ms: number, now: number): Engagement {
  const add = Number.isFinite(ms) ? Math.min(MAX_WATCH_FLUSH_MS, Math.max(0, Math.floor(ms))) : 0;
  return { ...state, watchedMs: state.watchedMs + add, lastSeenAt: Math.max(state.lastSeenAt, now) };
}

export function dismissOffer(state: Engagement): Engagement {
  return { ...state, dismissed: true };
}

/** The offer in context is due: a second visit, 3+ minutes watched, never dismissed. */
export function offerDue(state: Engagement): boolean {
  return !state.dismissed && state.visits >= MIN_VISITS && state.watchedMs >= WATCH_THRESHOLD_MS;
}

/** What this browser can do: run the browser's install dialog, show Apple's steps, or nothing. */
export type InstallMode = "prompt" | "ios" | "none";

export interface InstallEnv {
  /** Running installed already (`display-mode: standalone`, or `navigator.standalone`). */
  standalone: boolean;
  /** A `beforeinstallprompt` event is held, ready for `prompt()`. */
  promptReady: boolean;
  /** `onbeforeinstallprompt` exists (Chromium): only its event ever makes installing possible. */
  promptSupported: boolean;
  /** `navigator.standalone` exists (Apple's mobile WebKit), whatever its value. */
  appleStandaloneApi: boolean;
}

/**
 * Feature detection only, no user-agent sniffing: installed means nothing to offer; a held
 * `beforeinstallprompt` means the browser's dialog; Apple's mobile WebKit (which has no such
 * event) gets the Add to Home Screen steps; any other browser, nothing.
 */
export function installMode(env: InstallEnv): InstallMode {
  if (env.standalone) return "none";
  if (env.promptReady) return "prompt";
  if (env.appleStandaloneApi && !env.promptSupported) return "ios";
  return "none";
}

/**
 * Watched time from the page's videos: the time at least one of them is playing (from `playing`
 * to whatever stops it), so two players at once count once. `take` hands over what was watched
 * since the last call, so a long stretch is saved in pieces and a closed tab loses little.
 */
export interface WatchClock {
  start(video: object, now: number): void;
  stop(video: object, now: number): void;
  take(now: number): number;
  /**
   * Forget the videos `stillPlaying` rejects without counting their time since the last `take`
   * (or their start): a player torn down off the page never sends its `pause`, so what it last
   * reported is all that is known.
   */
  sweep(stillPlaying: (video: object) => boolean): void;
  readonly playing: boolean;
}

export function createWatchClock(): WatchClock {
  const videos = new Set<object>();
  let since = 0;
  let banked = 0;
  return {
    start(video, now) {
      if (videos.size === 0) since = now;
      videos.add(video);
    },
    stop(video, now) {
      if (!videos.delete(video) || videos.size > 0) return;
      banked += Math.max(0, now - since);
    },
    take(now) {
      let total = banked;
      banked = 0;
      if (videos.size > 0) {
        total += Math.max(0, now - since);
        since = now;
      }
      return total;
    },
    sweep(stillPlaying) {
      for (const video of videos) if (!stillPlaying(video)) videos.delete(video);
    },
    get playing() {
      return videos.size > 0;
    },
  };
}
