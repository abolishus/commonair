// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D1-web (F1, F10): `/directory`. Categories sorted by live channels then viewers, the tag filter,
 * the generated fallback tile (the same for the same slug, every time), and "Show more".
 */
import { categoryFallback, categoryKind } from "@commonair/ui/blocks/media";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ART, GAMES, MUSIC, boot, category, home, live, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({
  boot: null as unknown,
  categoriesList: null as unknown as (input: unknown) => Promise<unknown>,
  directoryLive: null as unknown as (input: unknown) => Promise<unknown>,
}));

vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    categories: { list: (input: unknown) => fake.categoriesList(input) },
    directory: { live: (input: unknown) => fake.directoryLive(input) },
  }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const { CategoriesView, DirectoryPage, LiveView } = await import("../src/components/discovery/directory-page.tsx");
const { directorySearch, directoryView } = await import("../src/components/discovery/search-params.ts");
const { tagHref } = await import("../src/lib/category-route.ts");
const { Directory } = await import("../src/components/directory.tsx");
const { homeLayout } = await import("../src/lib/directory-sections.ts");

beforeEach(() => {
  fake.boot = boot();
  fake.categoriesList = async () => ({ items: [], nextCursor: null });
  fake.directoryLive = async () => ({ items: [], nextCursor: null });
});
afterEach(cleanup);

const tiles = () =>
  [...document.querySelectorAll('[data-testid="category-tile"]')].map((el) => el.getAttribute("data-category"));

describe("the category grid", () => {
  it("sorts by live channels, then by exact viewers, then by name", async () => {
    const page = { items: [category(ART, 2), category(GAMES, 0), category(MUSIC, 2)], nextCursor: null };
    const liveList = {
      items: [
        live("a1", { category: ART, viewers: 3 }),
        live("a2", { category: ART, viewers: 3 }),
        live("m1", { category: MUSIC, viewers: 50 }),
        live("m2", { category: MUSIC, viewers: 1 }),
      ],
      nextCursor: null,
    };
    await renderInRouter(<CategoriesView initial={page} live={liveList} />, "/directory");
    expect(tiles()).toEqual(["music", "art", "games"]);
    // The exact total is on the tile; the tile with no live list match has none.
    expect(screen.getByText("51 viewers")).toBeTruthy();
    expect(screen.getByText("6 viewers")).toBeTruthy();
  });

  it("shows no viewer total when the live list was cut off", async () => {
    const page = { items: [category(ART, 1)], nextCursor: null };
    const liveList = { items: [live("a1", { category: ART, viewers: 9 })], nextCursor: "more" };
    await renderInRouter(<CategoriesView initial={page} live={liveList} />, "/directory");
    expect(screen.queryByText(/viewers?$/)).toBeNull();
    expect(screen.getByText("1 channel live")).toBeTruthy();
  });

  it("links each tile to its category page", async () => {
    await renderInRouter(
      <CategoriesView
        initial={{ items: [category(ART, 1)], nextCursor: null }}
        live={{ items: [], nextCursor: null }}
      />,
      "/directory",
    );
    expect(document.querySelector('[data-category="art"] a')?.getAttribute("href")).toBe("/directory/art");
  });

  it('"Show more" loads the next page by cursor, then goes away', async () => {
    const calls: unknown[] = [];
    fake.categoriesList = async (input) => {
      calls.push(input);
      return { items: [category(GAMES, 0), category(ART, 3)], nextCursor: null };
    };
    await renderInRouter(
      <CategoriesView
        initial={{ items: [category(ART, 3), category(MUSIC, 1)], nextCursor: "c2" }}
        live={{ items: [], nextCursor: null }}
      />,
      "/directory",
    );
    expect(tiles()).toEqual(["art", "music"]);
    await act(async () => {
      fireEvent.click(screen.getByTestId("directory-show-more"));
    });
    await waitFor(() => expect(tiles()).toEqual(["art", "music", "games"]));
    expect(calls).toEqual([{ cursor: "c2", limit: 48 }]);
    expect(screen.queryByTestId("directory-show-more")).toBeNull();
  });

  it("has no Show more on the last page", async () => {
    await renderInRouter(
      <CategoriesView
        initial={{ items: [category(ART, 1)], nextCursor: null }}
        live={{ items: [], nextCursor: null }}
      />,
      "/directory",
    );
    expect(screen.queryByTestId("directory-show-more")).toBeNull();
  });
});

