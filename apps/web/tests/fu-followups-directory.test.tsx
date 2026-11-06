// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Follow-ups: the category tiles take their viewers and tags from the API (`Category.viewerCount`
 * and `Category.tags`), and the home directory's every shelf, title and offline tile state.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DiscoveryCategoryGrid,
  liveLabel,
  tileData,
  viewerLabel,
} from "../src/components/discovery/category-tiles.tsx";
import { Directory } from "../src/components/directory.tsx";
import { t } from "../src/i18n/index.ts";
import { ART, GAMES, MUSIC, category, live, offline, renderInRouter } from "./d1-fixtures.tsx";

afterEach(cleanup);

const byTestId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const headings = () => [...document.querySelectorAll("h2")].map((h) => h.textContent);

describe("tileData", () => {
  it("copies the API's viewer total and tags onto the tile", () => {
    const tile = tileData(category(ART, 3, { viewerCount: 42, tags: ["cozy", "pixel"] }));
    expect(tile).toEqual({
      id: ART.id,
      slug: "art",
      name: "Art",
      liveCount: 3,
      viewers: 42,
      imageUrl: null,
      tags: ["cozy", "pixel"],
    });
  });

  it("keeps a zero viewer total (it is exact) and leaves out an empty tag list", () => {
    const tile = tileData(category(GAMES, 0));
    expect(tile.viewers).toBe(0);
    expect("tags" in tile).toBe(false);
  });

  it("does not share the category's tag array", () => {
    const source = category(ART, 1, { tags: ["cozy"] });
    const tile = tileData(source);
    tile.tags?.push("changed");
    expect(source.tags).toEqual(["cozy"]);
  });

  it("passes the box art through", () => {
    expect(tileData({ ...category(MUSIC, 1), boxArtUrl: "/art.png" }).imageUrl).toBe("/art.png");
  });
});

describe("the labels", () => {
  it("count live channels and viewers with the plural rules", () => {
    expect(liveLabel("1", 1)).toBe("1 channel live");
    expect(liveLabel("2", 2)).toBe("2 channels live");
    expect(viewerLabel("1", 1)).toBe("1 viewer");
    expect(viewerLabel("1.2K", 1234)).toBe("1.2K viewers");
  });
});

describe("DiscoveryCategoryGrid", () => {
  it("renders each tile with the API's totals and tags, linked to its page", async () => {
    await renderInRouter(
      <DiscoveryCategoryGrid
        categories={[
          category(ART, 2, { viewerCount: 1234, tags: ["cozy", "pixel"] }),
          category(MUSIC, 1, { viewerCount: 7 }),
        ]}
      />,
      "/directory",
    );
    const tiles = byTestId("category-tile");
    expect(tiles.map((el) => el.dataset.category)).toEqual(["art", "music"]);
    const art = within(tiles[0] as HTMLElement);
    expect(art.getByText("1.2K viewers")).toBeTruthy();
    expect(art.getByText("2 channels live")).toBeTruthy();
    expect(art.getByText("cozy")).toBeTruthy();
    expect(art.getByText("pixel")).toBeTruthy();
    const music = within(tiles[1] as HTMLElement);
    expect(music.getByText("7 viewers")).toBeTruthy();
    expect(music.queryByText("cozy")).toBeNull();
    expect(document.querySelector('a[href="/directory/art"]')).not.toBeNull();
  });

  it("shows the empty state when there are no categories", async () => {
    await renderInRouter(
      <DiscoveryCategoryGrid categories={[]} empty={<p data-testid="no-categories">none</p>} />,
      "/directory",
    );
    expect(byTestId("category-tile")).toHaveLength(0);
    expect(byTestId("no-categories")).toHaveLength(1);
  });
});

