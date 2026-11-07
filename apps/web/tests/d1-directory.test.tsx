// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D1-web (F1, F10): `/directory`. Categories sorted by live channels then viewers, the tag filter,
 * the generated fallback tile (the same for the same slug, every time), and "Show more".
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
    const page = {
      items: [category(ART, 2, { viewerCount: 6 }), category(GAMES, 0), category(MUSIC, 2, { viewerCount: 51 })],
      nextCursor: null,
    };
    await renderInRouter(<CategoriesView initial={page} />, "/directory");
    expect(tiles()).toEqual(["music", "art", "games"]);
    // The totals on the tiles are the API's (`Category.viewerCount`).
    expect(screen.getByText("51 viewers")).toBeTruthy();
    expect(screen.getByText("6 viewers")).toBeTruthy();
  });

  it("shows the API's viewer total and tags", async () => {
    const page = { items: [category(ART, 1, { viewerCount: 1234, tags: ["cozy"] })], nextCursor: null };
    await renderInRouter(<CategoriesView initial={page} />, "/directory");
    expect(screen.getByText("1.2K viewers")).toBeTruthy();
    expect(screen.queryByText("9 viewers")).toBeNull();
    expect(screen.getByText("1 channel live")).toBeTruthy();
    expect(screen.getByText("cozy")).toBeTruthy();
    expect(screen.queryByText("other")).toBeNull();
  });

  it("links each tile to its category page", async () => {
    await renderInRouter(<CategoriesView initial={{ items: [category(ART, 1)], nextCursor: null }} />, "/directory");
    expect(document.querySelector('[data-category="art"] a')?.getAttribute("href")).toBe("/directory/art");
  });

  it('"Show more" loads the next page by cursor, then goes away', async () => {
    const calls: unknown[] = [];
    fake.categoriesList = async (input) => {
      calls.push(input);
      return { items: [category(GAMES, 0), category(ART, 3)], nextCursor: null };
    };
    await renderInRouter(
      <CategoriesView initial={{ items: [category(ART, 3), category(MUSIC, 1)], nextCursor: "c2" }} />,
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
    await renderInRouter(<CategoriesView initial={{ items: [category(ART, 1)], nextCursor: null }} />, "/directory");
    expect(screen.queryByTestId("directory-show-more")).toBeNull();
  });
});

/** The generated tile's tone and glyph kind for each slug, read off a rendered grid. */
async function fallbacks(slugs: string[]): Promise<Map<string, [string | null, string | null]>> {
  const view = await renderInRouter(
    <CategoriesView
      initial={{ items: slugs.map((slug) => category({ id: `cat-${slug}`, slug, name: slug }, 1)), nextCursor: null }}
    />,
    "/directory",
  );
  const out = new Map<string, [string | null, string | null]>();
  for (const slug of slugs) {
    const art = document.querySelector(`[data-category="${slug}"] [data-slot="category-art"]`);
    out.set(slug, [art?.getAttribute("data-tone") ?? null, art?.getAttribute("data-fallback") ?? null]);
  }
  view.unmount();
  return out;
}

