// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { chatStatusView, nameColorIndex } from "../src/chat/view.ts";
import { en } from "../src/i18n/en.ts";
import { healthBadge } from "../src/lib/stream-health.ts";
import { isTreasurer } from "../src/lib/money.ts";
import {
  accountMenu,
  adminNav,
  clipWatchLink,
  coopNav,
  footerColumns,
  siteNav,
  studioNav,
  vodWatchLink,
} from "../src/lib/nav.ts";
import { adminPageFor, mayOpenAdminPage } from "../src/components/safety/access.ts";

describe("site nav", () => {
  it("links the directory (D1: /directory) and marks it current there, on categories and on search", () => {
    expect(siteNav("/directory")).toEqual([
      { id: "directory", to: "/directory", current: true },
      { id: "coop", to: "/coop", current: false },
    ]);
    expect(siteNav("/directory/art")[0]?.current).toBe(true);
    expect(siteNav("/search")[0]?.current).toBe(true);
    expect(siteNav("/")[0]?.current).toBe(false);
    expect(siteNav("/rivertide")[0]?.current).toBe(false);
    expect(siteNav("/dashboard")[0]?.current).toBe(false);
  });

  it("links the co-op and marks it current on every /coop page", () => {
    for (const path of ["/coop", "/coop/", "/coop/membership", "/coop/proposals/x"])
      expect(siteNav(path).map((i) => [i.id, i.current])).toEqual([
        ["directory", false],
        ["coop", true],
      ]);
    expect(siteNav("/cooper").find((i) => i.id === "coop")?.current).toBe(false);
    expect(siteNav("/transparency").find((i) => i.id === "coop")?.current).toBe(false);
  });

  it("ignores trailing slashes", () => {
    expect(siteNav("/directory//")[0]?.current).toBe(true);
  });
});

describe("account menu", () => {
  it("signed in: your channel, creator studio, following, settings, co-op membership, then sign out after a separator", () => {
    const items = accountMenu(true, { channel: "rivertide" });
    expect(items.map((i) => i.id)).toEqual(["channel", "studio", "following", "settings", "coop", "signOut"]);
    expect(items.map((i) => i.to)).toEqual([
      "/$channel",
      "/dashboard",
      "/following",
      "/settings",
      "/coop/membership",
      undefined,
    ]);
    expect(items[0]?.params).toEqual({ channel: "rivertide" });
    expect(items.at(-1)).toMatchObject({ separatorBefore: true, destructive: true });
    expect(items.slice(0, -1).every((i) => !i.destructive && !i.separatorBefore)).toBe(true);
  });

  it("leaves out Your channel without a channel; relays and the settings pages are not in it", () => {
    for (const channel of [undefined, null, ""]) {
      const ids = accountMenu(true, { channel }).map((i) => i.id);
      expect(ids).toEqual(["studio", "following", "settings", "coop", "signOut"]);
    }
    const ids: string[] = accountMenu(true, { channel: "x", treasurer: true, admin: true }).map((i) => i.id);
    for (const gone of ["relays", "dashboard", "subscriptions", "notifications", "privacy", "preferences"])
      expect(ids).not.toContain(gone);
  });

  it("adds Mod view after Creator studio when the member moderates elsewhere (J5-a)", () => {
    for (const moderates of [undefined, [], ["rivertide"]])
      expect(accountMenu(true, { channel: "rivertide", moderates }).some((i) => i.id === "modView")).toBe(false);
    const items = accountMenu(true, { channel: "rivertide", moderates: ["rivertide", "birch", "cedar"] });
    expect(items.map((i) => i.id)).toEqual([
      "channel",
      "studio",
      "modView",
      "following",
      "settings",
      "coop",
      "signOut",
    ]);
    expect(items[2]).toEqual({ id: "modView", to: "/mod/$channel", params: { channel: "birch" } });
  });

  it("adds co-op administration for admins only, before sign out", () => {
    expect(accountMenu(true, { admin: false }).some((i) => i.id === "adminCoop")).toBe(false);
    expect(accountMenu(true).some((i) => i.id === "adminCoop")).toBe(false);
    const items = accountMenu(true, { admin: true, safetyStaff: true });
    expect(items.map((i) => i.id)).toEqual([
      "studio",
      "following",
      "settings",
      "coop",
      "moderation",
      "adminCoop",
      "signOut",
    ]);
    expect(items.find((i) => i.id === "adminCoop")?.to).toBe("/admin/coop");
  });

  it("adds the treasury for treasurers only, before sign out", () => {
    expect(accountMenu(true, { treasurer: false }).some((i) => i.id === "treasury")).toBe(false);
    const items = accountMenu(true, { treasurer: true });
    expect(items.map((i) => i.id)).toEqual(["studio", "following", "settings", "coop", "treasury", "signOut"]);
    expect(items.find((i) => i.id === "treasury")?.to).toBe("/treasury");
  });

  it("treasurer visibility follows the session role", () => {
    const me = { id: "u", username: "a", displayName: "A", channelSlug: null };
    expect(isTreasurer(null)).toBe(false);
    expect(isTreasurer(undefined)).toBe(false);
    expect(isTreasurer(me)).toBe(false);
    expect(isTreasurer({ ...me, role: "user" })).toBe(false);
    expect(isTreasurer({ ...me, role: "admin" })).toBe(false);
    expect(isTreasurer({ ...me, role: "treasurer" })).toBe(true);
    expect(accountMenu(true, { treasurer: isTreasurer({ ...me, role: "treasurer" }) }).at(-2)?.id).toBe("treasury");
  });

  it("signed out: sign in and sign up, the current page marked", () => {
    expect(accountMenu(false, "/")).toEqual([
      { id: "signIn", to: "/signin", current: false },
      { id: "signUp", to: "/signup", current: false },
    ]);
    expect(accountMenu(false, "/signin").map((i) => i.current)).toEqual([true, false]);
    expect(accountMenu(false, "/signup/").map((i) => i.current)).toEqual([false, true]);
  });

  it("links only these pages (/following comes with the discovery batch)", () => {
    const targets = [
      ...accountMenu(true, { channel: "x", treasurer: true, admin: true }),
      ...accountMenu(false, "/"),
    ].flatMap((i) => (i.to ? [i.to] : []));
    expect(new Set(targets)).toEqual(
      new Set([
        "/$channel",
        "/dashboard",
        "/following",
        "/settings",
        "/coop/membership",
        "/treasury",
        "/admin/coop",
        "/signin",
        "/signup",
      ]),
    );
  });
});

