// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul D3 browse: the category Overview (live, recently live, videos, clips, then live
 * elsewhere; no dead ends, no "0 live"), Directory v2 (live first, idle categories muted with their
 * videos) and search v2 (live channels, channels, videos, clips, categories; an empty query gets a
 * page of its own, counted once).
 */
import type { ClipCard, VodCard } from "@commonair/contracts/dto";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ART, GAMES, MUSIC, boot, category, live, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown, tracked: [] as unknown[][] }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (...args: unknown[]) => {
    fake.tracked.push(args);
  },
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({}),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const { CategoryPage, OverviewPanel, videoCountLabel } = await import("../src/components/discovery/category-page.tsx");
const { CategoriesView, DirectoryPage, LiveNowStrip, LIVE_STRIP } =
  await import("../src/components/discovery/directory-page.tsx");
const { SearchPage, SearchResults, SearchStart, resultCount, SEARCH_MEDIA } =
  await import("../src/components/discovery/search-page.tsx");
const { splitByLive } = await import("../src/lib/directory-sections.ts");
const { settledOrNull } = await import("../src/lib/directory.ts");
const { RECENT_SEARCHES_KEY } = await import("../src/components/discovery/tab-storage.ts");
type Overview = import("../src/lib/directory.ts").CategoryOverview;

beforeEach(() => {
  fake.boot = boot();
  fake.tracked = [];
  sessionStorage.clear();
});
afterEach(cleanup);

const uuid = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const channelOf = (slug: string) => ({
  id: `id-${slug}`,
  slug,
  displayName: slug,
  avatarUrl: null,
  accent: "zinc" as const,
});
const vod = (n: number, over: Partial<VodCard> = {}): VodCard => ({
  id: uuid(100 + n),
  channelSlug: `ch${n}`,
  title: `Stream ${n}`,
  status: "ready",
  visibility: "public",
  durationSeconds: 3600,
  thumbnailUrl: null,
  playlistUrl: null,
  createdAt: new Date(Date.UTC(2026, 9, 30 - n)).toISOString(),
  expiresAt: null,
  failedReason: null,
  captions: [],
  category: { slug: "art", name: "Art" },
  channel: channelOf(`ch${n}`),
  ...over,
});
const clip = (n: number, over: Partial<ClipCard> = {}): ClipCard => ({
  id: uuid(200 + n),
  channelSlug: `ch${n}`,
  title: `Clip ${n}`,
  creator: null,
  status: "ready",
  durationSeconds: 30,
  url: null,
  thumbnailUrl: null,
  views: n,
  createdAt: new Date(Date.UTC(2026, 9, 30 - n)).toISOString(),
  windowStartedAt: null,
  vodId: null,
  vodOffsetSeconds: null,
  category: { slug: "art", name: "Art" },
  channel: channelOf(`ch${n}`),
  ...over,
});

const EMPTY = { items: [], nextCursor: null };
const NOTHING: Overview = { recentlyLive: [], videos: [], clips: [], elsewhere: [] };
const art = (slug: string) => live(slug, { category: ART });
const music = (slug: string) => live(slug, { category: MUSIC });
const ids = (testId: string, root: ParentNode = document) =>
  [...root.querySelectorAll(`[data-testid="${testId}"]`)].map(
    (el) => el.getAttribute("data-channel") ?? el.getAttribute("data-category") ?? el.getAttribute("data-id"),
  );

