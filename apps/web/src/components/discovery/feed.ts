// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `directory.home` for the chrome (the side rail, the mobile sheet and the ⌘K palette): one
 * shared, browser-side copy, fetched when the first of them subscribes and refreshed every minute
 * while any is subscribed. The palette subscribes only while it is open. The home page primes it
 * with its own loader data in a layout effect, which runs before any subscriber's (passive) effect,
 * so `/` asks once.
 *
 * The copy is also kept in this tab's `sessionStorage` for one refresh period, keyed by viewer, so
 * a full page load does not ask again (every page has the rail: walking pages quickly would
 * otherwise spend the API's rate limit on it). A copy made for another viewer is never shown.
 */
import * as React from "react";
import { api } from "../../lib/api.ts";
import type { DirectoryHome } from "../../lib/directory-sections.ts";

export interface FeedState {
  status: "loading" | "ready" | "error";
  home: DirectoryHome | null;
}

/** Viewer counts and the following list move on this scale; the rail is not a live ticker. */
export const FEED_REFRESH_MS = 60_000;

const LOADING: FeedState = { status: "loading", home: null };

let state: FeedState = LOADING;
let fetchedAt = 0;
/** Whose copy `state` is (a user id, or `anonymous`); null until a viewer-aware subscriber. */
let owner: string | null = null;

/** `sessionStorage` key of the tab's copy. */
export const FEED_CACHE_KEY = "commonair:home-feed";

interface CachedFeed {
  at: number;
  viewer: string;
  home: DirectoryHome;
}

function readCache(viewer: string): CachedFeed | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedFeed> | null;
    if (!cached || cached.viewer !== viewer || typeof cached.at !== "number" || !cached.home) return null;
    const age = Date.now() - cached.at;
    return age >= 0 && age < FEED_REFRESH_MS ? (cached as CachedFeed) : null;
  } catch {
    return null;
  }
}

function writeCache(home: DirectoryHome): void {
  if (owner === null) return;
  try {
    const entry: CachedFeed = { at: fetchedAt, viewer: owner, home };
    globalThis.sessionStorage?.setItem(FEED_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage blocked or full: the in-memory copy still serves this page.
  }
}

/** Switch the copy to `viewer`'s: another viewer's copy is dropped, a fresh cached one is used. */
function adopt(viewer: string): void {
  // A copy with no owner yet (primed without one) is taken over; another viewer's is dropped.
  if (owner !== null && owner !== viewer) {
    state = LOADING;
    fetchedAt = 0;
  }
  owner = viewer;
  if (state.home !== null) return;
  const cached = readCache(viewer);
  if (cached) {
    fetchedAt = cached.at;
    state = { status: "ready", home: cached.home };
  }
}
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function set(next: FeedState): void {
  state = next;
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await api().directory.home({});
      fetchedAt = Date.now();
      const home: DirectoryHome = {
        spotlight: res.spotlight,
        newAndLive: res.newAndLive,
        live: res.live,
        following: res.following,
        recentlyLive: res.recentlyLive,
        followingOffline: res.followingOffline,
      };
      writeCache(home);
      set({ status: "ready", home });
    } catch {
      // Keep what was shown; only a first load that fails says so.
      if (state.home === null) set({ status: "error", home: null });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (Date.now() - fetchedAt > FEED_REFRESH_MS / 2) void load();
    timer = setInterval(() => void load(), FEED_REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Reads the current copy without fetching or polling (a closed palette). */
function subscribeIdle(): () => void {
  return () => {};
}

/**
 * The shared feed; `loading` on the server and until the first answer. With `enabled: false` it
 * returns whatever copy is there and neither fetches nor polls. `viewer` (the signed-in user's id,
 * or `anonymous`) lets it reuse this tab's cached copy for that viewer.
 */
export function useHomeFeed({ enabled = true, viewer }: { enabled?: boolean; viewer?: string } = {}): FeedState {
  const subscribeAs = React.useCallback(
    (listener: () => void) => {
      if (viewer !== undefined) adopt(viewer);
      return subscribe(listener);
    },
    [viewer],
  );
  return React.useSyncExternalStore(
    enabled ? subscribeAs : subscribeIdle,
    () => state,
    () => LOADING,
  );
}

/** The home page's loader data is the same call: reuse it instead of asking again. */
export function primeHomeFeed(home: DirectoryHome, viewer?: string): void {
  if (viewer !== undefined) owner = viewer;
  fetchedAt = Date.now();
  writeCache(home);
  set({ status: "ready", home });
}

/** The feed's viewer key for a bootstrap `me`. */
export function feedViewer(me: { id: string } | null): string {
  return me ? me.id : "anonymous";
}

/** Tests: forget everything. */
export function resetHomeFeed(): void {
  state = LOADING;
  fetchedAt = 0;
  owner = null;
  inflight = null;
  if (timer) clearInterval(timer);
  timer = null;
  listeners.clear();
}