describe("studio nav", () => {
  it("lists stream manager, rehearsal, overlays, polls and raids, the bot, captions, content, analytics, schedule, revenue, crew, relays, move, import and developer, nothing else", () => {
    expect(studioNav("/dashboard", { twitchImport: true }).map((i) => [i.id, i.to])).toEqual([
      ["streamManager", "/dashboard"],
      ["rehearse", "/rehearse"],
      ["overlays", "/overlays"],
      ["interact", "/interact"],
      ["bot", "/bot"],
      ["captions", "/captions"],
      ["content", "/content"],
      ["analytics", "/analytics"],
      ["schedule", "/schedule"],
      ["revenue", "/revenue"],
      ["crew", "/crew"],
      ["relays", "/relays"],
      ["move", "/move"],
      ["import", "/import"],
      ["developer", "/developer"],
    ]);
  });

  it.each([
    ["/dashboard", "streamManager"],
    ["/rehearse", "rehearse"],
    ["/rehearse/", "rehearse"],
    ["/captions", "captions"],
    ["/analytics", "analytics"],
    ["/analytics/", "analytics"],
    ["/schedule", "schedule"],
    ["/schedule/", "schedule"],
    ["/crew", "crew"],
    ["/crew/", "crew"],
    ["/overlays", "overlays"],
    ["/overlays/", "overlays"],
    ["/interact", "interact"],
    ["/bot", "bot"],
    ["/bot/", "bot"],
    ["/content", "content"],
    ["/revenue", "revenue"],
    ["/revenue/", "revenue"],
    ["/relays", "relays"],
    ["/relays/", "relays"],
    ["/move", "move"],
    ["/move/", "move"],
    ["/import", "import"],
    ["/import/", "import"],
    ["/developer", "developer"],
    ["/developer/", "developer"],
    ["/developer/apps/0193e6a0-0000-7000-8000-000000000001", "developer"],
    ["/developer/bots", "developer"],
  ])("on %s marks %s current (and only it)", (path, id) => {
    const current = studioNav(path, { twitchImport: true }).filter((i) => i.current);
    expect(current.map((i) => i.id)).toEqual([id]);
  });

  it("shows Import from Twitch only when the instance offers it (flag, credentials, never --no-proprietary)", () => {
    expect(studioNav("/dashboard").some((i) => i.id === "import")).toBe(false);
    expect(studioNav("/dashboard", { twitchImport: false }).some((i) => i.id === "import")).toBe(false);
    expect(studioNav("/import").some((i) => i.current)).toBe(false);
  });

  it("adds chat safety after the bot only when the instance runs the watch gate or surge guard", () => {
    expect(studioNav("/dashboard", { chatSafety: false }).some((i) => i.id === "chat")).toBe(false);
    expect(studioNav("/dashboard", { chatSafety: true, twitchImport: true }).map((i) => [i.id, i.to])).toEqual([
      ["streamManager", "/dashboard"],
      ["rehearse", "/rehearse"],
      ["overlays", "/overlays"],
      ["interact", "/interact"],
      ["bot", "/bot"],
      ["chat", "/chat"],
      ["captions", "/captions"],
      ["content", "/content"],
      ["analytics", "/analytics"],
      ["schedule", "/schedule"],
      ["revenue", "/revenue"],
      ["crew", "/crew"],
      ["relays", "/relays"],
      ["move", "/move"],
      ["import", "/import"],
      ["developer", "/developer"],
    ]);
  });

  it.each(["/chat", "/chat/"])("on %s marks chat safety current (and only it)", (path) => {
    expect(
      studioNav(path, { chatSafety: true })
        .filter((i) => i.current)
        .map((i) => i.id),
    ).toEqual(["chat"]);
    // A channel named like it is never the studio's chat page.
    expect(studioNav("/chats", { chatSafety: true }).some((i) => i.current)).toBe(false);
  });

  it("marks nothing current elsewhere", () => {
    expect(studioNav("/").some((i) => i.current)).toBe(false);
    expect(studioNav("/dashboards").some((i) => i.current)).toBe(false);
    // The OBS overlay pages are not the studio's overlays page.
    expect(studioNav("/overlay/alerts").some((i) => i.current)).toBe(false);
    expect(studioNav("/contents").some((i) => i.current)).toBe(false);
    // A channel page is never the studio's bot page.
    expect(studioNav("/bots").some((i) => i.current)).toBe(false);
    expect(studioNav("/developers").some((i) => i.current)).toBe(false);
    // Channels named like the W2 pages are reserved, but a longer path is still not the page.
    for (const path of ["/crews", "/captions/x", "/analytics2", "/rehearsed", "/rivertide/vods/v1"])
      expect(studioNav(path).some((i) => i.current)).toBe(false);
    // Batch 7: a move link's landing page and a giveaway's verify page are not the studio pages.
    for (const path of ["/m/rivertide/abc", "/moves", "/imports", "/import/x", "/rivertide/giveaways/g1"])
      expect(studioNav(path).some((i) => i.current)).toBe(false);
  });
});

