// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `/directory/$category`'s follow-ups: the header's verified viewers (`Category.viewerCount`) and
 * tags (links to the tag filter); the Live, Videos and Clips tabs as `?tab=` (Live bare), Videos
 * and Clips paged from `vods.listByCategory` / `clips.listByCategory` with loading, empty and
 * error states and the clips sort and range; and the recently-live tile's latest VOD.
 */
import type { Category } from "@commonair/contracts/dto";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ART, boot, category, home, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));

const { CategoryPage, categoryTabSearch, isCategoryTab, parseCategorySearch } =
  await import("../src/components/discovery/category-page.tsx");
const { ChannelMediaClientContext } = await import("../src/components/channel/use-media-list.ts");
const { Directory } = await import("../src/components/directory.tsx");
const { homeLayout } = await import("../src/lib/directory-sections.ts");
type MediaClient = import("../src/components/channel/use-media-list.ts").ChannelMediaClient;
type Vod = import("../src/components/channel/channel-data.ts").VodItem;
type Clip = import("../src/components/channel/channel-data.ts").ClipItem;
type ClipFilter = import("../src/components/channel/clip-filters.tsx").ClipFilter;
type Tab = import("../src/components/discovery/category-page.tsx").CategoryTab;

beforeEach(() => {
  fake.boot = boot();
});
afterEach(cleanup);

const uuid = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const vod = (n: number, over: Partial<Vod> = {}): Vod => ({
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
  ...over,
});
const clip = (n: number): Clip => ({
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
  category: { slug: "art", name: "Art" },
});

const EMPTY = { items: [], nextCursor: null };
const reject = () => Promise.reject(new Error("unexpected"));
function client(over: Partial<MediaClient> = {}): MediaClient {
  return { vods: reject, clips: reject, categoryVods: reject, categoryClips: reject, ...over };
}

const ART_CATEGORY: Category = category(ART, 2, { viewerCount: 1234, tags: ["cozy", "Watercolor"] });
const DEFAULT: ClipFilter = { sort: "recent", range: "all" };

/** The page with its tab and filter in local state, as the route keeps them in the URL. */
function Harness({
  initialTab = "live",
  initialFilter = DEFAULT,
  cat = ART_CATEGORY,
  onTab,
}: {
  initialTab?: Tab;
  initialFilter?: ClipFilter;
  cat?: Category;
  onTab?: (tab: Tab) => void;
}) {
  const [tab, setTab] = React.useState<Tab>(initialTab);
  const [filter, setFilter] = React.useState(initialFilter);
  return (
    <CategoryPage
      category={cat}
      live={EMPTY}
      tab={tab}
      clipFilter={filter}
      onTabChange={(next) => {
        onTab?.(next);
        setTab(next);
      }}
      onClipFilterChange={setFilter}
    />
  );
}

async function renderCategory(node: React.ReactNode, media: MediaClient = client()) {
  return renderInRouter(
    <ChannelMediaClientContext.Provider value={media}>{node}</ChannelMediaClientContext.Provider>,
    "/directory/art",
  );
}

describe("parseCategorySearch", () => {
  it("keeps Videos and Clips, Live is the bare URL, and anything else is Live", () => {
    expect(parseCategorySearch({ tab: "videos" })).toEqual({ tab: "videos" });
    expect(parseCategorySearch({ tab: "clips" })).toEqual({ tab: "clips" });
    for (const bad of ["live", "VIDEOS", "", 1, null, undefined, ["clips"]])
      expect(parseCategorySearch({ tab: bad })).toEqual({});
  });

  it("keeps the clips sort and range only on the Clips tab", () => {
    expect(parseCategorySearch({ tab: "clips", sort: "top", range: "7d" })).toEqual({
      tab: "clips",
      sort: "top",
      range: "7d",
    });
    expect(parseCategorySearch({ tab: "clips", sort: "views", range: "1y" })).toEqual({ tab: "clips" });
    expect(parseCategorySearch({ tab: "videos", sort: "top", range: "7d" })).toEqual({ tab: "videos" });
    expect(parseCategorySearch({ sort: "top" })).toEqual({});
  });

  it("categoryTabSearch drops the defaults", () => {
    expect(categoryTabSearch("live")).toEqual({});
    expect(categoryTabSearch("videos")).toEqual({ tab: "videos" });
    expect(categoryTabSearch("clips", DEFAULT)).toEqual({ tab: "clips" });
    expect(categoryTabSearch("clips", { sort: "top", range: "30d" })).toEqual({
      tab: "clips",
      sort: "top",
      range: "30d",
    });
    expect(isCategoryTab("clips")).toBe(true);
    expect(isCategoryTab("about")).toBe(false);
  });
});

