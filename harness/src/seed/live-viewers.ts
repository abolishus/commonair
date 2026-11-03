// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `seed live`'s verified audience (D1-seed, design review F12): a small, stable set of seeded
 * bulk viewers that watch each live channel through the real playback path, the same HTTP viewer
 * the `viewers` scenario uses. Each one signs in, starts a playback session, downloads the
 * segments a player would and heartbeats with a person's jitter, so the integrity scorer judges it
 * like any other session: nothing is written to the database or Valkey, and `<ViewerCount>` shows
 * whatever the scorer verifies.
 *
 * A viewer watches for a span, leaves, and comes back after a short break, as people do. A session
 * that stops getting media (the publisher restarted, the playlist ended) is renewed. The plan and
 * the supervisor are pure over injected dependencies; `media/live-io.ts` wires them to the API.
 */
import type { LiveChannel, LiveChatter } from "./live.ts";
import type { Rng } from "./prng.ts";

/** Verified viewers per live channel: at least this many… */
export const MIN_WATCHERS = 3;
/** …and at most this many, the busiest channel first. */
export const MAX_WATCHERS = 15;
/** How long one watch session lasts before the viewer leaves (ms). */
export const WATCH_SPAN_MS: readonly [number, number] = [20 * 60_000, 50 * 60_000];
/** The break before the same viewer comes back (ms): a reload or a short absence. */
export const BREAK_MS: readonly [number, number] = [10_000, 45_000];
/** Arrivals spread over this long after `seed live` starts (ms), like an audience gathering. */
export const ARRIVAL_SPREAD_MS = 60_000;
/** How often a session's health is checked (ms). */
export const HEALTH_CHECK_MS = 15_000;
/** Wait before trying again when a session did not start (the channel is not live yet, say). */
export const RETRY_MS = 15_000;

export interface LiveWatcher {
  handle: string;
  /** The channel's slug. */
  channel: string;
  owner: string;
  /** Deterministic stream of this watcher's arrival, spans and breaks. */
  seed: string;
}

/**
 * How many verified viewers the channel at `rank` (0-based, busiest first) gets: a power law from
 * `MAX_WATCHERS`, jittered by one, within the bounds. Pure given `r`.
 */
export function watchersFor(rank: number, r: Rng): number {
  const base = Math.round(MAX_WATCHERS * (rank + 1) ** -0.7);
  return Math.max(MIN_WATCHERS, Math.min(MAX_WATCHERS, base + r.int(-1, 1)));
}

/**
 * Who watches what. A channel's chatters watch it first (people chat in what they watch), then
 * other bulk viewers fill it up; no viewer watches two channels. Short of viewers, later channels
 * get fewer. Pure given `rng`.
 */
export function planWatchers(
  rng: Rng,
  channels: readonly LiveChannel[],
  viewers: readonly string[],
  chatters: readonly LiveChatter[],
): LiveWatcher[] {
  const used = new Set<string>();
  const pool = rng.fork("watchers").shuffle([...viewers].sort());
  const out: LiveWatcher[] = [];
  channels.forEach((c, rank) => {
    const want = watchersFor(rank, rng.fork(`count:${c.handle}`));
    const mine = chatters.filter((x) => x.channel === c.slug && !used.has(x.handle)).map((x) => x.handle);
    const picked: string[] = [];
    for (const h of mine) if (picked.length < want && !picked.includes(h)) picked.push(h);
    for (const h of pool) {
      if (picked.length >= want) break;
      if (!used.has(h) && !picked.includes(h) && !chatters.some((x) => x.handle === h && x.channel !== c.slug))
        picked.push(h);
    }
    picked.forEach((handle, i) => {
      used.add(handle);
      out.push({ handle, channel: c.slug, owner: c.handle, seed: `${c.handle}:watch:${i}` });
    });
  });
  return out;
}

/** One running watch session. */
export interface WatchSession {
  /** False once it stopped getting media or failed; the supervisor then renews it. */
  healthy(): Promise<boolean>;
  /** Ends the playback session (idempotent). */
  stop(): Promise<void>;
}

export interface WatcherDeps {
  startWatch(w: LiveWatcher): Promise<WatchSession>;
  out(line: string): void;
  /** Rejects when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

/** What a watcher did, for the run's summary and the tests. */
export interface WatcherStats {
  sessions: number;
  /** Sessions renewed because they stopped getting media. */
  renewed: number;
  /** Sessions that ended at the end of their span. */
  spans: number;
  failedStarts: number;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Keep one viewer watching until `signal`. Never gives up: a channel may go live late. */
export async function superviseWatcher(
  w: LiveWatcher,
  r: Rng,
  deps: WatcherDeps,
  signal: AbortSignal,
): Promise<WatcherStats> {
  const stats: WatcherStats = { sessions: 0, renewed: 0, spans: 0, failedStarts: 0 };
  const nap = (ms: number) =>
    deps.sleep(ms, signal).then(
      () => true,
      () => false,
    );
  if (!(await nap(r.int(0, ARRIVAL_SPREAD_MS)))) return stats;
  while (!signal.aborted) {
    let session: WatchSession;
    try {
      session = await deps.startWatch(w);
    } catch (err) {
      stats.failedStarts++;
      // Said once per run of failures, not every retry: an offline channel is not news.
      if (stats.failedStarts === 1 || stats.failedStarts % 20 === 0)
        deps.out(`seed live: viewer ${w.handle} on ${w.channel} did not start (${message(err)}); retrying`);
      if (!(await nap(RETRY_MS))) break;
      continue;
    }
    stats.sessions++;
    const until = deps.now() + r.int(WATCH_SPAN_MS[0], WATCH_SPAN_MS[1]);
    let renew = false;
    while (!signal.aborted && deps.now() < until) {
      if (!(await nap(Math.min(HEALTH_CHECK_MS, Math.max(0, until - deps.now()))))) break;
      if (!(await session.healthy().catch(() => false))) {
        renew = true;
        break;
      }
    }
    await session.stop().catch(() => undefined);
    if (signal.aborted) break;
    if (renew) {
      stats.renewed++;
      if (!(await nap(RETRY_MS))) break;
    } else {
      stats.spans++;
      if (!(await nap(r.int(BREAK_MS[0], BREAK_MS[1])))) break;
    }
  }
  return stats;
}

/** Run every watcher until `signal`; resolves once each has stopped its session. */
export async function runWatchers(
  watchers: readonly LiveWatcher[],
  rng: Rng,
  deps: WatcherDeps,
  signal: AbortSignal,
): Promise<WatcherStats> {
  if (watchers.length > 0) {
    const per = new Map<string, number>();
    for (const w of watchers) per.set(w.channel, (per.get(w.channel) ?? 0) + 1);
    deps.out(
      `seed live: ${watchers.length} seeded viewers watching (${[...per].map(([c, n]) => `${c}: ${n}`).join(", ")})`,
    );
  }
  const all = await Promise.all(watchers.map((w) => superviseWatcher(w, rng.fork(`watch:${w.seed}`), deps, signal)));
  return all.reduce(
    (a, s) => ({
      sessions: a.sessions + s.sessions,
      renewed: a.renewed + s.renewed,
      spans: a.spans + s.spans,
      failedStarts: a.failedStarts + s.failedStarts,
    }),
    { sessions: 0, renewed: 0, spans: 0, failedStarts: 0 },
  );
}