describe("co-op tabs", () => {
  it("list overview, membership, proposals, council, the jury, settings, patronage and transparency", () => {
    expect(coopNav()).toEqual([
      { id: "overview", to: "/coop" },
      { id: "membership", to: "/coop/membership" },
      { id: "proposals", to: "/coop/proposals" },
      { id: "council", to: "/coop/council" },
      { id: "jury", to: "/coop/jury" },
      { id: "settings", to: "/coop/settings" },
      { id: "patronage", to: "/coop/patronage" },
      { id: "transparency", to: "/transparency" },
    ]);
  });
});

describe("watch links (W2-vod-watch)", () => {
  it("build the public VOD and clip watch pages as typed router links", () => {
    expect(vodWatchLink("rivertide", "v1")).toEqual({
      to: "/$channel/vods/$vodId",
      params: { channel: "rivertide", vodId: "v1" },
    });
    expect(clipWatchLink("rivertide", "c1")).toEqual({
      to: "/$channel/clips/$clipId",
      params: { channel: "rivertide", clipId: "c1" },
    });
  });
});

describe("footer columns", () => {
  it("Create, Co-op and Legal, in that order, with their pages", () => {
    expect(footerColumns().map((c) => [c.id, c.links.map((l) => l.to)])).toEqual([
      ["create", ["/creators", "/dashboard"]],
      ["coop", ["/coop", "/coop/membership", "/coop/proposals", "/transparency"]],
      ["legal", ["/terms", "/privacy", "/guidelines", "/dmca", "/takedown", "/attestations/verify"]],
    ]);
  });

  it("adds Import from Twitch to Create only where the instance offers it", () => {
    expect(footerColumns({ twitchImport: false })[0]?.links.map((l) => l.id)).toEqual(["creators", "studio"]);
    expect(footerColumns({ twitchImport: true })[0]?.links.map((l) => l.id)).toEqual(["creators", "studio", "import"]);
  });

  it("keeps the public transparency, attestation, takedown and DMCA pages", () => {
    const ids = footerColumns().flatMap((c) => c.links.map((l) => l.id));
    for (const id of ["transparency", "attestations", "takedown", "dmca"] as const) expect(ids).toContain(id);
  });

  it("puts the terms, privacy policy and community guidelines first under Legal", () => {
    expect(
      footerColumns()[2]
        ?.links.slice(0, 3)
        .map((l) => l.id),
    ).toEqual(["terms", "privacy", "guidelines"]);
  });
});

