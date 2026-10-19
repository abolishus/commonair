// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelCard, StreamCard } from "@commonair/contracts/dto";
import { describe, expect, it } from "vite-plus/test";
import { directorySections, offlineSections, type DirectoryHome } from "../src/lib/directory-sections.ts";

const card = (slug: string, reason: StreamCard["reason"] = "popular"): StreamCard => ({
  channel: { id: `id-${slug}`, slug, displayName: slug, avatarUrl: null, accent: "zinc" },
  broadcast: {
    id: `b-${slug}`,
    title: `${slug} live`,
    category: null,
    startedAt: "2026-10-18T12:00:00.000Z",
    mature: false,
    viewerCount: 1,
    thumbnailUrl: null,
  },
  tags: [],
  language: "en",
  reason,
});

const offline = (slug: string, lastLiveAt: string | null = "2026-10-18T12:00:00.000Z"): ChannelCard => ({
  channel: { id: `id-${slug}`, slug, displayName: slug, avatarUrl: null, accent: "zinc" },
  title: `${slug} last show`,
  category: null,
  lastLiveAt,
  followerCount: 0,
  mature: false,
});

const home = (over: Partial<DirectoryHome> = {}): DirectoryHome => ({
  spotlight: [],
  newAndLive: [],
  live: [],
  following: [],
  recentlyLive: [],
  followingOffline: [],
  ...over,
});

const ids = (h: DirectoryHome, signedIn: boolean) => directorySections(h, signedIn).map((s) => s.id);

describe("directorySections", () => {
  it("orders spotlight, new, live, following", () => {
    const h = home({
      following: [card("f", "following")],
      live: [card("l")],
      newAndLive: [card("n", "new")],
      spotlight: [card("s", "spotlight")],
    });
    expect(ids(h, true)).toEqual(["spotlight", "new", "live", "following"]);
  });

  it("drops empty sections", () => {
    expect(ids(home({ live: [card("l")] }), true)).toEqual(["live"]);
    expect(ids(home({ spotlight: [card("s")], live: [card("l")] }), false)).toEqual(["spotlight", "live"]);
  });

  it("hides following for anonymous viewers even if the API sent cards", () => {
    expect(ids(home({ live: [card("l")], following: [card("f")] }), false)).toEqual(["live"]);
  });

  it("hides following when it is empty for a signed-in viewer", () => {
    expect(ids(home({ live: [card("l")] }), true)).toEqual(["live"]);
  });

  it("is empty when nothing is live (the page shows directory-empty)", () => {
    expect(directorySections(home(), true)).toEqual([]);
    expect(directorySections(home({ following: [card("f")] }), false)).toEqual([]);
  });

  it("keeps the API's card order and lets a channel appear in several sections", () => {
    const a = card("a");
    const b = card("b");
    const sections = directorySections(home({ spotlight: [a], live: [b, a] }), false);
    expect(sections.map((s) => s.cards.map((c) => c.channel.slug))).toEqual([["a"], ["b", "a"]]);
  });
});

describe("offlineSections", () => {
  const slugs = (h: DirectoryHome, signedIn: boolean) =>
    offlineSections(h, signedIn).map((s) => [s.id, s.cards.map((c) => c.channel.slug)]);

  it("shows recently live channels to everyone, even when nothing is live", () => {
    expect(slugs(home({ recentlyLive: [offline("a"), offline("b")] }), false)).toEqual([["recent", ["a", "b"]]]);
  });

  it("puts followed offline channels first and does not repeat them under recent", () => {
    const h = home({
      followingOffline: [offline("b"), offline("n", null)],
      recentlyLive: [offline("a"), offline("b")],
    });
    expect(slugs(h, true)).toEqual([
      ["following-offline", ["b", "n"]],
      ["recent", ["a"]],
    ]);
  });

  it("hides followed offline channels for anonymous viewers", () => {
    expect(slugs(home({ followingOffline: [offline("b")], recentlyLive: [offline("b")] }), false)).toEqual([
      ["recent", ["b"]],
    ]);
  });

  it("is empty when there is nothing offline to show", () => {
    expect(offlineSections(home(), true)).toEqual([]);
    expect(offlineSections(home({ recentlyLive: [offline("b")], followingOffline: [offline("b")] }), true)).toEqual([
      { id: "following-offline", cards: [offline("b")] },
    ]);
  });
});
