// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 raw HTTP routes (contract step §5.3), matched in `http.ts` before the OpenAPI handler.
 * Caddy rewrites `/.well-known/{webfinger,nodeinfo,commonair-portability}` and `/nodeinfo/*` under
 * `/api` (as it does `/.well-known/commonair-attestation`) and proxies `/ap/*` unchanged, so these
 * are the paths the API sees. Pure, unit-tested.
 */
import type { ApiEnv } from "./env.ts";

export const WELL_KNOWN_PATHS = {
  webfinger: "/api/.well-known/webfinger",
  nodeinfo: "/api/.well-known/nodeinfo",
  /** The standing-statement key history (decision (n)). */
  portability: "/api/.well-known/commonair-portability",
} as const;
export const NODEINFO_PATH = "/api/nodeinfo/2.1";
export const SHARED_INBOX_PATH = "/ap/inbox";
/** The redirect URI registered with Twitch for the import (ADR 0031). */
export const TWITCH_IMPORT_CALLBACK_PATH = "/api/twitch-import/callback";

/** The actor id path of a channel (`https://<domain>/ap/channels/<uuid>`). */
export const actorPath = (channelId: string) => `/ap/channels/${channelId}`;

export type FederationRoute =
  | { kind: "webfinger" }
  | { kind: "nodeinfoLinks" }
  | { kind: "nodeinfo" }
  | { kind: "actor"; channelId: string }
  | { kind: "outbox"; channelId: string }
  | { kind: "followers"; channelId: string }
  | { kind: "inbox"; channelId: string }
  | { kind: "sharedInbox" };

export interface FederationMatch {
  route: FederationRoute;
  /** The one method the route serves; anything else is 405. */
  method: "GET" | "POST";
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const AP_CHANNEL = new RegExp(`^/ap/channels/(${UUID})(?:/(outbox|followers|inbox))?$`, "i");

/** The federation route for `path`, or null when it is not one. */
export function matchFederationRoute(path: string): FederationMatch | null {
  if (path === WELL_KNOWN_PATHS.webfinger) return { route: { kind: "webfinger" }, method: "GET" };
  if (path === WELL_KNOWN_PATHS.nodeinfo) return { route: { kind: "nodeinfoLinks" }, method: "GET" };
  if (path === NODEINFO_PATH) return { route: { kind: "nodeinfo" }, method: "GET" };
  if (path === SHARED_INBOX_PATH) return { route: { kind: "sharedInbox" }, method: "POST" };
  const m = AP_CHANNEL.exec(path);
  if (!m?.[1]) return null;
  const channelId = m[1].toLowerCase();
  // The regex is case-insensitive, so `/INBOX` must still be the inbox (POST), not a GET.
  const sub = m[2]?.toLowerCase();
  switch (sub) {
    case undefined:
      return { route: { kind: "actor", channelId }, method: "GET" };
    case "inbox":
      return { route: { kind: "inbox", channelId }, method: "POST" };
    default:
      return { route: { kind: sub as "outbox" | "followers", channelId }, method: "GET" };
  }
}

/** Decision (b): the import exists only with the flag on and both Twitch OAuth credentials set. */
export const twitchImportAvailable = (
  env: Pick<ApiEnv, "TWITCH_IMPORT_ENABLED" | "OAUTH_TWITCH_CLIENT_ID" | "OAUTH_TWITCH_CLIENT_SECRET">,
): boolean => Boolean(env.TWITCH_IMPORT_ENABLED && env.OAUTH_TWITCH_CLIENT_ID && env.OAUTH_TWITCH_CLIENT_SECRET);
