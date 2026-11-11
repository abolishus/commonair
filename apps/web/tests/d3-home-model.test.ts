// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Home v2, rail v2 and `/following` as data (wave 2, D3.1 and D3.5): who goes on which shelf, the
 * Live now backfill, categories never "0 live" first, Continue watching, the co-op proof number,
 * the signed-out rail's Recently live, and the following page's order.
 */
import type { FeeScheduleEntry, TransparencyMonth } from "@commonair/contracts/dto";
import { describe, expect, it } from "vite-plus/test";
import type { z } from "zod";
import { railGroups, RAIL_RECENT_LONG, RAIL_RECENT_SHORT } from "../src/components/discovery/rail.tsx";
import { followingView, withNotify, type FollowRow } from "../src/components/following/model.ts";
import {
  backfill,
  continueWatching,
  creatorShareOf,
  earnedOf,
  homeCategories,
  homeLive,
  HOME_CATEGORY_LIMIT,
  LIVE_NOW_LIMIT,
  LIVE_NOW_MIN,
  MEDIA_SHELF,
  RECENT_LIMIT,
  watchedShare,
} from "../src/components/home/model.ts";
import type { ResumePoint } from "../src/lib/resume.ts";
import { ART, GAMES, MUSIC, category, home, live, offline } from "./d1-fixtures.tsx";

const ids = (cards: { channel: { slug: string } }[]) => cards.map((c) => c.channel.slug);

describe("homeLive", () => {
  it("features the top spotlight channel and lists the rest once, spotlight, new, then live", () => {
    const h = home({
      spotlight: [live("a"), live("b")],
      newAndLive: [live("c"), live("a")],
      live: [live("d"), live("b"), live("c")],
    });
    const out = homeLive(h, false);
    expect(out.featured?.channel.slug).toBe("a");
    expect(ids(out.live)).toEqual(["b", "c", "d"]);
    expect(out.following).toEqual([]);
    expect(out.liveTotal).toBe(4);
  });

  it("signed in, a followed channel goes under Following and is never the feature", () => {
    const h = home({ spotlight: [live("a"), live("b")], live: [live("a"), live("c")], following: [live("a")] });
    const out = homeLive(h, true);
    expect(ids(out.following)).toEqual(["a"]);
    expect(out.featured?.channel.slug).toBe("b");
    expect(ids(out.live)).toEqual(["c"]);
    expect(out.liveTotal).toBe(3);
  });

  it("signed out, Following is ignored even when the feed has one", () => {
    const out = homeLive(home({ following: [live("a")], live: [live("b")] }), false);
    expect(out.following).toEqual([]);
    expect(out.featured).toBeNull();
    expect(ids(out.live)).toEqual(["b"]);
  });

  it("caps Live now at 200 live but counts them all", () => {
    const many = Array.from({ length: 200 }, (_, i) => live(`c${i}`));
    const out = homeLive(home({ spotlight: many.slice(0, 1), live: many }), false);
    expect(out.live).toHaveLength(LIVE_NOW_LIMIT);
    expect(out.liveTotal).toBe(200);
  });

  it("Recently live never lists a channel live on the page, and is capped", () => {
    const recent = [offline("a"), offline("x"), ...Array.from({ length: 20 }, (_, i) => offline(`r${i}`))];
    const out = homeLive(home({ live: [live("a")], recentlyLive: recent }), false);
    expect(ids(out.recent)).not.toContain("a");
    expect(out.recent[0]?.channel.slug).toBe("x");
    expect(out.recent).toHaveLength(RECENT_LIMIT);
  });

  it("nobody live: nothing featured, an empty Live now", () => {
    const out = homeLive(home(), false);
    expect(out).toMatchObject({ featured: null, live: [], liveTotal: 0, recent: [] });
  });
});