describe("the category Overview", () => {
  const cat = category(ART, 2);

  it("leads with who is live, then recently live, videos and clips, then live elsewhere", async () => {
    await renderInRouter(
      <OverviewPanel
        category={cat}
        live={{ items: [art("a1"), art("a2")], nextCursor: null }}
        overview={{
          recentlyLive: [offline("napper", "2026-11-03T00:00:00.000Z"), offline("fresh", null)],
          videos: [vod(1), vod(2, { status: "processing" })],
          clips: [clip(1)],
          // Art's own streams are already above; only other categories are "elsewhere".
          elsewhere: [art("a1"), music("m1"), live("nocat")],
        }}
      />,
      "/directory/art",
    );
    const overview = screen.getByTestId("category-overview");
    const order = [...overview.querySelectorAll(":scope > section")].map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "category-overview-live",
      "category-overview-recent",
      "category-overview-videos",
      "category-overview-clips",
      "category-overview-elsewhere",
    ]);
    expect(within(screen.getByTestId("category-overview-live")).getByText("Live now in Art")).toBeTruthy();
    expect(screen.getByTestId("category-overview-live").querySelectorAll('[data-testid="stream-card"]')).toHaveLength(
      2,
    );
    // Everyone live fits: no "All live channels" link.
    expect(screen.queryByTestId("category-view-all-live")).toBeNull();
    expect(ids("category-recent-chip")).toEqual(["napper", "fresh"]);
    expect(screen.getByText("Hasn't streamed yet")).toBeTruthy();
    // Only playable videos; each shelf links to its tab.
    expect(ids("channel-video-card", screen.getByTestId("category-overview-videos"))).toEqual([uuid(101)]);
    expect(screen.getByTestId("category-view-all-videos").getAttribute("href")).toBe("/directory/art?tab=videos");
    expect(screen.getByTestId("category-view-all-clips").getAttribute("href")).toBe("/directory/art?tab=clips");
    const elsewhere = screen.getByTestId("category-overview-elsewhere");
    expect(
      [...elsewhere.querySelectorAll('[data-testid="stream-card"] a[href^="/"]')].some(
        (a) => a.getAttribute("href") === "/a1",
      ),
    ).toBe(false);
    expect(elsewhere.querySelectorAll('[data-testid="stream-card"]')).toHaveLength(2);
  });

  it("nobody live is one line pointing at who streamed it recently, not an empty state", async () => {
    await renderInRouter(
      <OverviewPanel
        category={category(ART, 0)}
        live={EMPTY}
        overview={{ ...NOTHING, recentlyLive: [offline("napper")] }}
      />,
    );
    expect(screen.getByTestId("category-none-live").textContent).toBe(
      "Nobody's streaming Art right now. Here's who streamed it recently.",
    );
    expect(screen.queryByTestId("category-overview-empty")).toBeNull();
    expect(ids("category-recent-chip")).toEqual(["napper"]);
  });

  it("nobody live and nobody recent: the plain line", async () => {
    await renderInRouter(
      <OverviewPanel category={category(ART, 0)} live={EMPTY} overview={{ ...NOTHING, videos: [vod(1)] }} />,
    );
    expect(screen.getByTestId("category-none-live").textContent).toBe("Nobody's streaming Art right now");
    expect(screen.getByTestId("category-overview-videos")).toBeTruthy();
  });

  it("more live than the shelf holds links to the Live tab", async () => {
    const many = Array.from({ length: 8 }, (_, i) => art(`a${i}`));
    await renderInRouter(<OverviewPanel category={cat} live={{ items: many, nextCursor: null }} overview={NOTHING} />);
    expect(screen.getByTestId("category-overview-live").querySelectorAll('[data-testid="stream-card"]')).toHaveLength(
      6,
    );
    expect(screen.getByTestId("category-view-all-live").getAttribute("href")).toBe("/directory/art?tab=live");
  });

  it("a shelf that did not load says so with Retry; the rest stays", async () => {
    await renderInRouter(
      <OverviewPanel
        category={cat}
        live={{ items: [art("a1")], nextCursor: null }}
        overview={{ recentlyLive: null, videos: null, clips: [clip(2)], elsewhere: null }}
      />,
    );
    expect(screen.getByTestId("category-recent-error").textContent).toContain("Recently live in Art didn't load.");
    expect(screen.getByTestId("category-videos-error").textContent).toContain("Latest videos didn't load.");
    expect(screen.getByTestId("category-overview-clips")).toBeTruthy();
    expect(screen.queryByTestId("category-overview-elsewhere")).toBeNull();
  });

  it("a category with nothing at all: the full empty state, and still who is live elsewhere", async () => {
    await renderInRouter(
      <OverviewPanel category={category(ART, 0)} live={EMPTY} overview={{ ...NOTHING, elsewhere: [music("m1")] }} />,
    );
    const empty = screen.getByTestId("category-overview-empty");
    expect(empty.textContent).toContain("Nothing in Art yet");
    expect(empty.querySelector("a")?.getAttribute("href")).toBe("/directory");
    expect(screen.queryByTestId("category-overview-live")).toBeNull();
    expect(screen.getByTestId("category-overview-elsewhere").textContent).toContain("Live now elsewhere");
  });

  it("the page opens on the Overview; an idle category has muted art, no live count and its videos", async () => {
    await renderInRouter(
      <CategoryPage
        category={{ ...category(ART, 0), videoCount: 1234 }}
        live={EMPTY}
        overview={NOTHING}
        tab="overview"
        clipFilter={{ sort: "recent", range: "all" }}
        onTabChange={() => {}}
        onClipFilterChange={() => {}}
      />,
      "/directory/art",
    );
    expect(screen.getByTestId("category-page").getAttribute("data-tab")).toBe("overview");
    expect(screen.getByTestId("category-overview")).toBeTruthy();
    expect(screen.queryByTestId("category-live-count")).toBeNull();
    expect(screen.getByTestId("category-video-count").textContent).toBe("1.2K videos");
    expect(document.querySelector('header [data-slot="category-art"]')?.getAttribute("data-muted")).toBe("true");
  });

  it("a live category's art is not muted, and no video count shows at 0", async () => {
    await renderInRouter(
      <CategoryPage
        category={category(ART, 1)}
        live={EMPTY}
        overview={NOTHING}
        tab="overview"
        clipFilter={{ sort: "recent", range: "all" }}
        onTabChange={() => {}}
        onClipFilterChange={() => {}}
      />,
    );
    expect(document.querySelector('header [data-slot="category-art"]')?.getAttribute("data-muted")).toBeNull();
    expect(screen.queryByTestId("category-video-count")).toBeNull();
    expect(screen.getByTestId("category-live-count").textContent).toBe("1 channel live");
  });

  it("videoCountLabel is plural-aware", () => {
    expect(videoCountLabel(1, "en")).toBe("1 video");
    expect(videoCountLabel(3, "en")).toBe("3 videos");
  });
});

