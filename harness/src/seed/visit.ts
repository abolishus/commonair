// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `seed-coverage` scenario's pure parts: the URL each `SEED_ROUTES` entry visits, given the
 * seed's store, and what counts as a failed visit. The browser work lives in the scenario.
 */
import type { SeedRoute, SeedValue } from "./routes.ts";
import type { SeedStore } from "./types.ts";

/** The visit's URL path, or why a value it needs is missing from the store. */
export type ResolvedRoute = { ok: true; url: string } | { ok: false; missing: string };

function valueOf(v: SeedValue, store: SeedStore): string | null {
  if ("fixed" in v) return v.fixed;
  if ("channelOf" in v) return store.channels.find((c) => c.ownerHandle === v.channelOf)?.slug ?? null;
  const [unit, key] = v.extra;
  const got = store.extra[unit]?.[key];
  return typeof got === "string" && got.length > 0 ? got : null;
}

const describe = (v: SeedValue) =>
  "fixed" in v ? v.fixed : "channelOf" in v ? `${v.channelOf}'s channel` : `store.extra.${v.extra.join(".")}`;

/** Fill a route path's `$param` segments and query from the store. Pure. */
export function resolveSeedRoute(path: string, route: SeedRoute, store: SeedStore): ResolvedRoute {
  let url = path;
  for (const name of [...path.matchAll(/\$([A-Za-z]+)/g)].map((m) => m[1] as string)) {
    const v = route.params?.[name];
    if (!v) return { ok: false, missing: `no value for $${name}` };
    const got = valueOf(v, store);
    if (got === null) return { ok: false, missing: describe(v) };
    url = url.replace(`$${name}`, encodeURIComponent(got));
  }
  if (route.query) {
    const q = valueOf(route.query, store);
    if (q === null) return { ok: false, missing: describe(route.query) };
    url = `${url}?${q.replace(/^\?/, "")}`;
  } else if (route.queryParam) {
    const [name, v] = route.queryParam;
    const got = valueOf(v, store);
    if (got === null) return { ok: false, missing: describe(v) };
    url = `${url}?${encodeURIComponent(name)}=${encodeURIComponent(got)}`;
  }
  return { ok: true, url };
}

/** What a visit saw once the page settled. */
export interface VisitObservation {
  /** HTTP status of the document, when the navigation had a response. */
  documentStatus: number | null;
  /** Error responses (4xx/5xx) from the web app or the API while the page loaded. */
  errorResponses: readonly { url: string; status: number }[];
  /** Titles of the `<EmptyState>`s on the page (an empty string for one without a title). */
  emptyStates: readonly string[];
  /** The router's error boundary rendered. */
  errorBoundary: boolean;
}

/**
 * Why a visit failed, empty when it passed. Every route fails on an error boundary or a 5xx; a
 * route that should show seeded data also fails on an empty state (other than its `okEmpty`) or
 * any 4xx. Pure.
 */
export function visitProblems(route: Pick<SeedRoute, "expectData" | "okEmpty">, o: VisitObservation): string[] {
  const out: string[] = [];
  if (o.errorBoundary) out.push("error boundary");
  const limit = route.expectData ? 400 : 500;
  if (o.documentStatus !== null && o.documentStatus >= limit) out.push(`document ${o.documentStatus}`);
  for (const r of o.errorResponses) if (r.status >= limit) out.push(`${r.status} ${r.url}`);
  const ok = new Set(route.okEmpty ?? []);
  if (route.expectData)
    for (const title of o.emptyStates) if (!ok.has(title)) out.push(title ? `empty state "${title}"` : "empty state");
  return out;
}

/** The logins the routes visit as, in first-seen order, without `anonymous`. Pure. */
export function loginsOf(routes: Readonly<Record<string, SeedRoute>>): string[] {
  return [...new Set(Object.values(routes).map((r) => r.as))].filter((h) => h !== "anonymous");
}

/** Strip a URL to origin and path for the report: queries can carry tokens (overlays, unsubscribe). Pure. */
export function reportUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * The crawl's pace. The API's `default` bucket allows 120 calls a minute per signed-in user
 * (`services/api/src/lib/ratelimit.ts`), and every call a page makes counts, its server render's
 * included. A person never walks twenty pages a minute; the crawl does, so it waits for room
 * instead of the limit being raised.
 */
export const CRAWL_PACE = {
  /** The API's default bucket, plus a second of margin for clock skew. */
  max: 120,
  windowMs: 61_000,
  /** Room left for the next page's calls: a heavy page (the channel page, a studio page) makes about this many. */
  pageCalls: 30,
  /** Calls a server render makes for the user (bootstrap and the route's loaders), which the browser never sees. */
  serverCallsPerPage: 6,
} as const;

/** How long to wait before the next page so its calls fit in the window, given the calls already made. Pure. */
export function crawlWaitMs(
  calls: readonly number[],
  nowMs: number,
  pace: { readonly max: number; readonly windowMs: number; readonly pageCalls: number } = CRAWL_PACE,
): number {
  const live = calls.filter((t) => t > nowMs - pace.windowMs).sort((a, b) => a - b);
  const allowed = pace.max - pace.pageCalls;
  if (live.length < allowed) return 0;
  // The call whose expiry brings the count under `allowed`.
  const blocking = live[live.length - allowed] as number;
  return Math.max(0, blocking + pace.windowMs - nowMs);
}

/**
 * Sign-ins through the web UI. Every login signs in from this one machine, so they share the
 * API's per-address `auth` bucket (10 writes a minute); with logins crawled side by side, several
 * can start within a second. Six a window leaves room for anything else signing in from here.
 */
export const SIGN_IN_PACE = { max: 10, windowMs: 61_000, pageCalls: 4 } as const;

/**
 * Logins crawled side by side. Each signed-in login spends its own user's rate-limit bucket, so a
 * login's pacing never slows another; the crawl takes about as long as its slowest login. Three
 * keeps browser pages on a CI runner (beside the stack and `seed live`) few enough to settle.
 */
export const CRAWL_CONCURRENCY = 3;

/**
 * The routes grouped by login, the logins with the most routes first (ties in first-seen order),
 * so the long, rate-limit-bound ones start at once and the short ones fill in around them. Every
 * route appears exactly once. Pure.
 */
export function crawlQueue(routes: Readonly<Record<string, SeedRoute>>): [string, [string, SeedRoute][]][] {
  const byLogin = new Map<string, [string, SeedRoute][]>();
  for (const [path, route] of Object.entries(routes))
    byLogin.set(route.as, [...(byLogin.get(route.as) ?? []), [path, route]]);
  // Array.prototype.sort is stable, so equal counts keep first-seen order.
  return [...byLogin].sort((a, b) => b[1].length - a[1].length);
}

/** `--set crawlConcurrency=N`: a positive integer, at most the number of logins. Pure. */
export function crawlConcurrency(raw: number, logins: number): number {
  if (!Number.isInteger(raw) || raw < 1) throw new Error(`--set crawlConcurrency=${raw}: a positive integer`);
  return Math.max(1, Math.min(raw, logins));
}