describe("backfill", () => {
  const videos = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"];
  it("fills Live now up to four and starts Catch up after the borrowed videos", () => {
    expect(backfill(1, videos)).toEqual({ fill: ["v1", "v2", "v3"], catchUp: ["v4", "v5", "v6", "v7"] });
    expect(backfill(0, videos).fill).toHaveLength(LIVE_NOW_MIN);
  });
  it("four or more live: no fill, Catch up from the newest", () => {
    expect(backfill(LIVE_NOW_MIN, videos)).toEqual({ fill: [], catchUp: videos.slice(0, MEDIA_SHELF) });
    expect(backfill(12, videos).fill).toEqual([]);
  });
  it("too few videos: fills what it can and leaves Catch up empty", () => {
    expect(backfill(2, ["v1"])).toEqual({ fill: ["v1"], catchUp: [] });
    expect(backfill(0, [])).toEqual({ fill: [], catchUp: [] });
  });
});

describe("homeCategories", () => {
  it("puts live categories first, busiest first, then the quiet ones, capped", () => {
    const cats = [
      category(ART, 0),
      category(MUSIC, 2, { viewerCount: 5 }),
      category(GAMES, 2, { viewerCount: 50 }),
      ...Array.from({ length: 20 }, (_, i) => category({ id: `k${i}`, slug: `k${i}`, name: `K${i}` }, 0)),
    ];
    const out = homeCategories(cats);
    expect(out.slice(0, 3).map((c) => c.slug)).toEqual(["games", "music", "art"]);
    expect(out).toHaveLength(HOME_CATEGORY_LIMIT);
  });
});

describe("Continue watching", () => {
  const point = (vodId: string, positionSeconds: number, durationSeconds = 600): ResumePoint => ({
    vodId,
    channelSlug: "aurora",
    title: vodId,
    thumbnailUrl: null,
    positionSeconds,
    durationSeconds,
    updatedAt: "2026-11-01T12:00:00.000Z",
  });
  it("keeps the newest points with something watched, one row", () => {
    const points = [point("a", 0), point("b", 60), point("c", 70), point("d", 80), point("e", 90), point("f", 95)];
    expect(continueWatching(points).map((p) => p.vodId)).toEqual(["b", "c", "d", "e"]);
    expect(continueWatching([])).toEqual([]);
  });
  it("watchedShare is clamped and 0 with no known length", () => {
    expect(watchedShare(point("a", 150, 600))).toBe(0.25);
    expect(watchedShare(point("a", 900, 600))).toBe(1);
    expect(watchedShare(point("a", -5, 600))).toBe(0);
    expect(watchedShare(point("a", 10, 0))).toBe(0);
    expect(watchedShare(point("a", 10, Number.NaN))).toBe(0);
  });
});

type Schedule = z.infer<typeof FeeScheduleEntry>;
type Month = z.infer<typeof TransparencyMonth>;

describe("the co-op proof number", () => {
  const cut = (streamerShare: unknown): Schedule => ({
    id: null,
    key: "platform.cut",
    value: { streamerShare, coopShare: 0.1 },
    previous: null,
    changedAt: null,
    proposalId: null,
  });
  it("reads the newest platform.cut", () => {
    const payout: Schedule = { ...cut(0.5), key: "payout.rules", value: { minimumCents: 1000 } };
    expect(creatorShareOf([payout, cut(0.9), cut(0.8)])).toBe(0.9);
  });
  it("is null for a missing or malformed share", () => {
    expect(creatorShareOf([])).toBeNull();
    for (const bad of ["0.9", 0, -0.1, 1.5, Number.NaN, null]) expect(creatorShareOf([cut(bad)])).toBeNull();
    expect(creatorShareOf([cut(1)])).toBe(1);
  });

  const month = (key: string, revenue: number, retained: number): Month =>
    ({
      month: key,
      revenue: { cents: revenue, currency: "USD" },
      coopRetained: { cents: retained, currency: "USD" },
    }) as Month;
  it("earned: revenue less the co-op's cut, in the newest month that had any", () => {
    expect(earnedOf([month("2026-10", 477_200, 47_720), month("2026-11", 0, 0)])).toEqual({
      month: "2026-10",
      currency: "USD",
      cents: 429_480,
    });
    expect(earnedOf([month("2026-09", 100, 10), month("2026-10", 200, 20)])?.month).toBe("2026-10");
  });
  it("earned is null when no month had revenue (or refunds outran it)", () => {
    expect(earnedOf([])).toBeNull();
    expect(earnedOf([month("2026-10", 0, 0), month("2026-11", 100, 300)])).toBeNull();
  });
});

