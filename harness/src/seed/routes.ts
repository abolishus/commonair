// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Every route shows seeded data": who visits each web route after `seed full`, and where its path
 * params and query come from. The `seed-coverage` scenario signs in as `as` and fails on an empty
 * state, an error boundary or an error response. A test checks that this lists exactly the routes
 * in `apps/web/src/routeTree.gen.ts`, so a new route cannot ship without an entry.
 */
import type { SeedUnitName } from "./types.ts";

/** A value seed-social knows (a fixed login's channel slug) or one a unit publishes in `store.extra`. */
export type SeedValue = { channelOf: string } | { extra: readonly [SeedUnitName, string] };

export interface SeedRoute {
  /** A fixed login handle, or `anonymous`. */
  as: string;
  params?: Readonly<Record<string, SeedValue>>;
  /** A query string (without `?`) published by a unit. */
  query?: SeedValue;
  /** False for forms and pages that hold no list data (only checked for errors). */
  expectData: boolean;
}

const ch = (handle: string): SeedValue => ({ channelOf: handle });
const ex = (unit: SeedUnitName, key: string): SeedValue => ({ extra: [unit, key] });
const studio: SeedRoute = { as: "streamer1", expectData: true };
const admin: SeedRoute = { as: "admin", expectData: true };
const member: SeedRoute = { as: "member1", expectData: true };
const viewer: SeedRoute = { as: "viewer1", expectData: true };
const form: SeedRoute = { as: "anonymous", expectData: false };

export const SEED_ROUTES: Readonly<Record<string, SeedRoute>> = {
  "/": viewer,
  "/$channel": { ...viewer, params: { channel: ch("streamer1") } },
  "/embed/$channel": { as: "anonymous", params: { channel: ch("streamer1") }, expectData: true },
  "/signin": form,
  "/signup": form,
  "/dmca": form,
  "/takedown": form,
  "/transparency": { as: "anonymous", expectData: true },
  "/activate": { as: "viewer1", query: ex("platform", "activateQuery"), expectData: false },
  "/oauth2/authorize": { as: "viewer1", query: ex("platform", "authorizeQuery"), expectData: true },

  "/settings/privacy": viewer,
  "/settings/connections": viewer,
  "/settings/subscriptions": viewer,
  "/settings/notifications/": viewer,
  "/settings/notifications/unsubscribe": {
    as: "anonymous",
    query: ex("platform", "unsubscribeQuery"),
    expectData: false,
  },
  "/settings/appeals": { as: "viewer2", expectData: true },
  "/settings/copyright": { as: "viewer2", expectData: true },

  "/coop/": member,
  "/coop/membership": member,
  "/coop/council": { as: "council1", expectData: true },
  "/coop/settings": member,
  "/coop/proposals/": member,
  "/coop/proposals/new": { as: "member1", expectData: false },
  "/coop/proposals/$id/": { ...member, params: { id: ex("coop", "proposalId") } },
  "/coop/proposals/$id/edit": { ...member, params: { id: ex("coop", "draftProposalId") } },
  "/coop/patronage/": member,
  "/coop/patronage/$periodId": { ...member, params: { periodId: ex("coop", "patronagePeriodId") } },

  "/dashboard": studio,
  "/content": studio,
  "/revenue": studio,
  "/chat": studio,
  "/relays": studio,
  "/interact": studio,
  "/bot": studio,
  "/overlays": studio,
  "/developer/": { as: "developer", expectData: true },
  "/developer/bots": { as: "developer", expectData: true },
  "/developer/apps/$appId": { as: "developer", params: { appId: ex("platform", "appId") }, expectData: true },
  "/overlay/chat": { as: "anonymous", query: ex("interact", "overlayChatQuery"), expectData: true },
  "/overlay/alerts": { as: "anonymous", query: ex("interact", "overlayAlertsQuery"), expectData: true },
  "/overlay/goals": { as: "anonymous", query: ex("interact", "overlayGoalsQuery"), expectData: true },

  "/admin/moderation": admin,
  "/admin/appeals": admin,
  "/admin/integrity": admin,
  "/admin/dmca": admin,
  "/admin/egress": admin,
  "/admin/incidents": admin,
  "/admin/legal": { as: "legal", expectData: true },
  "/admin/apps": admin,
  "/admin/coop": admin,
  "/treasury": { as: "treasurer", expectData: true },
};

/** The full paths `FileRoutesByFullPath` declares in a generated route tree (its source text). Pure. */
export function routeTreeFullPaths(source: string): string[] {
  const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (!block) throw new Error("routeTree.gen.ts: FileRoutesByFullPath not found");
  return [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1] as string).sort();
}