describe("Directory", () => {
  it("says the directory failed to load when the shelves are null, and renders nothing else", async () => {
    await renderInRouter(<Directory sections={null} hero={live("h")} categories={[category(ART, 1)]} offline={[]} />);
    expect(screen.getByText(t("directory.loadFailed"))).toBeTruthy();
    expect(byTestId("home-hero")).toHaveLength(0);
    expect(byTestId("home-categories-shelf")).toHaveLength(0);
    expect(byTestId("directory-empty")).toHaveLength(0);
  });

  it("shows the empty state with its action when nothing is live, but still the offline shelves", async () => {
    await renderInRouter(
      <Directory
        sections={[]}
        offline={[{ id: "recent", cards: [offline("old")] }]}
        emptyAction={<button type="button">Go live</button>}
      />,
    );
    expect(byTestId("directory-empty")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Go live" })).toBeTruthy();
    expect(byTestId("home-recent-tile")).toHaveLength(1);
  });

  it("titles every live shelf, and Spotlight as 'More in Spotlight' under the hero", async () => {
    await renderInRouter(
      <Directory
        hero={live("hero")}
        sections={[
          { id: "spotlight", cards: [live("s1")] },
          { id: "new", cards: [live("n1")] },
          { id: "following", cards: [live("f1")] },
          { id: "live", cards: [live("l1")] },
        ]}
      />,
    );
    expect(byTestId("directory-empty")).toHaveLength(0);
    expect(byTestId("home-hero")).toHaveLength(1);
    expect(headings()).toEqual([
      t("directory.section.spotlight"),
      t("discovery.home.moreSpotlight"),
      t("directory.section.new"),
      t("directory.section.following"),
      t("directory.section.live"),
    ]);
    expect(byTestId("directory-section").map((s) => s.dataset.section)).toEqual([
      "spotlight",
      "new",
      "following",
      "live",
    ]);
  });

  it("titles Spotlight 'Spotlight' when there is no hero", async () => {
    await renderInRouter(<Directory sections={[{ id: "spotlight", cards: [live("s1")] }]} />);
    expect(headings()).toEqual([t("directory.section.spotlight")]);
  });

  it("shows at most 8 categories with live channels on the Categories shelf, from the API's totals", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      category({ id: `c${i}`, slug: `c${i}`, name: `C${i}` }, 1, { viewerCount: i }),
    );
    await renderInRouter(
      <Directory sections={[{ id: "live", cards: [live("l1")] }]} categories={[category(GAMES, 0), ...many]} />,
    );
    const shelf = byTestId("home-categories-shelf")[0] as HTMLElement;
    const tiles = [...shelf.querySelectorAll<HTMLElement>('[data-testid="category-tile"]')];
    expect(tiles.map((el) => el.dataset.category)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
    expect(within(shelf).getByText("7 viewers")).toBeTruthy();
    expect(shelf.querySelector('a[href="/directory"]')).not.toBeNull();
  });

  it("leaves out the Categories shelf when no category has a live channel", async () => {
    await renderInRouter(
      <Directory sections={[{ id: "live", cards: [live("l1")] }]} categories={[category(GAMES, 0)]} />,
    );
    expect(byTestId("home-categories-shelf")).toHaveLength(0);
  });

  it("gives each category shelf a heading and a 'Show all' link to the category", async () => {
    await renderInRouter(
      <Directory sections={[]} categoryShelves={[{ category: category(ART, 3), cards: [live("a1"), live("a2")] }]} />,
    );
    // A category shelf alone means something is live.
    expect(byTestId("directory-empty")).toHaveLength(0);
    const shelf = document.querySelector<HTMLElement>('[data-section="category"]') as HTMLElement;
    expect(shelf.dataset.category).toBe("art");
    expect(within(shelf).getByRole("heading", { name: "Art" })).toBeTruthy();
    const showAll = shelf.querySelector('a[href="/directory/art"]');
    expect(showAll?.getAttribute("aria-label")).toBe(t("discovery.home.showAllIn", { category: "Art" }));
  });

  it("titles the offline shelves, and only Recently live tiles carry home-recent-tile", async () => {
    await renderInRouter(
      <Directory
        sections={[{ id: "live", cards: [live("l1")] }]}
        offline={[
          { id: "following-offline", cards: [offline("fo", null)] },
          { id: "recent", cards: [offline("re")] },
        ]}
      />,
    );
    expect(headings()).toContain(t("directory.section.followingOffline"));
    expect(headings()).toContain(t("directory.section.recent"));
    expect(byTestId("home-recent-tile")).toHaveLength(1);
    // Never live: says so instead of a time.
    const fo = document.querySelector('[data-section="following-offline"]') as HTMLElement;
    expect(within(fo).getByText(t("directory.neverLive"))).toBeTruthy();
    const re = document.querySelector('[data-section="recent"]') as HTMLElement;
    expect(re.textContent).toContain(t("directory.lastLive"));
  });

  it("links an offline tile with a VOD to it, with the thumbnail or the avatar fallback", async () => {
    const vod = (id: string, thumbnailUrl: string | null) => ({ id, durationSeconds: 3725, thumbnailUrl });
    await renderInRouter(
      <Directory
        sections={[]}
        offline={[
          {
            id: "recent",
            cards: [
              offline("thumb", undefined, { latestVod: vod("v1", "/thumb.jpg") }),
              offline("bare", undefined, { latestVod: vod("v2", null) }),
              offline("none"),
            ],
          },
        ]}
      />,
    );
    const links = byTestId("channel-card-vod");
    expect(links.map((a) => a.dataset.vod)).toEqual(["v1", "v2"]);
    expect(links[0]?.querySelector("img")?.getAttribute("src")).toBe("/thumb.jpg");
    expect(links[1]?.querySelector("img[src]")).toBeNull();
    expect(links[0]?.getAttribute("aria-label")).toBe(
      t("fuChannel.recent.watchLatest", { name: "thumb", duration: "1:02:05" }),
    );
    // With a VOD tile the channel link carries no avatar frame of its own.
    const cards = byTestId("channel-card");
    expect(cards.map((c) => c.dataset.channel)).toEqual(["thumb", "bare", "none"]);
    expect(cards[0]?.querySelector("[data-accent]")).toBeNull();
    expect(cards[2]?.querySelector("[data-accent]")).not.toBeNull();
  });

  it("shows the @handle for display names two channels on the page share", async () => {
    await renderInRouter(
      <Directory
        sections={[{ id: "live", cards: [live("alice1", { name: "Alice" })] }]}
        offline={[{ id: "recent", cards: [offline("alice2", undefined, { name: "Alice" })] }]}
      />,
    );
    const tile = byTestId("channel-card").find((c) => c.dataset.channel === "alice2") as HTMLElement;
    expect(tile.textContent).toContain("@alice2");
  });

  it("shows an offline tile's category as a link", async () => {
    await renderInRouter(
      <Directory
        sections={[]}
        offline={[{ id: "recent", cards: [offline("c", undefined, { category: { ...ART } })] }]}
      />,
    );
    expect(document.querySelector('a[href="/directory/art"]')).not.toBeNull();
  });
});
