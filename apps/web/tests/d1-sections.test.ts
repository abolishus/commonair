// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D1-web (F7, F8, F1): the shelf rules of the front page, the side rail and the directory, as
 * pure functions. Dedupe across every shelf, the per-category shelf threshold, `@handle` when names
 * collide, ordering, and the empty cases.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  CATEGORY_SHELF_MIN,
  RAIL_LIVE_LIMIT,
  appendPage,
  categoryStats,
  collidingNames,
  directorySections,
  displayLabel,
  homeLayout,
  layoutChannels,
  needsHandle,
  offlineSections,
  railSections,
  sortCategories,
  tagOptions,
} from "../src/lib/directory-sections.ts";
import { ART, GAMES, MUSIC, category, home, live, offline } from "./d1-fixtures.tsx";

const slugs = (cards: readonly { channel: { slug: string } }[]) => cards.map((c) => c.channel.slug);

describe("homeLayout: one hero, each channel once", () => {
  it("is empty for an empty directory", () => {
    expect(homeLayout(home(), true)).toEqual({ hero: null, sections: [], categoryShelves: [], offline: [] });
    expect(homeLayout(home(), false)).toEqual({ hero: null, sections: [], categoryShelves: [], offline: [] });
  });

  it("makes the first spotlight slot the hero and keeps the rest of spotlight as a shelf", () => {
    const layout = homeLayout(home({ spotlight: [live("a"), live("b")] }), false);
    expect(layout.hero?.channel.slug).toBe("a");
    expect(layout.sections.map((s) => [s.id, slugs(s.cards)])).toEqual([["spotlight", ["b"]]]);
  });

  it("has no hero without a spotlight slot (it never promotes another shelf's card)", () => {
    const layout = homeLayout(home({ live: [live("a")] }), false);
    expect(layout.hero).toBeNull();
    expect(layout.sections.map((s) => s.id)).toEqual(["live"]);
  });

  it("dedupes across every shelf: the hero, spotlight, new, following and live", () => {
    const h = home({
      spotlight: [live("a"), live("b")],
      newAndLive: [live("b"), live("c"), live("a")],
      following: [live("c"), live("d")],
      live: [live("a"), live("b"), live("c"), live("d"), live("e")],
    });
    const layout = homeLayout(h, true);
    expect(layout.hero?.channel.slug).toBe("a");
    expect(layout.sections.map((s) => [s.id, slugs(s.cards)])).toEqual([
      ["spotlight", ["b"]],
      ["new", ["c"]],
      ["following", ["d"]],
      ["live", ["e"]],
    ]);
    const all = layoutChannels(layout).map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("orders spotlight, new, following, live and drops empty shelves", () => {
    const h = home({
      following: [live("f")],
      live: [live("l")],
      newAndLive: [live("n")],
      spotlight: [live("hero"), live("s")],
    });
    expect(homeLayout(h, true).sections.map((s) => s.id)).toEqual(["spotlight", "new", "following", "live"]);
    expect(homeLayout(home({ spotlight: [live("hero")], live: [live("l")] }), true).sections.map((s) => s.id)).toEqual([
      "live",
    ]);
  });

  it("hides following from visitors, and then lets those channels appear under live", () => {
    const h = home({ following: [live("f")], live: [live("f"), live("g")] });
    expect(homeLayout(h, false).sections.map((s) => [s.id, slugs(s.cards)])).toEqual([["live", ["f", "g"]]]);
    expect(homeLayout(h, true).sections.map((s) => [s.id, slugs(s.cards)])).toEqual([
      ["following", ["f"]],
      ["live", ["g"]],
    ]);
  });

  it("never lists a live channel as offline, and dedupes the offline shelves", () => {
    const h = home({
      live: [live("a")],
      followingOffline: [offline("a"), offline("b")],
      recentlyLive: [offline("a"), offline("b"), offline("c")],
    });
    expect(homeLayout(h, true).offline.map((s) => [s.id, slugs(s.cards)])).toEqual([
      ["following-offline", ["b"]],
      ["recent", ["c"]],
    ]);
    expect(offlineSections(h, false).map((s) => [s.id, slugs(s.cards)])).toEqual([["recent", ["b", "c"]]]);
  });
});

describe("homeLayout: per-category shelves", () => {
  const art = (slug: string) => live(slug, { category: ART });
  const music = (slug: string) => live(slug, { category: MUSIC });

  it(`needs more than ${CATEGORY_SHELF_MIN} live channels left for "Live now"`, () => {
    const exactly = home({ live: [art("a1"), art("a2"), music("m1")] });
    expect(homeLayout(exactly, false).categoryShelves).toEqual([]);
    const more = home({ live: [art("a1"), art("a2"), art("a3"), music("m1")] });
    const layout = homeLayout(more, false);
    expect(layout.categoryShelves.map((s) => [s.category.slug, slugs(s.cards)])).toEqual([["art", ["a1", "a2", "a3"]]]);
    // Carved out of "Live now", not repeated there.
    expect(layout.sections.map((s) => [s.id, slugs(s.cards)])).toEqual([["live", ["m1"]]]);
  });

  it("counts only channels not already on an earlier shelf", () => {
    const h = home({
      spotlight: [art("a1")],
      newAndLive: [art("a2")],
      live: [art("a1"), art("a2"), art("a3"), art("a4")],
    });
    expect(homeLayout(h, false).categoryShelves).toEqual([]);
  });

  it("caps a shelf, keeps the ranking's order, and puts the busiest category first", () => {
    const h = home({
      live: [music("m1"), art("a1"), music("m2"), art("a2"), music("m3"), art("a3"), art("a4"), art("a5")],
    });
    const layout = homeLayout(h, false, { shelfSize: 2 });
    expect(layout.categoryShelves.map((s) => [s.category.slug, slugs(s.cards)])).toEqual([
      ["art", ["a1", "a2"]],
      ["music", ["m1", "m2"]],
    ]);
    expect(layout.sections).toEqual([]);
  });

  it("breaks ties between equally busy categories by name", () => {
    const h = home({ live: [music("m1"), art("a1"), music("m2"), art("a2")] });
    expect(homeLayout(h, false, { shelfMin: 1 }).categoryShelves.map((s) => s.category.slug)).toEqual(["art", "music"]);
  });

  it("leaves channels without a category under Live now", () => {
    const h = home({ live: [live("x"), live("y"), live("z")] });
    const layout = homeLayout(h, false, { shelfMin: 0 });
    expect(layout.categoryShelves).toEqual([]);
    expect(slugs(layout.sections[0]?.cards ?? [])).toEqual(["x", "y", "z"]);
  });
});

describe("handle disambiguation", () => {
  it("finds names two channels share, ignoring case, accents and spaces", () => {
    const collisions = collidingNames([
      { id: "1", displayName: "Nimble Thistle" },
      { id: "2", displayName: "nimble thistle " },
      { id: "3", displayName: "Émile" },
      { id: "4", displayName: "Emile" },
      { id: "5", displayName: "Rivertide" },
    ]);
    expect(needsHandle(collisions, "NIMBLE THISTLE")).toBe(true);
    expect(needsHandle(collisions, "emile")).toBe(true);
    expect(needsHandle(collisions, "Rivertide")).toBe(false);
  });

  it("does not count the same channel twice as a collision", () => {
    expect(
      collidingNames([
        { id: "1", displayName: "A" },
        { id: "1", displayName: "A" },
      ]).size,
    ).toBe(0);
    expect(collidingNames([]).size).toBe(0);
  });

  it("labels colliding names with the handle, others with the name only", () => {
    const collisions = collidingNames([
      { id: "1", displayName: "Nimble" },
      { id: "2", displayName: "Nimble" },
    ]);
    expect(displayLabel(collisions, { slug: "nimble_1", displayName: "Nimble" })).toBe("Nimble (@nimble_1)");
    expect(displayLabel(collisions, { slug: "other", displayName: "Other" })).toBe("Other");
  });

  it("sees collisions across live and offline shelves of a layout", () => {
    const h = home({ live: [live("a", { name: "Twin" })], recentlyLive: [offline("b", null, { name: "Twin" })] });
    const collisions = collidingNames(layoutChannels(homeLayout(h, false)));
    expect(needsHandle(collisions, "Twin")).toBe(true);
  });
});

describe("directorySections (the shelves without the hero)", () => {
  it("dedupes and keeps the API's order", () => {
    const h = home({ spotlight: [live("a")], live: [live("b"), live("a")], following: [live("b")] });
    expect(directorySections(h, true).map((s) => [s.id, slugs(s.cards)])).toEqual([
      ["spotlight", ["a"]],
      ["following", ["b"]],
    ]);
    expect(directorySections(home(), false)).toEqual([]);
  });
});

describe("railSections", () => {
  it("is empty when nothing is live and the viewer follows nobody", () => {
    expect(railSections(home(), false)).toEqual([]);
    expect(railSections(home(), true)).toEqual([]);
  });

  it("signed out: Live now, by viewers, at most ten, each channel once", () => {
    const many = Array.from({ length: 14 }, (_, i) => live(`c${i}`, { viewers: i }));
    const sections = railSections(home({ live: many, spotlight: [many[3] ?? live("x")] }), false);
    expect(sections.map((s) => s.id)).toEqual(["live"]);
    const entries = sections[0]?.entries ?? [];
    expect(entries).toHaveLength(RAIL_LIVE_LIMIT);
    expect(entries.map((e) => e.card.channel.slug)).toEqual([
      "c13",
      "c12",
      "c11",
      "c10",
      "c9",
      "c8",
      "c7",
      "c6",
      "c5",
      "c4",
    ]);
  });

  it("signed in: Followed, live first by viewers, then offline by most recently live (never-live last)", () => {
    const h = home({
      following: [live("quiet", { viewers: 2 }), live("busy", { viewers: 40 })],
      followingOffline: [
        offline("old", "2026-10-01T00:00:00.000Z"),
        offline("never", null),
        offline("fresh", "2026-11-03T00:00:00.000Z"),
      ],
      live: [live("stranger", { viewers: 999 })],
    });
    const sections = railSections(h, true);
    expect(sections.map((s) => s.id)).toEqual(["followed"]);
    expect(sections[0]?.entries.map((e) => [e.kind, e.card.channel.slug])).toEqual([
      ["live", "busy"],
      ["live", "quiet"],
      ["offline", "fresh"],
      ["offline", "old"],
      ["offline", "never"],
    ]);
  });

  it("signed in but following nobody: Live now instead of an empty rail", () => {
    expect(railSections(home({ live: [live("a")] }), true).map((s) => s.id)).toEqual(["live"]);
  });
});

describe("the category directory", () => {
  const cats = [category(ART, 2), category(MUSIC, 2), category(GAMES, 5)];

  it("sorts by live channels, then viewers where known, then name", () => {
    const stats = categoryStats(
      cats,
      [
        live("a1", { category: ART, viewers: 10 }),
        live("a2", { category: ART, viewers: 10 }),
        live("m1", { category: MUSIC, viewers: 30 }),
        live("m2", { category: MUSIC, viewers: 1 }),
      ],
      true,
    );
    expect(sortCategories(cats, stats).map((c) => c.slug)).toEqual(["games", "music", "art"]);
    expect(sortCategories(cats).map((c) => c.slug)).toEqual(["games", "art", "music"]);
    expect(sortCategories([])).toEqual([]);
  });

  it("does not reorder its input", () => {
    const input = [category(ART, 0), category(GAMES, 9)];
    sortCategories(input);
    expect(input.map((c) => c.slug)).toEqual(["art", "games"]);
  });

  it("gives a viewer total only when it is exact", () => {
    const cards = [live("a1", { category: ART, viewers: 4 }), live("a2", { category: ART, viewers: 6 })];
    expect(categoryStats([category(ART, 2)], cards, true).get(ART.id)?.viewers).toBe(10);
    // The live list was cut off: the total could be short.
    expect(categoryStats([category(ART, 2)], cards, false).get(ART.id)?.viewers).toBeUndefined();
    // A channel the list did not include (another filter): no total.
    expect(categoryStats([category(ART, 3)], cards, true).get(ART.id)?.viewers).toBeUndefined();
    // No live channels at all is an exact 0.
    expect(categoryStats([category(MUSIC, 0)], cards, true).get(MUSIC.id)?.viewers).toBe(0);
  });

  it("ranks a category's tags by use, merging case", () => {
    const cards = [
      live("a1", { category: ART, tags: ["Cozy", "pixel"] }),
      live("a2", { category: ART, tags: ["cozy"] }),
      live("m1", { category: MUSIC, tags: ["lofi"] }),
    ];
    expect(categoryStats([category(ART, 2)], cards, true).get(ART.id)?.tags).toEqual(["Cozy", "pixel"]);
    expect(tagOptions(cards)).toEqual(["Cozy", "lofi", "pixel"]);
    expect(tagOptions([])).toEqual([]);
  });

  it("appends a page without repeating ids already loaded", () => {
    expect(appendPage([1, 2], [2, 3], String)).toEqual([1, 2, 3]);
    expect(appendPage([], [], String)).toEqual([]);
  });
});
