// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Every route shows seeded data": who visits each web route after `seed full`, and where its path
 * params and query come from. The `seed-coverage` scenario signs in as `as` and fails on an empty
 * state, an error boundary or an error response. A test checks that this lists exactly the routes
 * in `apps/web/src/routeTree.gen.ts`, so a new route cannot ship without an entry.
 */
import type { SeedUnitName } from "./types.ts";

/**
 * A value seed-social knows (a fixed login's channel slug), one a unit publishes in `store.extra`, or
 * a fixed value every seed has (a category slug from `social/content.ts`).
 */
export type SeedValue = { channelOf: string } | { extra: readonly [SeedUnitName, string] } | { fixed: string };

export interface SeedRoute {
  /** A fixed login handle, or `anonymous`. */
  as: string;
  params?: Readonly<Record<string, SeedValue>>;
  /** A query string (without `?`) published by a unit. */
  query?: SeedValue;
  /** One query parameter from a seed value, encoded (instead of `query`), e.g. `q` = a channel slug. */
  queryParam?: readonly [string, SeedValue];
  /** False for forms and pages that hold no list data (only checked for errors). */
  expectData: boolean;
  /** Empty-state titles that are a valid result here (an all-clear drawn with the empty state). */
  okEmpty?: readonly string[];
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
  // W2-vod-watch: streamer1's public VOD and a clip of it, published by seed-media.
  "/$channel/vods/$vodId": { ...viewer, params: { channel: ch("streamer1"), vodId: ex("media", "vodId") } },
  "/$channel/clips/$clipId": { ...viewer, params: { channel: ch("streamer1"), clipId: ex("media", "clipId") } },
  // W3-giveaways: the public verify page of streamer1's drawn giveaway, published by seed-interact.
  "/$channel/giveaways/$giveawayId": {
    as: "anonymous",
    params: { channel: ch("streamer1"), giveawayId: ex("interact", "giveawayId") },
    expectData: true,
  },
  // W3-portability: the landing of one of streamer1's move links, published by seed-social.
  "/m/$channel/$nonce": { ...viewer, params: { channel: ch("streamer1"), nonce: ex("social", "moveLinkNonce") } },
  // D1-web: the directory, one seeded category (streamer1 is live in Art) and a search.
  "/directory/": viewer,
  "/directory/$category": { ...viewer, params: { category: { fixed: "art" } } },
  // Slugs carry the run's prefix, and search matches a slug's start: search for streamer1's own.
  "/search": { ...viewer, queryParam: ["q", ch("streamer1")] },
  "/embed/$channel": { as: "anonymous", params: { channel: ch("streamer1") }, expectData: true },
  "/signin": form,
  "/signup": form,
  "/dmca": form,
  "/takedown": form,
  "/transparency": { as: "anonymous", expectData: true },
  // W2b-attestations: the public verifier (a form until a statement is pasted or linked).
  "/attestations/verify": form,
  "/activate": { as: "viewer1", query: ex("platform", "activateQuery"), expectData: false },
  "/oauth2/authorize": { as: "viewer1", query: ex("platform", "authorizeQuery"), expectData: true },

  // The settings layout (D5-settings); `/settings/` redirects to subscriptions.
  "/settings": viewer,
  "/settings/": viewer,
  "/settings/privacy": viewer,
  "/settings/connections": viewer,
  "/settings/preferences": viewer,
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
  // W3-jury: opt-in and published results; the jury ships off (no panel after the seed).
  "/coop/jury": { as: "member1", expectData: true },

  // Live and healthy, the stream-health panel says so with the empty state (dashboard.health.healthy).
  "/dashboard": { ...studio, okEmpty: ["No problems detected", "Nothing yet"] },
  "/dashboard/settings": studio,
  "/mod/$channel": {
    ...studio,
    params: { channel: ch("streamer1") },
    okEmpty: ["No held messages", "No mod actions yet"],
  },
  "/content": studio,
  "/revenue": studio,
  "/chat": studio,
  "/relays": studio,
  "/interact": studio,
  "/bot": studio,
  "/overlays": studio,
  // W2 studio pages: crew splits, captions settings and corrections, analytics. Rehearse is idle
  // (nothing armed) after the seed, so it is only checked for errors.
  "/crew": studio,
  "/captions": studio,
  "/analytics": studio,
  "/rehearse": { as: "streamer1", expectData: false },
  // Batch 7 studio pages: streamer1's move links (the seeded one), and the Twitch import, which
  // shows its unavailable state on the default stack (TWITCH_IMPORT_ENABLED off).
  "/move": studio,
  "/import": { as: "streamer3", expectData: true },
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
  // N4-web: domain blocks and key rotation; federation ships off, so no data after the seed.
  "/admin/federation": { as: "admin", expectData: true },
  "/treasury": { as: "treasurer", expectData: true },
};

/** The full paths `FileRoutesByFullPath` declares in a generated route tree (its source text). Pure. */
export function routeTreeFullPaths(source: string): string[] {
  const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (!block) throw new Error("routeTree.gen.ts: FileRoutesByFullPath not found");
  return [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1] as string).sort();
}
