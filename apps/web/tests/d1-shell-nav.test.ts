// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D1 shell, as data: which area a path belongs to, where the phone's bottom tab bar shows (browsing
 * pages only: never on watch, auth, studio, settings or admin pages), and its sections.
 */
import { describe, expect, it } from "vite-plus/test";
import { shellArea, tabBarNav, tabBarVisible, type ShellArea } from "../src/lib/nav.ts";

describe("shellArea", () => {
  it.each<[string, ShellArea]>([
    ["/", "browse"],
    ["/directory", "browse"],
    ["/directory/", "browse"],
    ["/directory/art", "browse"],
    ["/search", "browse"],
    ["/following", "browse"],
    ["/coop", "browse"],
    ["/coop/membership", "browse"],
    ["/coop/proposals/abc", "browse"],
    ["/transparency", "browse"],
    ["/creators", "browse"],
    ["/rivertide", "watch"],
    ["/rivertide/", "watch"],
    ["/rivertide/vods/v1", "watch"],
    ["/rivertide/clips/c1", "watch"],
    ["/rivertide/giveaways/g1", "watch"],
    ["/m/rivertide/nonce", "watch"],
    ["/signin", "auth"],
    ["/signup", "auth"],
    ["/activate", "auth"],
    ["/oauth2/authorize", "auth"],
    ["/settings", "settings"],
    ["/settings/privacy", "settings"],
    ["/settings/notifications/unsubscribe", "settings"],
    ["/dashboard", "studio"],
    ["/dashboard/settings", "studio"],
    ["/relays", "studio"],
    ["/developer/apps/x", "studio"],
    ["/mod/rivertide", "studio"],
    ["/import", "studio"],
    ["/admin/moderation", "admin"],
    ["/treasury", "admin"],
    ["/dmca", "page"],
    ["/takedown", "page"],
    ["/attestations/verify", "page"],
    ["/rivertide/unknown", "page"],
  ])("%s is %s", (path, area) => {
    expect(shellArea(path)).toBe(area);
  });

  it("does not take a channel whose name starts like a section for that section", () => {
    expect(shellArea("/cooper")).toBe("watch");
    expect(shellArea("/directorybob")).toBe("watch");
    expect(shellArea("/settingsfan")).toBe("watch");
  });
});

describe("tabBarVisible", () => {
  it.each(["/", "/directory", "/directory/art", "/search", "/following", "/coop", "/coop/council", "/transparency"])(
    "shows on the browsing page %s",
    (path) => {
      expect(tabBarVisible(path)).toBe(true);
    },
  );

  it.each([
    // watch
    "/rivertide",
    "/rivertide/vods/v1",
    "/rivertide/clips/c1",
    "/m/rivertide/n",
    // auth
    "/signin",
    "/signup",
    "/activate",
    // studio
    "/dashboard",
    "/overlays",
    "/mod/rivertide",
    // settings
    "/settings",
    "/settings/preferences",
    // admin
    "/admin/coop",
    "/treasury",
    // other pages (forms)
    "/dmca",
    "/takedown",
  ])("hides on %s", (path) => {
    expect(tabBarVisible(path)).toBe(false);
  });
});

describe("tabBarNav", () => {
  it("signed out: Home, Browse, Co-op, then Sign in in the You slot", () => {
    expect(tabBarNav("/", false)).toEqual([
      { id: "home", to: "/", current: true },
      { id: "browse", to: "/directory", current: false },
      { id: "coop", to: "/coop", current: false },
      { id: "you", to: "/signin", current: false },
    ]);
  });

  it("signed in: Home, Browse, Following, then You (the account sheet, no link)", () => {
    expect(tabBarNav("/following", true)).toEqual([
      { id: "home", to: "/", current: false },
      { id: "browse", to: "/directory", current: false },
      { id: "following", to: "/following", current: true },
      { id: "you", current: false },
    ]);
  });

  it.each<[string, string | undefined]>([
    ["/", "home"],
    ["/directory", "browse"],
    ["/directory/art", "browse"],
    ["/search", "browse"],
    ["/coop", "coop"],
    ["/coop/membership", "coop"],
    ["/coop/", "coop"],
    ["/transparency", undefined],
    ["/cooper", undefined],
  ])("on %s the current section is %s (signed out)", (path, current) => {
    expect(tabBarNav(path, false).find((entry) => entry.current)?.id).toBe(current);
  });

  it("marks at most one section current", () => {
    for (const path of ["/", "/directory", "/coop", "/following", "/search"])
      for (const signedIn of [true, false])
        expect(tabBarNav(path, signedIn).filter((entry) => entry.current).length).toBeLessThanOrEqual(1);
  });

  it("always has four sections", () => {
    expect(tabBarNav("/", true)).toHaveLength(4);
    expect(tabBarNav("/", false)).toHaveLength(4);
  });
});