describe("Directory v2", () => {
  it("splitByLive keeps the order and splits at zero", () => {
    const list = [category(MUSIC, 3), category(ART, 1), category(GAMES, 0)];
    expect(splitByLive(list)).toEqual({ live: [list[0], list[1]], idle: [list[2]] });
    expect(splitByLive([])).toEqual({ live: [], idle: [] });
  });

  it("groups live categories first, then the rest muted with their videos; never a 0 live badge", async () => {
    const page = {
      items: [{ ...category(GAMES, 0), videoCount: 12 }, category(ART, 2, { viewerCount: 5 }), category(MUSIC, 0)],
      nextCursor: null,
    };
    await renderInRouter(<CategoriesView initial={page} />, "/directory");
    const liveGroup = screen.getByTestId("directory-live-categories");
    const idleGroup = screen.getByTestId("directory-idle-categories");
    expect(within(liveGroup).getByText("Categories with live channels")).toBeTruthy();
    expect(within(idleGroup).getByText("All categories")).toBeTruthy();
    expect(ids("category-tile", liveGroup)).toEqual(["art"]);
    expect(ids("category-tile", idleGroup)).toEqual(["games", "music"]);
    for (const tile of idleGroup.querySelectorAll('[data-testid="category-tile"]'))
      expect(tile.getAttribute("data-muted")).toBe("true");
    expect(idleGroup.querySelector('[data-slot="category-tile-live"]')).toBeNull();
    expect(screen.queryByText(/^0 /)).toBeNull();
    const videos = idleGroup.querySelectorAll('[data-testid="category-tile-videos"]');
    expect([...videos].map((v) => v.textContent)).toEqual(["12 videos"]);
    expect(idleGroup.querySelector('[data-category="games"] a')?.getAttribute("href")).toBe("/directory/games");
  });

  it("with nothing live, one group and no second heading", async () => {
    await renderInRouter(<CategoriesView initial={{ items: [category(ART, 0)], nextCursor: null }} />);
    expect(screen.queryByTestId("directory-live-categories")).toBeNull();
    expect(screen.queryByText("All categories")).toBeNull();
    expect(ids("category-tile")).toEqual(["art"]);
  });

  it("no categories at all: the empty state", async () => {
    await renderInRouter(<CategoriesView initial={EMPTY} />);
    expect(screen.getByText("No categories yet")).toBeTruthy();
  });

  it("the categories view leads with the busiest live channels and a link to all of them", async () => {
    const cards = Array.from({ length: LIVE_STRIP + 2 }, (_, i) => art(`s${i}`));
    await renderInRouter(
      <DirectoryPage
        data={{ categories: { items: [category(ART, 6)], nextCursor: null }, live: { items: cards, nextCursor: null } }}
        view="categories"
      />,
      "/directory",
    );
    const strip = screen.getByTestId("directory-live-now");
    expect(strip.querySelectorAll('[data-testid="stream-card"]')).toHaveLength(LIVE_STRIP);
    expect(screen.getByTestId("directory-live-now-all").getAttribute("href")).toBe("/directory?view=live");
    // The strip comes before the categories.
    const page = screen.getByTestId("directory-page");
    const sections = [...page.querySelectorAll("section")].map((s) => s.getAttribute("data-testid"));
    expect(sections.indexOf("directory-live-now")).toBeLessThan(sections.indexOf("directory-live-categories"));
  });

  it("the strip is gone when nobody is live, and has no link when everyone fits", async () => {
    const view = await renderInRouter(<LiveNowStrip cards={[]} />);
    expect(screen.queryByTestId("directory-live-now")).toBeNull();
    view.unmount();
    await renderInRouter(<LiveNowStrip cards={[art("one")]} tag="cozy" />);
    expect(screen.getByTestId("directory-live-now")).toBeTruthy();
    expect(screen.queryByTestId("directory-live-now-all")).toBeNull();
  });
});

