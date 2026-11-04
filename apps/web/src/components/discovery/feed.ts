// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `directory.home` for the chrome (the side rail, the mobile sheet and the ⌘K palette): one
 * shared, browser-side copy, fetched when the first of them mounts and refreshed every minute
 * while any is mounted. The home page primes it with its own loader data, so `/` asks once.
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
      const home = await api().directory.home({});
      fetchedAt = Date.now();
      set({
        status: "ready",
        home: {
          spotlight: home.spotlight,
          newAndLive: home.newAndLive,
          live: home.live,
          following: home.following,
          recentlyLive: home.recentlyLive,
          followingOffline: home.followingOffline,
        },
      });
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

/** The shared feed; `loading` on the server and until the first answer. */
export function useHomeFeed(): FeedState {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    () => LOADING,
  );
}

/** The home page's loader data is the same call: reuse it instead of asking again. */
export function primeHomeFeed(home: DirectoryHome): void {
  fetchedAt = Date.now();
  set({ status: "ready", home });
}

/** Tests: forget everything. */
export function resetHomeFeed(): void {
  state = LOADING;
  fetchedAt = 0;
  inflight = null;
  if (timer) clearInterval(timer);
  timer = null;
  listeners.clear();
}