describe("railGroups (rail v2)", () => {
  it("signed out: Live now, then Recently live without the live ones", () => {
    const h = home({
      live: [live("a", { viewers: 5 }), live("b", { viewers: 9 })],
      recentlyLive: [offline("a"), offline("z")],
    });
    const groups = railGroups(h, false);
    expect(groups.map((g) => g.id)).toEqual(["live", "recent"]);
    expect(groups[0]?.entries.map((e) => e.card.channel.slug)).toEqual(["b", "a"]);
    expect(groups[1]?.entries.map((e) => [e.kind, e.card.channel.slug])).toEqual([["offline", "z"]]);
  });
  it("fewer recent rows when Live now is long, more when it is short", () => {
    const recent = Array.from({ length: 10 }, (_, i) => offline(`r${i}`));
    const many = Array.from({ length: 6 }, (_, i) => live(`l${i}`));
    expect(railGroups(home({ live: many, recentlyLive: recent }), false)[1]?.entries).toHaveLength(RAIL_RECENT_SHORT);
    expect(railGroups(home({ live: many.slice(0, 2), recentlyLive: recent }), false)[1]?.entries).toHaveLength(
      RAIL_RECENT_LONG,
    );
    // Nobody live: Recently live alone, so the rail is never empty grey.
    expect(railGroups(home({ recentlyLive: recent }), false).map((g) => g.id)).toEqual(["recent"]);
  });
  it("signed in: followed channels only, no Recently live", () => {
    const h = home({ following: [live("f")], recentlyLive: [offline("z")] });
    expect(railGroups(h, true).map((g) => g.id)).toEqual(["followed"]);
  });
});

describe("followingView", () => {
  const row = (slug: string, over: Partial<FollowRow> = {}): FollowRow => ({
    channel: live(slug).channel,
    live: null,
    followedAt: "2026-11-01T12:00:00.000Z",
    notify: true,
    ...over,
  });
  it("lists live first, busiest first, with the feed's card where it has one", () => {
    const rows = [
      row("a", { live: live("a", { viewers: 2 }).broadcast }),
      row("b", { live: live("b", { viewers: 9 }).broadcast }),
      row("c"),
    ];
    const feed = home({ following: [live("a", { tags: ["art"] })] });
    const view = followingView(rows, feed);
    expect(view.live.map((l) => l.card.channel.slug)).toEqual(["b", "a"]);
    expect(view.live[1]?.card.tags).toEqual(["art"]);
    expect(view.live[0]?.card).toMatchObject({ tags: [], reason: "following" });
    expect(view.offline.map((o) => o.channel.slug)).toEqual(["c"]);
  });
  it("orders offline rows by when they were last live, unknown ones last in follow order", () => {
    const rows = [row("u1"), row("old"), row("u2"), row("new")];
    const feed = home({
      followingOffline: [
        offline("old", "2026-10-01T00:00:00.000Z", { category: { id: "c", slug: "art", name: "Art" } }),
        offline("new", "2026-11-02T00:00:00.000Z"),
      ],
    });
    const view = followingView(rows, feed);
    expect(view.offline.map((o) => o.channel.slug)).toEqual(["new", "old", "u1", "u2"]);
    expect(view.offline[1]?.category?.slug).toBe("art");
    expect(followingView(rows, null).offline.map((o) => o.lastLiveAt)).toEqual([null, null, null, null]);
  });
  it("drops a repeated channel (a page boundary shift) and flips one row's alert", () => {
    const rows = [row("a"), row("a"), row("b", { notify: false })];
    expect(followingView(rows, null).offline).toHaveLength(2);
    const flipped = withNotify(rows, "id-b", true);
    expect(flipped.map((r) => r.notify)).toEqual([true, true, true]);
    expect(withNotify(rows, "id-a", false)[2]?.notify).toBe(false);
  });
});
