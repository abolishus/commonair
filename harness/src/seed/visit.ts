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
