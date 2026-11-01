// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The batch 7 raw-route matcher (contract step §5.3) and the Twitch import availability rule. */
import { describe, expect, test } from "vite-plus/test";
import {
  actorPath,
  matchFederationRoute,
  NODEINFO_PATH,
  SHARED_INBOX_PATH,
  twitchImportAvailable,
  WELL_KNOWN_PATHS,
} from "../src/raw-routes.ts";

const ID = "01890000-0000-7000-8000-00000000c001";

describe("matchFederationRoute", () => {
  test("discovery documents are matched under /api only (Caddy rewrites the bare paths)", () => {
    expect(matchFederationRoute(WELL_KNOWN_PATHS.webfinger)).toEqual({ route: { kind: "webfinger" }, method: "GET" });
    expect(matchFederationRoute(WELL_KNOWN_PATHS.nodeinfo)).toEqual({
      route: { kind: "nodeinfoLinks" },
      method: "GET",
    });
    expect(matchFederationRoute(NODEINFO_PATH)).toEqual({ route: { kind: "nodeinfo" }, method: "GET" });
    expect(matchFederationRoute("/.well-known/webfinger")).toBeNull();
    expect(matchFederationRoute("/nodeinfo/2.1")).toBeNull();
    expect(matchFederationRoute("/api/nodeinfo/2.0")).toBeNull();
    // The portability keys are not a federation route: they are served with the flag off too.
    expect(matchFederationRoute(WELL_KNOWN_PATHS.portability)).toBeNull();
  });

  test("actor, collections and inboxes under /ap", () => {
    expect(matchFederationRoute(actorPath(ID))).toEqual({ route: { kind: "actor", channelId: ID }, method: "GET" });
    expect(matchFederationRoute(`${actorPath(ID)}/outbox`)).toEqual({
      route: { kind: "outbox", channelId: ID },
      method: "GET",
    });
    expect(matchFederationRoute(`${actorPath(ID)}/followers`)).toEqual({
      route: { kind: "followers", channelId: ID },
      method: "GET",
    });
    expect(matchFederationRoute(`${actorPath(ID)}/inbox`)).toEqual({
      route: { kind: "inbox", channelId: ID },
      method: "POST",
    });
    expect(matchFederationRoute(SHARED_INBOX_PATH)).toEqual({ route: { kind: "sharedInbox" }, method: "POST" });
  });

  test("an upper-case id is normalized; anything else under /ap is not a route", () => {
    expect(matchFederationRoute(`/ap/channels/${ID.toUpperCase()}/OUTBOX`)).toEqual({
      route: { kind: "outbox", channelId: ID },
      method: "GET",
    });
    for (const p of [
      "/ap",
      "/ap/",
      "/ap/channels",
      "/ap/channels/not-a-uuid",
      `/ap/channels/${ID}/`,
      `/ap/channels/${ID}/following`,
      `/ap/channels/${ID}/inbox/extra`,
      `/ap/channels/${ID}/../inbox`,
      "/ap/inbox/",
      `/api/ap/channels/${ID}`,
      "/m/slug/nonce",
    ])
      expect(matchFederationRoute(p), p).toBeNull();
  });
});

describe("twitchImportAvailable (decision (b))", () => {
  const env = (enabled: boolean, id: string, secret: string) => ({
    TWITCH_IMPORT_ENABLED: enabled,
    OAUTH_TWITCH_CLIENT_ID: id,
    OAUTH_TWITCH_CLIENT_SECRET: secret,
  });
  test("needs the flag and both credentials", () => {
    expect(twitchImportAvailable(env(true, "id", "secret"))).toBe(true);
    expect(twitchImportAvailable(env(false, "id", "secret"))).toBe(false);
    expect(twitchImportAvailable(env(true, "", "secret"))).toBe(false);
    expect(twitchImportAvailable(env(true, "id", ""))).toBe(false);
  });
});