describe("the fallback tile (F10)", () => {
  it("is the same for the same slug, every time", () => {
    expect(categoryFallback("art")).toEqual(categoryFallback("art"));
    expect(categoryFallback("hollow-depths")).toEqual(categoryFallback("hollow-depths"));
  });

  it("spreads slugs over the tones", () => {
    const tones = new Set(
      ["art", "music", "games", "just-chatting", "speedrunning", "food-drink", "retro", "chess", "podcasts"].map(
        (s) => categoryFallback(s).tone,
      ),
    );
    expect(tones.size).toBeGreaterThan(2);
    for (const tone of tones) expect(tone).toBeGreaterThanOrEqual(0);
  });

  it("picks a glyph by the kind its slug names, by word, else a neutral one", () => {
    expect(categoryKind("art")).toBe("art");
    expect(categoryKind("music")).toBe("music");
    expect(categoryKind("just-chatting")).toBe("talk");
    expect(categoryKind("software-game-dev")).toBe("tech");
    expect(categoryKind("tabletop-rpgs")).toBe("games");
    // "starfall" contains "art" but is not art.
    expect(categoryKind("starfall")).toBe("other");
    expect(categoryKind("")).toBe("other");
  });

  it("renders the same tone and glyph on two renders, and art instead when there is box art", async () => {
    const view = () => (
      <CategoriesView
        initial={{
          items: [category(ART, 1), { ...category(MUSIC, 1), boxArtUrl: "/art/music.svg" }],
          nextCursor: null,
        }}
        live={{ items: [], nextCursor: null }}
      />
    );
    const first = await renderInRouter(view(), "/directory");
    const art = () => document.querySelector('[data-category="art"] [data-slot="category-art"]');
    const before = [art()?.getAttribute("data-tone"), art()?.getAttribute("data-fallback")];
    expect(before).toEqual([String(categoryFallback("art").tone), "art"]);
    expect(document.querySelector('[data-category="music"] img')?.getAttribute("src")).toBe("/art/music.svg");
    first.unmount();
    await renderInRouter(view(), "/directory");
    expect([art()?.getAttribute("data-tone"), art()?.getAttribute("data-fallback")]).toEqual(before);
  });
});

describe("the tag filter and the Live channels view", () => {
  it("a tag link (the tagHref seam) opens the live view filtered to it", () => {
    const url = new URL(tagHref("cozy games"), "https://x.invalid");
    expect(url.pathname).toBe("/directory");
    const search = directorySearch(Object.fromEntries(url.searchParams));
    expect(search).toEqual({ tag: "cozy games" });
    expect(directoryView(search)).toBe("live");
    expect(directoryView({})).toBe("categories");
    expect(directoryView({ view: "categories", tag: "x" })).toBe("categories");
    expect(directorySearch({ view: "bogus", tag: "  " })).toEqual({});
  });

  it("offers the live channels' tags, and picking one filters the live list", async () => {
    const data = {
      categories: { items: [category(ART, 2)], nextCursor: null },
      live: {
        items: [live("a1", { category: ART, tags: ["cozy"] }), live("a2", { category: ART, tags: ["pixel", "cozy"] })],
        nextCursor: null,
      },
    };
    const { router } = await renderInRouter(<DirectoryPage data={data} view="categories" />, "/directory");
    const input = screen.getByRole("combobox");
    await act(async () => {
      input.focus();
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    const option = await screen.findByRole("option", { name: "pixel" });
    await act(async () => {
      fireEvent.click(option);
    });
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "live", tag: "pixel" }));
  });

  it("the live view lists the tag's channels and says so when none are live", async () => {
    await renderInRouter(<LiveView initial={{ items: [], nextCursor: null }} tag="cozy" />, "/directory?tag=cozy");
    expect(screen.getByText("Nobody tagged cozy is live right now")).toBeTruthy();
  });

  it('"Show more" on live reveals the loaded cards first, then asks for the next page with the tag', async () => {
    const items = Array.from({ length: 30 }, (_, i) => live(`c${i}`, { tags: ["cozy"] }));
    const calls: unknown[] = [];
    fake.directoryLive = async (input) => {
      calls.push(input);
      return { items: [live("late", { tags: ["cozy"] })], nextCursor: null };
    };
    await renderInRouter(<LiveView initial={{ items, nextCursor: "n1" }} tag="cozy" />, "/directory");
    const cards = () => document.querySelectorAll('[data-testid="stream-card"]').length;
    expect(cards()).toBe(24);
    await act(async () => {
      fireEvent.click(screen.getByTestId("directory-show-more"));
    });
    expect(cards()).toBe(30);
    expect(calls).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByTestId("directory-show-more"));
    });
    await waitFor(() => expect(cards()).toBe(31));
    expect(calls).toEqual([{ cursor: "n1", limit: 24, sort: "viewers_desc", tag: "cozy" }]);
    expect(screen.queryByTestId("directory-show-more")).toBeNull();
  });

  it("links a card's category and tags to their pages", async () => {
    await renderInRouter(
      <LiveView initial={{ items: [live("a1", { category: ART, tags: ["cozy"] })], nextCursor: null }} />,
      "/directory",
    );
    expect(screen.getByTestId("card-category-link").getAttribute("href")).toBe("/directory/art");
    expect(screen.getByTestId("card-tag-link").getAttribute("href")).toBe("/directory?tag=cozy");
  });

  it("says when the directory could not be loaded", async () => {
    await renderInRouter(<DirectoryPage data={null} view="categories" />, "/directory");
    expect(screen.getByText("The directory could not be loaded. Reload to try again.")).toBeTruthy();
  });
});