describe("the category header", () => {
  it("shows live channels, verified viewers and every tag as a link to the tag filter", async () => {
    await renderCategory(<Harness />);
    expect(screen.getByTestId("category-live-count").textContent).toBe("2 channels live");
    const viewers = screen.getByTestId("category-viewer-count");
    expect(viewers.getAttribute("data-count")).toBe("1234");
    expect(viewers.textContent).toContain("1,234 viewers");
    const tags = [...screen.getByTestId("category-tags").querySelectorAll('[data-testid="category-tag"]')];
    expect(tags.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["cozy", "/directory?tag=cozy"],
      ["Watercolor", "/directory?tag=Watercolor"],
    ]);
    expect(screen.getByTestId("category-tags").getAttribute("aria-label")).toBe("Popular tags in Art");
  });

  it("nobody live: no viewer count and no tag list", async () => {
    await renderCategory(<Harness cat={category(ART, 0)} />);
    expect(screen.queryByTestId("category-viewer-count")).toBeNull();
    expect(screen.queryByTestId("category-tags")).toBeNull();
    expect(screen.getByTestId("category-live-count").textContent).toBe("0 channels live");
  });
});

describe("the category tabs", () => {
  it("Live, Videos and Clips; only the active one loads", async () => {
    const categoryVods = vi.fn<MediaClient["categoryVods"]>(async () => EMPTY);
    await renderCategory(<Harness />, client({ categoryVods }));
    expect(["live", "videos", "clips"].map((id) => screen.getByTestId(`category-tab-${id}`).textContent)).toEqual([
      "Live channels",
      "Videos",
      "Clips",
    ]);
    expect(screen.getByTestId("category-page").getAttribute("data-tab")).toBe("live");
    expect(categoryVods).not.toHaveBeenCalled();
  });

  it("Videos: a skeleton, then the category's VODs with their channel; Show more asks for the next page", async () => {
    let resolve: (page: { items: Vod[]; nextCursor: string | null }) => void = () => {};
    const categoryVods = vi.fn<MediaClient["categoryVods"]>((_slug, cursor) =>
      cursor
        ? Promise.resolve({ items: [vod(3)], nextCursor: null })
        : new Promise((r) => {
            resolve = r;
          }),
    );
    const onTab = vi.fn<(tab: Tab) => void>();
    await renderCategory(<Harness onTab={onTab} />, client({ categoryVods }));
    act(() => {
      fireEvent.click(screen.getByTestId("category-tab-videos"));
    });
    expect(onTab).toHaveBeenCalledWith("videos");
    const grid = await screen.findByTestId("channel-video-grid");
    expect(grid.getAttribute("data-state")).toBe("loading");
    expect(categoryVods).toHaveBeenCalledWith("art", undefined);
    await act(async () => resolve({ items: [vod(1), vod(2, { status: "processing" })], nextCursor: "c1" }));
    await waitFor(() => expect(grid.getAttribute("data-state")).toBe("ready"));
    expect(grid.getAttribute("data-count")).toBe("1");
    expect(grid.querySelector('[data-testid="channel-video-card-channel"]')?.textContent).toBe("ch1");
    expect(grid.querySelector("a")?.getAttribute("href")).toBe(`/ch1/vods/${uuid(101)}`);
    act(() => {
      fireEvent.click(screen.getByTestId("channel-video-grid-more"));
    });
    await waitFor(() => expect(grid.getAttribute("data-count")).toBe("2"));
    expect(categoryVods).toHaveBeenLastCalledWith("art", "c1");
  });

  it("Videos: an empty category says so; a failure offers Try again", async () => {
    let fail = true;
    const categoryVods = vi.fn<MediaClient["categoryVods"]>(async () => {
      if (fail) throw new Error("down");
      return EMPTY;
    });
    await renderCategory(<Harness initialTab="videos" />, client({ categoryVods }));
    const retry = await screen.findByText("Try again");
    fail = false;
    act(() => {
      fireEvent.click(retry);
    });
    const empty = await screen.findByTestId("category-media-empty");
    expect(empty.getAttribute("data-kind")).toBe("vods");
    expect(empty.textContent).toContain("No videos in Art yet");
  });

  it("Clips: the sort and range ask for a fresh first page; an empty range says so", async () => {
    const categoryClips = vi.fn<MediaClient["categoryClips"]>(async (_slug, _cursor, filter) =>
      filter?.range === "7d" ? EMPTY : { items: [clip(1), clip(2)], nextCursor: null },
    );
    await renderCategory(<Harness initialTab="clips" />, client({ categoryClips }));
    const grid = await screen.findByTestId("channel-video-grid");
    await waitFor(() => expect(grid.getAttribute("data-count")).toBe("2"));
    expect(categoryClips).toHaveBeenLastCalledWith("art", undefined, DEFAULT);
    expect(screen.getByTestId("clip-sort-recent").getAttribute("aria-pressed")).toBe("true");

    act(() => {
      fireEvent.click(screen.getByTestId("clip-sort-top"));
    });
    await waitFor(() =>
      expect(categoryClips).toHaveBeenLastCalledWith("art", undefined, { sort: "top", range: "all" }),
    );
    act(() => {
      fireEvent.click(screen.getByTestId("clip-range-7d"));
    });
    await waitFor(() => expect(categoryClips).toHaveBeenLastCalledWith("art", undefined, { sort: "top", range: "7d" }));
    expect(await screen.findByTestId("clips-filtered-empty")).toBeTruthy();
    expect(screen.queryByTestId("category-media-empty")).toBeNull();
  });

  it("Clips: an empty category (default filter) gets the category's empty state", async () => {
    await renderCategory(<Harness initialTab="clips" />, client({ categoryClips: async () => EMPTY }));
    const empty = await screen.findByTestId("category-media-empty");
    expect(empty.getAttribute("data-kind")).toBe("clips");
    expect(empty.textContent).toContain("No clips in Art yet");
  });
});