describe("trust and safety navigation", () => {
  it("shows only the queues a role can open", () => {
    const legal = { safetyStaff: true, legal: true, platformModerator: false };
    const moderator = { safetyStaff: true, legal: false, platformModerator: true };
    expect(adminNav("/admin/legal", legal).map((entry) => entry.id)).toEqual(["moderation", "legal"]);
    expect(adminNav("/admin/appeals", moderator).map((entry) => entry.id)).toEqual(["moderation", "appeals", "dmca"]);
    expect(accountMenu(true, legal).map((entry) => entry.id)).toContain("legal");
    expect(accountMenu(true, legal).map((entry) => entry.id)).toContain("moderation");
    expect(accountMenu(true, moderator).map((entry) => entry.id)).toContain("moderation");
    expect(accountMenu(true, moderator).map((entry) => entry.id)).not.toContain("legal");
    expect(adminNav("/admin/coop", { admin: true }).some((entry) => entry.id === "federation")).toBe(false);
    expect(adminNav("/admin/coop", { admin: true, federation: true }).map((entry) => entry)).toEqual([
      { id: "coop", to: "/admin/coop", current: true },
      { id: "integrity", to: "/admin/integrity", current: false },
      { id: "egress", to: "/admin/egress", current: false },
      { id: "incidents", to: "/admin/incidents", current: false },
      { id: "growth", to: "/admin/growth", current: false },
      { id: "apps", to: "/admin/apps", current: false },
      { id: "federation", to: "/admin/federation", current: false },
    ]);
    expect(adminNav("/admin/coop", moderator).map((entry) => entry.id)).not.toContain("coop");
  });

  it("orders the platform tools moderation, appeals, dmca, legal, coop, integrity, egress, incidents, growth, apps, federation", () => {
    const everything = {
      treasurer: false,
      safetyStaff: true,
      platformModerator: true,
      legal: true,
      admin: true,
      federation: true,
    };
    expect(adminNav("/admin/dmca", everything).map((entry) => [entry.id, entry.current])).toEqual([
      ["moderation", false],
      ["appeals", false],
      ["dmca", true],
      ["legal", false],
      ["coop", false],
      ["integrity", false],
      ["egress", false],
      ["incidents", false],
      ["growth", false],
      ["apps", false],
      ["federation", false],
    ]);
    const moderator = { safetyStaff: true, platformModerator: true };
    for (const id of ["integrity", "egress", "incidents", "coop", "apps", "federation"])
      expect(adminNav("/admin/moderation", moderator).map((entry) => entry.id)).not.toContain(id);
  });
});

describe("E7 platform tools access", () => {
  const as = (role: string) => ({ id: "u", username: "a", displayName: "A", channelSlug: null, role });
  it("maps the four E7 admin paths", () => {
    expect(adminPageFor("/admin/dmca")).toBe("dmca");
    expect(adminPageFor("/admin/egress/")).toBe("egress");
    expect(adminPageFor("/admin/incidents")).toBe("incidents");
    expect(adminPageFor("/admin/integrity")).toBe("integrity");
  });
  it("opens the DMCA queue to platform moderators and the other three to admins only", () => {
    expect(mayOpenAdminPage("dmca", as("moderator"))).toBe(true);
    expect(mayOpenAdminPage("dmca", as("admin"))).toBe(true);
    expect(mayOpenAdminPage("dmca", as("legal"))).toBe(false);
    expect(mayOpenAdminPage("dmca", as("user"))).toBe(false);
    for (const page of ["egress", "incidents", "integrity"] as const) {
      expect(mayOpenAdminPage(page, as("admin"))).toBe(true);
      expect(mayOpenAdminPage(page, as("moderator"))).toBe(false);
      expect(mayOpenAdminPage(page, null)).toBe(false);
    }
  });
});

