// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { chatStatusView, nameColorIndex } from "../src/chat/view.ts";
import { en } from "../src/i18n/en.ts";
import { healthBadge } from "../src/lib/stream-health.ts";
import { isTreasurer } from "../src/lib/money.ts";
import { accountMenu, adminNav, footerNav, siteNav, studioNav } from "../src/lib/nav.ts";
import { adminPageFor, mayOpenAdminPage } from "../src/components/safety/access.ts";

describe("site nav", () => {
  it("links the directory and marks it current only on /", () => {
    expect(siteNav("/")).toEqual([
      { id: "directory", to: "/", current: true },
      { id: "coop", to: "/coop", current: false },
    ]);
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
    expect(siteNav("//")[0]?.current).toBe(true);
  });
});

describe("account menu", () => {
  it("signed in: dashboard, relays, subscriptions, appeals, copyright, privacy, connected apps, co-op, then sign out after a separator", () => {
    const items = accountMenu(true);
    expect(items.map((i) => i.id)).toEqual([
      "dashboard",
      "relays",
      "subscriptions",
      "appeals",
      "copyright",
      "privacy",
      "connections",
      "coop",
      "signOut",
    ]);
    expect(items.map((i) => i.to)).toEqual([
      "/dashboard",
      "/relays",
      "/settings/subscriptions",
      "/settings/appeals",
      "/settings/copyright",
      "/settings/privacy",
      "/settings/connections",
      "/coop/membership",
      undefined,
    ]);
    expect(items[8]).toMatchObject({ separatorBefore: true, destructive: true });
    expect(items.slice(0, 8).every((i) => !i.destructive && !i.separatorBefore)).toBe(true);
  });

  it("adds co-op administration for admins only, before sign out", () => {
    expect(accountMenu(true, { admin: false }).some((i) => i.id === "adminCoop")).toBe(false);
    expect(accountMenu(true).some((i) => i.id === "adminCoop")).toBe(false);
    const items = accountMenu(true, { admin: true, safetyStaff: true });
    expect(items.map((i) => i.id)).toEqual([
      "dashboard",
      "relays",
      "subscriptions",
      "appeals",
      "copyright",
      "privacy",
      "connections",
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
    expect(items.map((i) => i.id)).toEqual([
      "dashboard",
      "relays",
      "subscriptions",
      "appeals",
      "copyright",
      "privacy",
      "connections",
      "coop",
      "treasury",
      "signOut",
    ]);
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

  it("only links pages that exist", () => {
    const targets = [...accountMenu(true, { treasurer: true, admin: true }), ...accountMenu(false, "/")].flatMap((i) =>
      i.to ? [i.to] : [],
    );
    expect(new Set(targets)).toEqual(
      new Set([
        "/dashboard",
        "/relays",
        "/settings/subscriptions",
        "/settings/appeals",
        "/settings/copyright",
        "/settings/privacy",
        "/settings/connections",
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
  it("lists stream manager, overlays, polls and raids, the bot, content, revenue, relays and developer, nothing else", () => {
    expect(studioNav("/dashboard").map((i) => [i.id, i.to])).toEqual([
      ["streamManager", "/dashboard"],
      ["overlays", "/overlays"],
      ["interact", "/interact"],
      ["bot", "/bot"],
      ["content", "/content"],
      ["revenue", "/revenue"],
      ["relays", "/relays"],
      ["developer", "/developer"],
    ]);
  });

  it.each([
    ["/dashboard", "streamManager"],
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
    ["/developer", "developer"],
    ["/developer/", "developer"],
    ["/developer/apps/0193e6a0-0000-7000-8000-000000000001", "developer"],
    ["/developer/bots", "developer"],
  ])("on %s marks %s current (and only it)", (path, id) => {
    const current = studioNav(path).filter((i) => i.current);
    expect(current.map((i) => i.id)).toEqual([id]);
  });

  it("adds chat safety after the bot only when the instance runs the watch gate or surge guard", () => {
    expect(studioNav("/dashboard", { chatSafety: false }).some((i) => i.id === "chat")).toBe(false);
    expect(studioNav("/dashboard", { chatSafety: true }).map((i) => [i.id, i.to])).toEqual([
      ["streamManager", "/dashboard"],
      ["overlays", "/overlays"],
      ["interact", "/interact"],
      ["bot", "/bot"],
      ["chat", "/chat"],
      ["content", "/content"],
      ["revenue", "/revenue"],
      ["relays", "/relays"],
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
  });
});

describe("footer nav", () => {
  it("links public transparency, takedown and DMCA pages", () => {
    expect(footerNav()).toEqual([
      { id: "transparency", to: "/transparency" },
      { id: "takedown", to: "/takedown" },
      { id: "dmca", to: "/dmca" },
    ]);
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
    expect(adminNav("/admin/coop", { admin: true }).map((entry) => entry)).toEqual([
      { id: "coop", to: "/admin/coop", current: true },
      { id: "integrity", to: "/admin/integrity", current: false },
      { id: "egress", to: "/admin/egress", current: false },
      { id: "incidents", to: "/admin/incidents", current: false },
      { id: "apps", to: "/admin/apps", current: false },
    ]);
    expect(adminNav("/admin/coop", moderator).map((entry) => entry.id)).not.toContain("coop");
  });

  it("orders the platform tools moderation, appeals, dmca, legal, coop, integrity, egress, incidents, apps", () => {
    const everything = { treasurer: false, safetyStaff: true, platformModerator: true, legal: true, admin: true };
    expect(adminNav("/admin/dmca", everything).map((entry) => [entry.id, entry.current])).toEqual([
      ["moderation", false],
      ["appeals", false],
      ["dmca", true],
      ["legal", false],
      ["coop", false],
      ["integrity", false],
      ["egress", false],
      ["incidents", false],
      ["apps", false],
    ]);
    const moderator = { safetyStaff: true, platformModerator: true };
    for (const id of ["integrity", "egress", "incidents", "coop", "apps"])
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