describe("the home page directory (F8)", () => {
  it("renders one hero, deduped shelves, the categories shelf, category shelves and recent tiles", async () => {
    const art = (slug: string) => live(slug, { category: ART });
    const layout = homeLayout(
      home({
        spotlight: [live("hero", { category: MUSIC, tags: ["cozy"] })],
        live: [live("hero"), art("a1"), art("a2"), art("a3"), live("solo")],
        recentlyLive: [offline("napper", "2026-11-03T00:00:00.000Z", { name: "solo" })],
      }),
      false,
    );
    await renderInRouter(
      <Directory
        sections={layout.sections}
        hero={layout.hero}
        categoryShelves={layout.categoryShelves}
        offline={layout.offline}
        categories={[category(ART, 3), category(GAMES, 0)]}
      />,
    );
    const hero = screen.getByTestId("home-hero");
    expect(hero.querySelectorAll('[data-testid="stream-card"]')).toHaveLength(1);
    expect(hero.querySelector('[data-testid="card-category-link"]')?.getAttribute("href")).toBe("/directory/music");
    expect(hero.querySelector('[data-testid="card-tag-link"]')?.getAttribute("href")).toBe("/directory?tag=cozy");
    // Every channel once on the page.
    const channels = [...document.querySelectorAll('[data-testid="stream-card"]')].map((c) =>
      c.getAttribute("data-channel"),
    );
    expect(channels.sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(["a1", "a2", "a3", "hero", "solo"]);
    // Only categories with someone live are on the shelf.
    const shelf = screen.getByTestId("home-categories-shelf");
    expect(
      [...shelf.querySelectorAll('[data-testid="category-tile"]')].map((tile) => tile.getAttribute("data-category")),
    ).toEqual(["art"]);
    const artShelf = document.querySelector('[data-section="category"][data-category="art"]') as HTMLElement;
    expect(artShelf.querySelector('a[href="/directory/art"]')?.textContent).toContain("Show all");
    // "solo" is live and "napper" is offline under the same name: both show their handle.
    const recent = screen.getByTestId("home-recent-tile");
    expect(recent.textContent).toContain("solo (@napper)");
    expect(recent.querySelector('[data-testid="channel-card"]')?.getAttribute("href")).toBe("/napper");
  });

  it("offers a way forward when nothing is live", async () => {
    await renderInRouter(<Directory sections={[]} emptyAction={<a href="/signup">Sign up</a>} />);
    expect(screen.getByTestId("directory-empty").textContent).toContain("Sign up");
    expect(screen.queryByTestId("home-hero")).toBeNull();
  });
});