describe("recently live tiles (latestVod)", () => {
  it("with a VOD: its thumbnail and length link to the VOD; the name still links to the channel", async () => {
    const layout = homeLayout(
      home({
        recentlyLive: [
          offline("napper", "2026-11-03T00:00:00.000Z", {
            latestVod: { id: uuid(9), thumbnailUrl: "https://media.example.test/v/9.jpg", durationSeconds: 3725 },
          }),
          offline("never", null),
        ],
      }),
      false,
    );
    await renderInRouter(<Directory sections={layout.sections} offline={layout.offline} />);
    const tiles = screen.getAllByTestId("home-recent-tile");
    expect(tiles).toHaveLength(2);
    const [withVod, without] = tiles;
    const vodLink = withVod?.querySelector('[data-testid="channel-card-vod"]');
    expect(vodLink?.getAttribute("href")).toBe(`/napper/vods/${uuid(9)}`);
    expect(vodLink?.getAttribute("aria-label")).toBe("Watch napper's latest video (1:02:05)");
    expect(vodLink?.querySelector("img")?.getAttribute("src")).toBe("https://media.example.test/v/9.jpg");
    expect(vodLink?.textContent).toContain("1:02:05");
    expect(withVod?.querySelector('[data-testid="channel-card"]')?.getAttribute("href")).toBe("/napper");
    // The channel link no longer repeats the avatar frame.
    expect(withVod?.querySelector('[data-testid="channel-card"] [data-accent]')).toBeNull();
    // Without a VOD: the avatar frame inside the channel link, no VOD link.
    expect(without?.querySelector('[data-testid="channel-card-vod"]')).toBeNull();
    expect(without?.querySelector('[data-testid="channel-card"] [data-accent]')).not.toBeNull();
  });

  it("a VOD without a thumbnail keeps the avatar frame, with the length, inside the VOD link", async () => {
    const layout = homeLayout(
      home({
        recentlyLive: [
          offline("napper", "2026-11-03T00:00:00.000Z", {
            latestVod: { id: uuid(9), thumbnailUrl: null, durationSeconds: 59 },
          }),
        ],
      }),
      false,
    );
    await renderInRouter(<Directory sections={layout.sections} offline={layout.offline} />);
    const vodLink = screen.getByTestId("channel-card-vod");
    expect(vodLink.querySelector("img")).toBeNull();
    expect(vodLink.querySelector("[data-accent]")).not.toBeNull();
    expect(vodLink.textContent).toContain("0:59");
  });
});