const channel = (slug: string, isLive: boolean) => ({
  slug,
  displayName: slug,
  avatarUrl: null,
  live: isLive ? art(slug).broadcast : null,
  followerCount: 2,
});

describe("search v2", () => {
  const results = {
    channels: [channel("livey", true), channel("quiet", false)],
    categories: [category(ART, 1)],
    videos: Array.from({ length: SEARCH_MEDIA + 2 }, (_, i) => vod(i + 1)),
    clips: [clip(1), clip(2, { status: "processing" })],
  };

  it("shows channels, live, videos, clips and categories, in that order", async () => {
    await renderInRouter(<SearchResults q="stream" results={results} />, "/search?q=stream");
    const order = [...document.querySelectorAll("section[data-testid^='search-results-']")].map((s) =>
      s.getAttribute("data-testid"),
    );
    expect(order).toEqual([
      "search-results-channels",
      "search-results-live",
      "search-results-videos",
      "search-results-clips",
      "search-results-categories",
    ]);
    const videos = screen.getByTestId("search-results-videos");
    expect(videos.querySelectorAll('[data-testid="channel-video-card"]')).toHaveLength(SEARCH_MEDIA);
    expect(videos.querySelector("a")?.getAttribute("href")).toBe(`/ch1/vods/${uuid(101)}`);
    expect(within(videos).getAllByTestId("channel-video-card-channel")[0]?.textContent).toBe("ch1");
    const clips = screen.getByTestId("search-results-clips");
    expect(ids("channel-video-card", clips)).toEqual([uuid(201)]);
    expect(clips.querySelector("a")?.getAttribute("href")).toBe(`/ch1/clips/${uuid(201)}`);
    // The live match is a row with its stream title, and a stream card in Live.
    expect(within(screen.getByTestId("search-results-channels")).getByText("livey live")).toBeTruthy();
    expect(ids("stream-card", screen.getByTestId("search-results-live"))).toEqual(["livey"]);
  });

  it("counts every shown result, videos and clips included", async () => {
    expect(resultCount(results)).toBe(2 + SEARCH_MEDIA + 1 + 1);
    await renderInRouter(<SearchResults q="stream" results={results} />);
    expect(screen.getByTestId("search-announcement").textContent).toBe(`${resultCount(results)} results for stream`);
  });

  it("only videos match: just the Videos group", async () => {
    await renderInRouter(
      <SearchResults q="x" results={{ channels: [], categories: [], videos: [vod(1)], clips: [] }} />,
    );
    expect(screen.getByTestId("search-results-videos")).toBeTruthy();
    expect(screen.queryByTestId("search-results-live")).toBeNull();
    expect(screen.queryByTestId("search-results-channels")).toBeNull();
    expect(screen.queryByTestId("search-results-clips")).toBeNull();
    expect(screen.queryByTestId("search-empty")).toBeNull();
  });

  it("no results: says so, with a way to browse categories", async () => {
    await renderInRouter(<SearchResults q="zzz" results={{ channels: [], categories: [], videos: [], clips: [] }} />);
    const empty = screen.getByTestId("search-empty");
    expect(empty.textContent).toContain("Nothing matches “zzz”");
    expect(empty.querySelector("a")?.getAttribute("href")).toBe("/directory");
    expect(empty.querySelector("a")?.textContent).toBe("Browse categories");
  });

  it("an empty query gets its own page: recent searches, live now and popular categories, counted once", async () => {
    sessionStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["lofi", "chess"]));
    await renderInRouter(
      <SearchStart
        start={{
          categories: [category(GAMES, 0), category(MUSIC, 4), category(ART, 9)],
          live: Array.from({ length: 8 }, (_, i) => music(`m${i}`)),
        }}
      />,
      "/search",
    );
    expect(fake.tracked).toEqual([["search.empty", "view"]]);
    expect(screen.getByText("Find something to watch")).toBeTruthy();
    const recent = await screen.findAllByTestId("search-recent-query");
    expect(recent.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["lofi", "/search?q=lofi"],
      ["chess", "/search?q=chess"],
    ]);
    expect(screen.getByTestId("search-start-live").querySelectorAll('[data-testid="stream-card"]')).toHaveLength(6);
    expect(ids("search-category", screen.getByTestId("search-popular-categories"))).toEqual(["art", "music", "games"]);
  });

  it("the empty-query page with nothing loaded says what did not load; no recent searches, no group", async () => {
    await renderInRouter(<SearchStart start={null} />);
    expect(screen.getByTestId("search-start-error").textContent).toContain("Live now didn't load.");
    expect(screen.queryByTestId("search-recent")).toBeNull();
  });

  it("the page shows the start page without a query and the results with one", async () => {
    const view = await renderInRouter(
      <SearchPage q="" data={{ kind: "start", start: { categories: [], live: [] } }} />,
    );
    expect(screen.getByTestId("search-start")).toBeTruthy();
    expect(screen.getByTestId("search-input").getAttribute("placeholder")).toBe(
      "Search channels, videos and categories",
    );
    view.unmount();
    await renderInRouter(<SearchPage q="stream" data={{ kind: "results", results }} />);
    expect(screen.queryByTestId("search-start")).toBeNull();
    expect(screen.getByTestId("search-results-videos")).toBeTruthy();
  });

  it("a failed load with a query: the error, not the start page", async () => {
    await renderInRouter(<SearchPage q="stream" data={null} />);
    expect(screen.getByTestId("search-load-error")).toBeTruthy();
    expect(screen.queryByTestId("search-start")).toBeNull();
  });
});

describe("settledOrNull", () => {
  it("is the value when fulfilled and null when rejected", async () => {
    const [ok, bad] = await Promise.allSettled([Promise.resolve(3), Promise.reject(new Error("x"))]);
    if (!ok || !bad) throw new Error("allSettled");
    expect(settledOrNull(ok)).toBe(3);
    expect(settledOrNull(bad)).toBeNull();
  });
});
