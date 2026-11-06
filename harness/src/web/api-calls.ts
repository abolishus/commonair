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