describe("the fallback tile (F10)", () => {
  it("is the same for the same slug, every time", async () => {
    const first = await fallbacks(["art", "hollow-depths"]);
    const second = await fallbacks(["hollow-depths", "art"]);
    expect(second.get("art")).toEqual(first.get("art"));
    expect(second.get("hollow-depths")).toEqual(first.get("hollow-depths"));
  });

  it("spreads slugs over the tones", async () => {
    const slugs = [
      "art",
      "music",
      "games",
      "just-chatting",
      "speedrunning",
      "food-drink",
      "retro",
      "chess",
      "podcasts",
    ];
    const tones = new Set([...(await fallbacks(slugs)).values()].map(([tone]) => tone));
    expect(tones.size).toBeGreaterThan(2);
    for (const tone of tones) expect(Number(tone)).toBeGreaterThanOrEqual(0);
  });

  it("picks a glyph by the kind its slug names, by word, else a neutral one", async () => {
    const kinds = await fallbacks([
      "art",
      "music",
      "just-chatting",
      "software-game-dev",
      "tabletop-rpgs",
      // "starfall" contains "art" but is not art.
      "starfall",
    ]);
    expect([...kinds].map(([slug, [, kind]]) => [slug, kind])).toEqual([
      ["art", "art"],
      ["music", "music"],
      ["just-chatting", "talk"],
      ["software-game-dev", "tech"],
      ["tabletop-rpgs", "games"],
      ["starfall", "other"],
    ]);
  });

  it("renders the same tone and glyph on two renders, and art instead when there is box art", async () => {
    const view = () => (
      <CategoriesView
        initial={{
          items: [category(ART, 1), { ...category(MUSIC, 1), boxArtUrl: "/art/music.svg" }],
          nextCursor: null,
        }}
      />
    );
    const first = await renderInRouter(view(), "/directory");
    const art = () => document.querySelector('[data-category="art"] [data-slot="category-art"]');
    const before = [art()?.getAttribute("data-tone"), art()?.getAttribute("data-fallback")];
    expect(before[0]).toMatch(/^\d+$/);
    expect(before[1]).toBe("art");
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

  it("with a tag picked, still offers every live tag and lists only the tagged channels", async () => {
    const data = {
      categories: { items: [category(ART, 2)], nextCursor: null },
      live: {
        items: [live("a1", { category: ART, tags: ["cozy"] }), live("a2", { category: ART, tags: ["pixel"] })],
        nextCursor: null,
      },
      tagged: { items: [live("a1", { category: ART, tags: ["cozy"] })], nextCursor: null },
    };
    await renderInRouter(<DirectoryPage data={data} view="live" tag="cozy" />, "/directory?tag=cozy");
    expect([...document.querySelectorAll('[data-testid="stream-card"]')]).toHaveLength(1);
    const input = screen.getByRole("combobox");
    await act(async () => {
      input.focus();
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(await screen.findByRole("option", { name: "pixel" })).toBeTruthy();
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
    // Link slots inside the card, not a row under it.
    const card = screen.getByTestId("stream-card");
    expect(card.contains(screen.getByTestId("card-category-link"))).toBe(true);
    expect(card.contains(screen.getByTestId("card-tag-link"))).toBe(true);
    expect(card.querySelector("a a")).toBeNull();
  });

  it("says which view did not load, with Retry, when the directory could not be loaded", async () => {
    await renderInRouter(<DirectoryPage data={null} view="categories" />, "/directory");
    const error = screen.getByTestId("directory-load-error");
    expect(error.textContent).toContain("Categories didn't load.");
    expect(error.textContent).toContain("Check your connection, then retry.");
    expect(within(error).getByRole("button", { name: "Retry" })).toBeTruthy();
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

  it("has one Spotlight heading: the rest of Spotlight after the hero is 'More in Spotlight'", async () => {
    const layout = homeLayout(home({ spotlight: [live("hero"), live("second")] }), false);
    await renderInRouter(
      <Directory sections={layout.sections} hero={layout.hero} categoryShelves={[]} offline={[]} categories={[]} />,
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.filter((h) => h === "Spotlight")).toHaveLength(1);
    expect(headings).toContain("More in Spotlight");
  });

  it("titles every shelf; Following hides the reason chip; offline tiles show last live or never", async () => {
    await renderInRouter(
      <Directory
        sections={[
          { id: "spotlight", cards: [live("spot", { reason: "spotlight" })] },
          { id: "new", cards: [live("fresh", { reason: "new" })] },
          { id: "following", cards: [live("friend", { reason: "following" })] },
          { id: "live", cards: [live("other")] },
        ]}
        offline={[
          { id: "following-offline", cards: [offline("napper", null, { category: ART })] },
          { id: "recent", cards: [offline("earlier")] },
        ]}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Spotlight",
      "New and live",
      "Following",
      "Live now",
      "Offline channels you follow",
      "Recently live",
    ]);
    const section = (id: string) => document.querySelector(`[data-section="${id}"]`) as HTMLElement;
    expect(section("following").querySelector("[data-reason]")).toBeNull();
    expect(section("live").querySelector("[data-reason]")).toBeTruthy();
    // Only "Recently live" tiles carry the recent test id; a channel that never streamed says so.
    const followingOffline = section("following-offline");
    expect(followingOffline.querySelector('[data-testid="home-recent-tile"]')).toBeNull();
    expect(followingOffline.textContent).toContain("Has not streamed yet");
    expect(followingOffline.querySelector('[data-testid="card-category-link"]')?.getAttribute("href")).toBe(
      "/directory/art",
    );
    const recent = screen.getByTestId("home-recent-tile");
    expect(recent.textContent).toContain("Last live");
    expect(recent.querySelector('[data-testid="card-category-link"]')).toBeNull();
    expect(screen.queryByTestId("directory-empty")).toBeNull();
  });

  it("a failed load shows the error and no shelves, even with offline data", async () => {
    await renderInRouter(<Directory sections={null} offline={[{ id: "recent", cards: [offline("earlier")] }]} />);
    expect(screen.getByText("The directory didn't load. Refresh the page to retry.")).toBeTruthy();
    expect(screen.queryAllByTestId("directory-section")).toHaveLength(0);
  });

  it("offers a way forward when nothing is live", async () => {
    await renderInRouter(<Directory sections={[]} emptyAction={<a href="/signup">Sign up</a>} />);
    expect(screen.getByTestId("directory-empty").textContent).toContain("Sign up");
    expect(screen.queryByTestId("home-hero")).toBeNull();
  });
});
