// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D5-studio F22: the studio and admin sidebars are grouped. The studio: Stream, Community, Content,
 * Money and Tools, in that order, each with its pages in order (feature-gated pages only when the
 * instance offers them), and the mod view linking the member's own channel. Admin: Safety, Money,
 * Co-op and Platform, each only with the pages the role may open.
 */
import { describe, expect, it } from "vite-plus/test";
import { t } from "../src/i18n/index.ts";
import { adminNavGroups, studioNavGroups } from "../src/lib/nav.ts";

const ids = (groups: { id: string; items: { id: string }[] }[]) =>
  groups.map((g) => [g.id, g.items.map((i) => i.id)] as const);

describe("studio groups", () => {
  it("orders the groups and their pages (every feature on)", () => {
    const groups = studioNavGroups("/dashboard", { chatSafety: true, twitchImport: true, channel: "aurora" });
    expect(ids(groups)).toEqual([
      ["stream", ["streamManager", "streamSettings", "rehearse", "overlays", "captions", "relays"]],
      ["community", ["chat", "bot", "interact", "modView"]],
      ["content", ["content", "analytics"]],
      ["money", ["revenue", "crew"]],
      ["tools", ["move", "import", "developer"]],
    ]);
  });

  it("leaves out chat safety and import when the instance does not offer them", () => {
    const groups = studioNavGroups("/dashboard", { channel: "aurora" });
    expect(groups.find((g) => g.id === "community")?.items.map((i) => i.id)).toEqual(["bot", "interact", "modView"]);
    expect(groups.find((g) => g.id === "tools")?.items.map((i) => i.id)).toEqual(["move", "developer"]);
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
    expect(
      ["stream", "community", "content", "money", "tools"].map((g) => t(`studio.group.${g}` as "studio.group.stream")),
    ).toEqual(["Stream", "Community", "Content", "Money", "Tools"]);
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
