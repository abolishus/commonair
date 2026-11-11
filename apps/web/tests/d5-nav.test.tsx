// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D5-studio F22, regrouped by the overhaul's D5.8: the studio has Home, Set up, Community,
 * Channels you moderate (J5-a, only with a role elsewhere), Content, Money, Grow and Co-op & tools,
 * in that order, each with its pages in order (feature-gated pages only when the instance offers
 * them), and the mod view linking the member's own channel. Admin: Safety, Money, Co-op and
 * Platform, each only with the pages the role may open.
 */
import { describe, expect, it } from "vite-plus/test";
import { t } from "../src/i18n/index.ts";
import { adminNavGroups, studioNav, studioNavGroups } from "../src/lib/nav.ts";

const ids = (groups: { id: string; items: { id: string }[] }[]) =>
  groups.map((g) => [g.id, g.items.map((i) => i.id)] as const);

describe("studio groups", () => {
  it("orders the groups and their pages (every feature on, D5.8)", () => {
    const groups = studioNavGroups("/dashboard", { chatSafety: true, twitchImport: true, channel: "aurora" });
    expect(ids(groups)).toEqual([
      ["home", ["streamManager"]],
      ["setup", ["streamSettings", "overlays", "rehearse", "captions"]],
      ["community", ["modView", "chat", "bot", "interact"]],
      ["content", ["content"]],
      ["money", ["revenue", "crew"]],
      ["grow", ["audience", "analytics", "move", "import"]],
      ["coopTools", ["relays", "developer"]],
    ]);
  });

  it("keeps every studio page reachable", () => {
    const linked = new Set(
      studioNavGroups("/", { chatSafety: true, twitchImport: true, channel: "aurora" })
        .flatMap((g) => g.items)
        .map((i) => i.to),
    );
    for (const entry of studioNav("/", { chatSafety: true, twitchImport: true }))
      expect(linked.has(entry.to), entry.to).toBe(true);
    expect(linked.has("/dashboard/settings")).toBe(true);
    expect(linked.has("/mod/$channel")).toBe(true);
  });

  it("leaves out chat safety and import when the instance does not offer them", () => {
    const groups = studioNavGroups("/dashboard", { channel: "aurora" });
    expect(groups.find((g) => g.id === "community")?.items.map((i) => i.id)).toEqual(["modView", "bot", "interact"]);
    expect(groups.find((g) => g.id === "grow")?.items.map((i) => i.id)).toEqual(["audience", "analytics", "move"]);
  });

  it("links Bring your audience to /move whatever the setup or live state, never current", () => {
    // The dashboard checklist (and its audience step) is gone once live or once setup is done, so
    // the entry never points at it: /move always holds the move and follow links.
    for (const path of ["/dashboard", "/move", "/", "/dashboard/settings"]) {
      const items = studioNavGroups(path, { channel: "aurora" }).flatMap((g) => g.items);
      const audience = items.find((i) => i.id === "audience");
      expect(audience).toEqual({ id: "audience", to: "/move", current: false });
      expect(items.some((i) => i.to === "/dashboard" && "hash" in i)).toBe(false);
    }
    // On /move the Move channel entry is the current one, not both.
    const onMove = studioNavGroups("/move", { channel: "aurora" }).flatMap((g) => g.items);
    expect(onMove.filter((i) => i.current).map((i) => i.id)).toEqual(["move"]);
  });

  describe("channels you moderate (J5-a)", () => {
    const moderates = [
      { slug: "birch", displayName: "Birch" },
      { slug: "aurora", displayName: "Aurora" },
      { slug: "cedar", displayName: "Cedar" },
    ];

    it("adds a group after Community, one mod view link per channel in order, never the own channel", () => {
      const groups = studioNavGroups("/dashboard", { channel: "aurora", moderates });
      expect(groups.map((g) => g.id)).toEqual([
        "home",
        "setup",
        "community",
        "moderates",
        "content",
        "money",
        "grow",
        "coopTools",
      ]);
      expect(groups.find((g) => g.id === "moderates")?.items).toEqual([
        { id: "moderated", to: "/mod/$channel", params: { channel: "birch" }, label: "Birch", current: false },
        { id: "moderated", to: "/mod/$channel", params: { channel: "cedar" }, label: "Cedar", current: false },
      ]);
    });

    it("has no group when the list is empty or only the own channel", () => {
      for (const list of [[], [{ slug: "aurora", displayName: "Aurora" }]])
        expect(studioNavGroups("/", { channel: "aurora", moderates: list }).some((g) => g.id === "moderates")).toBe(
          false,
        );
    });

    it.each([
      ["/mod/birch", ["moderated:birch"]],
      ["/mod/cedar/", ["moderated:cedar"]],
      ["/mod/aurora", ["modView"]],
      ["/mod/elsewhere", ["modView"]],
      ["/mod/birch/x", []],
    ])("on %s marks %j current", (path, want) => {
      const current = studioNavGroups(path, { channel: "aurora", moderates })
        .flatMap((g) => g.items)
        .filter((i) => i.current)
        .map((i) => (i.id === "moderated" ? `moderated:${i.params?.channel}` : i.id));
      expect(current).toEqual(want);
    });
  });

  it("links the mod view to the member's own channel", () => {
    const mod = studioNavGroups("/", { channel: "aurora" })
      .flatMap((g) => g.items)
      .find((i) => i.id === "modView");
    expect(mod).toMatchObject({ to: "/mod/$channel", params: { channel: "aurora" }, current: false });
  });

  it.each([
    ["/dashboard", "streamManager"],
    ["/dashboard/settings", "streamSettings"],
    ["/dashboard/settings/", "streamSettings"],
    ["/mod/aurora", "modView"],
    ["/mod/someone-else", "modView"],
    ["/relays", "relays"],
    ["/developer/apps/x", "developer"],
  ])("marks %s current as %s, and nothing else", (path, id) => {
    const current = studioNavGroups(path, { chatSafety: true, twitchImport: true, channel: "aurora" })
      .flatMap((g) => g.items)
      .filter((i) => i.current)
      .map((i) => i.id);
    expect(current).toEqual([id]);
  });

  it("marks nothing current on pages outside the studio", () => {
    for (const path of ["/", "/mod", "/mod/a/b", "/dashboards", "/dashboard/settingsx"])
      expect(
        studioNavGroups(path, { channel: "a" })
          .flatMap((g) => g.items)
          .some((i) => i.current),
        path,
      ).toBe(false);
  });

  it("has a label for every group, in English and as a real string", () => {
    expect([
      t("d5Shell.group.home"),
      t("d5Shell.group.setup"),
      t("studio.group.community"),
      t("d5Shell.group.moderates"),
      t("studio.group.content"),
      t("studio.group.money"),
      t("d5Shell.group.grow"),
      t("d5Shell.group.coopTools"),
    ]).toEqual(["Home", "Set up", "Community", "Channels you moderate", "Content", "Money", "Grow", "Co-op & tools"]);
    expect(t("d5Shell.item.audience")).toBe("Bring your audience");
    expect(t("studio.chat")).toBe("Chat safety");
    expect(t("studio.item.modView")).toBe("Mod view");
    expect(t("studio.item.streamSettings")).toBe("Stream settings");
  });
});

