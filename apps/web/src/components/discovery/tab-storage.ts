// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-tab UI memory for discovery (the rail's collapsed state, the dismissed welcome strip, recent
 * searches). `sessionStorage`, so nothing outlives the tab and nothing needs the Preferences
 * consent (lib/consent.ts). Every access is wrapped: with storage blocked or throwing, reads come
 * back null and writes are dropped, and the page works the same.
 */

export const RAIL_KEY = "commonair-rail";
export const WELCOME_KEY = "commonair-welcome-dismissed";
export const RECENT_SEARCHES_KEY = "commonair-recent-searches";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readTab(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeTab(key: string, value: string | null): void {
  try {
    const store = storage();
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Blocked or full: the choice lasts until the page unloads, which is fine.
  }
}

/** The rail's stored state: "expanded", "collapsed", or null (follow the screen width). */
export function readRail(): "expanded" | "collapsed" | null {
  const value = readTab(RAIL_KEY);
  return value === "expanded" || value === "collapsed" ? value : null;
}

export const RECENT_SEARCH_LIMIT = 5;

/** The tab's recent searches, newest first, at most {@link RECENT_SEARCH_LIMIT}. */
export function readRecentSearches(): string[] {
  const raw = readTab(RECENT_SEARCHES_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, RECENT_SEARCH_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/**
 * Puts `query` first and returns the new list. Blank queries are not kept. An entry equal to it, or
 * a prefix of it (case-insensitive), is dropped: the search page searches as the viewer types, and
 * "str", "strea", "streamer" should leave one recent search, not three.
 */
export function rememberSearch(query: string, list: readonly string[] = readRecentSearches()): string[] {
  const q = query.trim();
  if (q === "") return [...list];
  const lower = q.toLowerCase();
  const next = [q, ...list.filter((item) => !lower.startsWith(item.toLowerCase()))].slice(0, RECENT_SEARCH_LIMIT);
  writeTab(RECENT_SEARCHES_KEY, JSON.stringify(next));
  return next;
}
