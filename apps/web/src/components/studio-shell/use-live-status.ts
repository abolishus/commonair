// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The LiveStatusBar's data: `channels.get` and `stream.health` for the member's own channel, read
 * together now and again every `statusPollDelay` while the tab is visible. A hidden tab stops
 * asking; coming back reads at once. Failures back off (30 s doubling to 5 min, longer when a 429
 * says so) and the last good answer stays on screen; with nothing to show the bar offers Retry.
 */
import * as React from "react";
import { api } from "../../lib/api.ts";
import { statusPollDelay, type StatusChannel, type StatusHealth } from "./model.ts";

export interface LiveStatusLoader {
  channel(slug: string): Promise<StatusChannel>;
  health(slug: string): Promise<StatusHealth>;
}

/** What the poll needs from the page: `document` and the global timers in the browser. */
export interface StatusPollEnv {
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LiveStatus {
  channel: StatusChannel | null;
  health: StatusHealth | null;
  /** The last read failed and there is no channel answer to show. */
  failed: boolean;
  /** Read again now, resetting the backoff. */
  retry: () => void;
}

export const apiStatusLoader: LiveStatusLoader = {
  channel: async (slug) => {
    const c = await api().channels.get({ channel: slug });
    return { slug: c.slug, live: c.live, lastLiveAt: c.lastLiveAt };
  },
  health: (slug) => api().stream.health({ channel: slug }),
};

export function browserStatusEnv(): StatusPollEnv {
  return {
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

interface Snapshot {
  slug: string | null;
  channel: StatusChannel | null;
  health: StatusHealth | null;
  failures: number;
}

/** `slug` null (signed out, or no channel yet): nothing is read. */
export function useLiveStatus(
  slug: string | null,
  loader: LiveStatusLoader = apiStatusLoader,
  env?: StatusPollEnv,
): LiveStatus {
  const [snap, setSnap] = React.useState<Snapshot>({ slug, channel: null, health: null, failures: 0 });
  const retryRef = React.useRef<() => void>(() => undefined);
  React.useEffect(() => {
    if (slug === null) return undefined;
    const own = slug;
    const pollEnv = env ?? browserStatusEnv();
    let cancelled = false;
    let inFlight = false;
    let timer: unknown = null;
    let failures = 0;
    let lastError: unknown;
    const stopTimer = () => {
      if (timer !== null) pollEnv.clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      stopTimer();
      if (cancelled || !pollEnv.isVisible()) return;
      timer = pollEnv.setTimeout(tick, statusPollDelay(failures, lastError));
    };
    function tick(): void {
      // A slow answer must not pile requests up behind it.
      if (inFlight || cancelled) return;
      inFlight = true;
      stopTimer();
      void Promise.allSettled([loader.channel(own), loader.health(own)]).then(([c, h]) => {
        inFlight = false;
        if (cancelled) return;
        const rejected = [c, h].find((r) => r.status === "rejected");
        if (rejected) {
          failures++;
          lastError = rejected.reason;
        } else {
          failures = 0;
          lastError = undefined;
        }
        setSnap((prev) => {
          const base = prev.slug === slug ? prev : { slug, channel: null, health: null, failures: 0 };
          return {
            slug,
            channel: c.status === "fulfilled" ? c.value : base.channel,
            // A failed health read says nothing about health: unknown, not the stale word.
            health: h.status === "fulfilled" ? h.value : null,
            failures,
          };
        });
        schedule();
      });
    }
    retryRef.current = () => {
      failures = 0;
      lastError = undefined;
      tick();
    };
    const onVisibility = () => {
      if (pollEnv.isVisible()) tick();
      else stopTimer();
    };
    const unlisten = pollEnv.onVisibilityChange(onVisibility);
    if (pollEnv.isVisible()) tick();
    return () => {
      cancelled = true;
      retryRef.current = () => undefined;
      unlisten();
      stopTimer();
    };
  }, [slug, loader, env]);
  const retry = React.useCallback(() => retryRef.current(), []);
  const current = snap.slug === slug ? snap : { slug, channel: null, health: null, failures: 0 };
  return {
    channel: current.channel,
    health: current.health,
    failed: current.channel === null && current.failures > 0,
    retry,
  };
}
