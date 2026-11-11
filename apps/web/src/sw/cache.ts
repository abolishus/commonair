// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The app-shell cache (ADR 0028 decision 7): only the build's own static files, never media, API
 * answers, documents or anything that depends on who is signed in. The offline page is built by
 * the worker when a navigation fails (`offline.ts`), so it is never cached either. Pure, so it is
 * unit-tested.
 */

/** Every shell cache is named `commonair-shell-<version>`; nothing else in Cache Storage is ours. */
export const CACHE_PREFIX = "commonair-shell-";

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** Shell caches from an older build (to delete on `activate`); other caches are left alone. */
export function staleCaches(keys: readonly string[], current: string): string[] {
  return keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== current);
}

/**
 * Whether the worker answers this request from the shell cache: a `GET` for this origin whose path
 * is exactly a precached file (no query string). Everything else (`/api`, `/rpc`, `/hls`, media,
 * documents, uploads, other origins) is not intercepted, as if there were no worker.
 */
export function shouldServeFromCache(
  request: { method: string; url: string },
  origin: string,
  precache: ReadonlySet<string>,
): boolean {
  if (request.method !== "GET") return false;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  return url.origin === origin && url.search === "" && precache.has(url.pathname);
}

/** The shell's path prefixes: the only requests the fetch listener may answer. */
export const SHELL_PREFIXES = ["/assets/", "/icons/"] as const;

/** Pages that run inside other software and sites (OBS, embeds): never answered by the worker. */
export const UNCONTROLLED_PREFIXES = ["/overlay/", "/embed/"] as const;

/** A Static Routing API condition, as far as it is used here. */
export type RouterCondition =
  | { urlPattern: string }
  | { requestMode: "navigate" }
  | { or: RouterCondition[] }
  | { not: RouterCondition };

/** One Static Routing API rule (`InstallEvent.addRoutes`); the first rule that matches wins. */
export interface RouterRule {
  condition: RouterCondition;
  source: "network";
}

/**
 * The Static Routing API rules: overlay and embed pages, and every request that is neither the
 * shell nor a page navigation, go straight to the network without starting the worker or
 * dispatching `fetch` (`/api`, `/rpc`, each LL-HLS playlist and part under `/hls`, media).
 * Navigations reach the listener only so a failed one can show the offline page (README D7.6);
 * navigation preload starts their network request while the worker boots. Browsers without the
 * API fall back to the listener, which declines the same requests.
 */
export function networkRouterRules(): RouterRule[] {
  return [
    {
      condition: { or: UNCONTROLLED_PREFIXES.map((prefix) => ({ urlPattern: `${prefix}*` })) },
      source: "network",
    },
    {
      condition: {
        not: {
          or: [...SHELL_PREFIXES.map((prefix) => ({ urlPattern: `${prefix}*` })), { requestMode: "navigate" as const }],
        },
      },
      source: "network",
    },
  ];
}

/**
 * Whether a request is a page navigation the worker watches for failure (to answer with the
 * offline page): a same-origin `GET` navigation, outside the overlay and embed pages. Its answer
 * is the network's, untouched and never cached.
 */
export function isWatchedNavigation(request: { method: string; mode: string; url: string }, origin: string): boolean {
  if (request.method !== "GET" || request.mode !== "navigate") return false;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  return url.origin === origin && !UNCONTROLLED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/** Register the rules where the browser has the API; never fails the install. */
export async function addNetworkRoutes(event: object): Promise<boolean> {
  const add = (event as { addRoutes?: (rules: RouterRule[]) => Promise<void> }).addRoutes;
  if (typeof add !== "function") return false;
  try {
    await add.call(event, networkRouterRules());
    return true;
  } catch {
    // An older implementation without `not`/`or`: the fetch listener still declines these.
    return false;
  }
}
