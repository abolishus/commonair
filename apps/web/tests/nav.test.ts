// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { chatStatusView, nameColorIndex } from "../src/chat/view.ts";
import { en } from "../src/i18n/en.ts";
import { healthBadge } from "../src/lib/stream-health.ts";
import { isTreasurer } from "../src/lib/money.ts";
import { accountMenu, adminNav, footerNav, siteNav, studioNav } from "../src/lib/nav.ts";

describe("site nav", () => {
  it("links the directory and marks it current only on /", () => {
    expect(siteNav("/")).toEqual([{ id: "directory", to: "/", current: true }]);
    expect(siteNav("/rivertide")[0]?.current).toBe(false);
    expect(siteNav("/dashboard")[0]?.current).toBe(false);
  });

  it("ignores trailing slashes", () => {
    expect(siteNav("//")[0]?.current).toBe(true);
  });
});

describe("account menu", () => {
  it("signed in: dashboard, relays, subscriptions, appeals, then sign out after a separator", () => {
    const items = accountMenu(true);
    expect(items.map((i) => i.id)).toEqual(["dashboard", "relays", "subscriptions", "appeals", "signOut"]);
    expect(items.map((i) => i.to)).toEqual([
      "/dashboard",
      "/relays",
      "/settings/subscriptions",
      "/settings/appeals",
      undefined,
    ]);
    expect(items[4]).toMatchObject({ separatorBefore: true, destructive: true });
    expect(items.slice(0, 4).every((i) => !i.destructive && !i.separatorBefore)).toBe(true);
  });

  it("adds the treasury for treasurers only, before sign out", () => {
    expect(accountMenu(true, { treasurer: false }).some((i) => i.id === "treasury")).toBe(false);
    const items = accountMenu(true, { treasurer: true });
    expect(items.map((i) => i.id)).toEqual(["dashboard", "relays", "subscriptions", "appeals", "treasury", "signOut"]);
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
    const targets = [...accountMenu(true, { treasurer: true }), ...accountMenu(false, "/")].flatMap((i) =>
      i.to ? [i.to] : [],
    );
    expect(new Set(targets)).toEqual(
      new Set([
        "/dashboard",
        "/relays",
        "/settings/subscriptions",
        "/settings/appeals",
        "/treasury",
        "/signin",
        "/signup",
      ]),
    );
  });
});

describe("studio nav", () => {
  it("lists stream manager, revenue and relays, nothing else", () => {
    expect(studioNav("/dashboard").map((i) => [i.id, i.to])).toEqual([
      ["streamManager", "/dashboard"],
      ["revenue", "/revenue"],
      ["relays", "/relays"],
    ]);
  });

  it.each([
    ["/dashboard", "streamManager"],
    ["/revenue", "revenue"],
    ["/revenue/", "revenue"],
    ["/relays", "relays"],
    ["/relays/", "relays"],
  ])("on %s marks %s current (and only it)", (path, id) => {
    const current = studioNav(path).filter((i) => i.current);
    expect(current.map((i) => i.id)).toEqual([id]);
  });

  it("marks nothing current elsewhere", () => {
    expect(studioNav("/").some((i) => i.current)).toBe(false);
    expect(studioNav("/dashboards").some((i) => i.current)).toBe(false);
  });
});

describe("footer nav", () => {
  it("links public transparency and takedown pages", () => {
    expect(footerNav()).toEqual([
      { id: "transparency", to: "/transparency" },
      { id: "takedown", to: "/takedown" },
    ]);
  });
});

describe("trust and safety navigation", () => {
  it("shows only the queues a role can open", () => {
    const legal = { safetyStaff: true, legal: true, platformModerator: false };
    const moderator = { safetyStaff: true, legal: false, platformModerator: true };
    expect(adminNav("/admin/legal", legal).map((entry) => entry.id)).toEqual(["moderation", "legal"]);
    expect(adminNav("/admin/appeals", moderator).map((entry) => entry.id)).toEqual(["moderation", "appeals"]);
    expect(accountMenu(true, legal).map((entry) => entry.id)).toContain("legal");
    expect(accountMenu(true, legal).map((entry) => entry.id)).toContain("moderation");
    expect(accountMenu(true, moderator).map((entry) => entry.id)).toContain("moderation");
    expect(accountMenu(true, moderator).map((entry) => entry.id)).not.toContain("legal");
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
