// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which browser requests are API calls, and which are still unanswered. A page that waits on
 * data it never gets otherwise fails as a bare selector timeout; these let a session say whether
 * the call was refused (429), failed (502), errored or never came back.
 */

/**
 * The path to log for a same-origin API request, or null for anything else. RPC procedure
 * paths are kept whole; `/api/...` is cut after the flow name, since a token can follow it.
 * The query is never kept.
 */
export function apiPath(url: string, webOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== new URL(webOrigin).origin) return null;
  const path = parsed.pathname;
  if (path === "/rpc" || path.startsWith("/rpc/")) return path;
  if (path.startsWith("/api/")) return path.split("/").slice(0, 4).join("/");
  return null;
}

/** In-flight API calls per request object, so the ones still pending can be named. */
export class PendingCalls<K> {
  private readonly started = new Map<K, { path: string; atMs: number }>();

  start(key: K, path: string, atMs: number): void {
    this.started.set(key, { path, atMs });
  }

  finish(key: K): void {
    this.started.delete(key);
  }

  /** Calls started at least `minAgeMs` before `nowMs`, oldest first. */
  olderThan(nowMs: number, minAgeMs: number): { path: string; ageMs: number }[] {
    return [...this.started.values()]
      .map((c) => ({ path: c.path, ageMs: nowMs - c.atMs }))
      .filter((c) => c.ageMs >= minAgeMs)
      .toSorted((a, b) => b.ageMs - a.ageMs);
  }
}

/** The window the API's rate-limit buckets count over (services/api `rateLimits`: per 60 s). */
export const RATE_WINDOW_MS = 60_000;

/** What a session sent the API in the last window, for a 429's log line. */
export interface RecentCallCounts {
  windowMs: number;
  /** API calls the browser made (all of this session's pages). */
  apiCalls: number;
  /** Main-frame document loads: each one also makes server-render API calls the browser never sees. */
  documents: number;
  /** API calls per path, busiest first. */
  byPath: { path: string; count: number }[];
}

/**
 * A session's API calls and document loads over the last rate-limit window. The API's default
 * bucket is per user, so a 429 log line can say whether this session alone came near it. It
 * cannot see server-render calls (only how many documents caused them), the harness's own API
 * client, or another session signed in as the same user.
 */
export class RecentCalls {
  private calls: { path: string; atMs: number }[] = [];
  private docs: number[] = [];

  constructor(private readonly windowMs = RATE_WINDOW_MS) {}

  call(path: string, atMs: number): void {
    this.calls.push({ path, atMs });
    this.prune(atMs);
  }

  document(atMs: number): void {
    this.docs.push(atMs);
    this.prune(atMs);
  }

  /** Counts for calls and loads after `nowMs - windowMs`. */
  counts(nowMs: number): RecentCallCounts {
    this.prune(nowMs);
    const byPath = new Map<string, number>();
    for (const c of this.calls) byPath.set(c.path, (byPath.get(c.path) ?? 0) + 1);
    return {
      windowMs: this.windowMs,
      apiCalls: this.calls.length,
      documents: this.docs.length,
      byPath: [...byPath]
        .map(([path, count]) => ({ path, count }))
        .toSorted((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    };
  }

  private prune(nowMs: number): void {
    const since = nowMs - this.windowMs;
    // Entries arrive in time order, so the oldest one says whether anything is stale.
    if ((this.calls[0]?.atMs ?? Infinity) <= since) this.calls = this.calls.filter((c) => c.atMs > since);
    if ((this.docs[0] ?? Infinity) <= since) this.docs = this.docs.filter((t) => t > since);
  }
}

/**
 * The rate-limit headers of an error response, for its log line. The API sends `retry-after`
 * on a 429; the others are kept in case a limiter in front of it sends them.
 */
export function rateLimitHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (n === "retry-after" || n.startsWith("ratelimit") || n.startsWith("x-ratelimit")) out[n] = value;
  }
  return out;
}