describe("E9 platform tools access", () => {
  const as = (role: string) => ({ id: "u", username: "a", displayName: "A", channelSlug: null, role });
  it("maps /admin/apps and opens it to admins only", () => {
    expect(adminPageFor("/admin/apps")).toBe("apps");
    expect(adminPageFor("/admin/apps/")).toBe("apps");
    expect(mayOpenAdminPage("apps", as("admin"))).toBe(true);
    for (const role of ["moderator", "legal", "treasurer", "user"])
      expect(mayOpenAdminPage("apps", as(role))).toBe(false);
    expect(mayOpenAdminPage("apps", null)).toBe(false);
  });
});

describe("batch 7 platform tools access", () => {
  const as = (role: string) => ({ id: "u", username: "a", displayName: "A", channelSlug: null, role });
  it("maps /admin/federation and opens it to admins only", () => {
    expect(adminPageFor("/admin/federation")).toBe("federation");
    expect(adminPageFor("/admin/federation/")).toBe("federation");
    expect(adminPageFor("/admin/federations")).toBeNull();
    expect(mayOpenAdminPage("federation", as("admin"))).toBe(true);
    for (const role of ["moderator", "legal", "treasurer", "user"])
      expect(mayOpenAdminPage("federation", as(role))).toBe(false);
    expect(mayOpenAdminPage("federation", null)).toBe(false);
    expect(adminNav("/admin/federation", { admin: true, federation: true }).find((e) => e.current)?.id).toBe(
      "federation",
    );
  });
});

describe("overhaul wave 2 platform tools access", () => {
  const as = (role: string) => ({ id: "u", username: "a", displayName: "A", channelSlug: null, role });
  it("maps /admin/growth, opens it to admins only and lists it for them", () => {
    expect(adminPageFor("/admin/growth")).toBe("growth");
    expect(adminPageFor("/admin/growth/")).toBe("growth");
    expect(mayOpenAdminPage("growth", as("admin"))).toBe(true);
    for (const role of ["moderator", "legal", "treasurer", "user"])
      expect(mayOpenAdminPage("growth", as(role))).toBe(false);
    expect(mayOpenAdminPage("growth", null)).toBe(false);
    expect(adminNav("/admin/growth", { admin: true }).find((e) => e.current)?.id).toBe("growth");
    expect(
      adminNav("/admin/moderation", { safetyStaff: true, platformModerator: true }).map((e) => e.id),
    ).not.toContain("growth");
  });
});

describe("chat view", () => {
  it("picks a stable color index in 1..12", () => {
    for (const name of ["", "a", "rivertide", "someone_with_a_long_name", "Ünïcødé"]) {
      const index = nameColorIndex(name);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(12);
      expect(Number.isInteger(index)).toBe(true);
      expect(nameColorIndex(name)).toBe(index);
    }
  });

  it("spreads names over the palette", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => nameColorIndex(`user${i}`)));
    expect(used.size).toBe(12);
  });

  it("maps every connection state to a label and tone", () => {
    expect(chatStatusView("open")).toEqual({ label: en["chat.status.open"], tone: "success" });
    expect(chatStatusView("connecting")).toEqual({ label: en["chat.status.connecting"], tone: "info" });
    expect(chatStatusView("closed")).toEqual({ label: en["chat.status.closed"], tone: "warning" });
  });
});

describe("stream health badge", () => {
  it("maps each state to a catalog label and tone", () => {
    expect(healthBadge("offline")).toEqual({ label: en["dashboard.health.badge.offline"], tone: "neutral" });
    expect(healthBadge("healthy")).toEqual({ label: en["dashboard.health.badge.healthy"], tone: "success" });
    expect(healthBadge("warning")).toEqual({ label: en["dashboard.health.badge.warning"], tone: "warning" });
  });
});