describe("admin groups", () => {
  const everything = {
    treasurer: true,
    safetyStaff: true,
    platformModerator: true,
    legal: true,
    admin: true,
    federation: true,
  };

  it("orders Safety, Money, Co-op and Platform for a role that may open everything", () => {
    expect(ids(adminNavGroups("/admin/coop", everything))).toEqual([
      ["safety", ["moderation", "appeals", "dmca", "legal"]],
      ["money", ["treasury"]],
      ["coop", ["coop"]],
      ["platform", ["integrity", "egress", "incidents", "growth", "apps", "federation"]],
    ]);
  });

  it("leaves out groups the role has no page in", () => {
    expect(ids(adminNavGroups("/treasury", { treasurer: true }))).toEqual([["money", ["treasury"]]]);
    expect(ids(adminNavGroups("/admin/legal", { safetyStaff: true, legal: true }))).toEqual([
      ["safety", ["moderation", "legal"]],
    ]);
    expect(adminNavGroups("/", {})).toEqual([]);
  });

  it("keeps the current page", () => {
    const current = adminNavGroups("/admin/egress", everything)
      .flatMap((g) => g.items)
      .filter((i) => i.current)
      .map((i) => i.id);
    expect(current).toEqual(["egress"]);
  });

  it("labels each group", () => {
    expect(
      ["safety", "money", "coop", "platform"].map((g) => t(`studio.adminGroup.${g}` as "studio.adminGroup.safety")),
    ).toEqual(["Safety", "Money", "Co-op", "Platform"]);
  });
});
