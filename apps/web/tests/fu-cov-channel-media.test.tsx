// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The channel and category media seams beyond the existing suites: the API client behind the
 * grids (limits, cursors, the clip filter's defaults), `useMediaList`'s paging edges (no cursor,
 * a double "Show more", a failed page, an answer for a filter that has since changed, retry),
 * every social platform's name, the category page's tab search and its not-found state, and the
 * video tiles' fallbacks.
 */
import { act, cleanup, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { boot, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ calls: [] as [string, unknown][] }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => boot() }));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const rec = (name: string) => async (input: unknown) => {
    fake.calls.push([name, input]);
    return { items: [], nextCursor: null };
  };
  const client = {
    vods: { list: rec("vods.list"), listByCategory: rec("vods.listByCategory") },
    clips: { list: rec("clips.list"), listByCategory: rec("clips.listByCategory") },
  };
  return { ...(await importOriginal<typeof import("../src/lib/api.ts")>()), api: () => client };
});

const { platformName } = await import("../src/components/channel/about.tsx");
const { CHANNEL_MEDIA_PAGE } = await import("../src/components/channel/channel-data.ts");
const { channelMediaClient, useMediaList } = await import("../src/components/channel/use-media-list.ts");
const { CategoryNotFound, categoryTabSearch, isCategoryTab } =
  await import("../src/components/discovery/category-page.tsx");
const { clipTile, tileTitle, vodTile } = await import("../src/components/channel/video-grid.tsx");
const { t } = await import("../src/i18n/index.ts");
type MediaPage<T> = import("../src/components/channel/channel-data.ts").MediaPage<T>;

afterEach(() => {
  cleanup();
  fake.calls.length = 0;
});

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Item = { id: string };
const page = (ids: string[], nextCursor: string | null): MediaPage<Item> => ({
  items: ids.map((id) => ({ id })),
  nextCursor,
});

describe("channelMediaClient", () => {
  it("asks one page of CHANNEL_MEDIA_PAGE, adding the cursor only when there is one", async () => {
    const c = channelMediaClient();
    await c.vods("rivertide");
    await c.vods("rivertide", "cur1");
    await c.clips("rivertide");
    await c.clips("rivertide", "cur2", { sort: "top", range: "7d" });
    await c.categoryVods("art");
    await c.categoryVods("art", "cur3");
    await c.categoryClips("art");
    await c.categoryClips("art", "cur4", { sort: "recent", range: "30d" });
    const limit = CHANNEL_MEDIA_PAGE;
    expect(fake.calls).toEqual([
      ["vods.list", { channel: "rivertide", limit }],
      ["vods.list", { channel: "rivertide", limit, cursor: "cur1" }],
      ["clips.list", { channel: "rivertide", limit, sort: "recent", range: "all" }],
      ["clips.list", { channel: "rivertide", limit, sort: "top", range: "7d", cursor: "cur2" }],
      ["vods.listByCategory", { slug: "art", limit }],
      ["vods.listByCategory", { slug: "art", limit, cursor: "cur3" }],
      ["clips.listByCategory", { slug: "art", limit, sort: "recent", range: "all" }],
      ["clips.listByCategory", { slug: "art", limit, sort: "recent", range: "30d", cursor: "cur4" }],
    ]);
  });
});

describe("useMediaList paging", () => {
  it("with an initial page: ready at once, no fetch; without a cursor Show more does nothing", async () => {
    const fetchPage = vi.fn<(cursor?: string) => Promise<MediaPage<Item>>>(async () => page(["x"], null));
    const { result } = renderHook(() => useMediaList(fetchPage, page(["a", "b"], null)));
    expect(result.current.status).toBe("ready");
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.loadMore());
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("a double Show more in one frame asks for the page once; the page appends without repeats", async () => {
    const next = deferred<MediaPage<Item>>();
    const fetchPage = vi.fn<(cursor?: string) => Promise<MediaPage<Item>>>((cursor?: string) =>
      cursor ? next.promise : Promise.resolve(page([], null)),
    );
    const { result } = renderHook(() => useMediaList(fetchPage, page(["a", "b"], "c1")));
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.loadingMore).toBe(true);
    await act(async () => next.resolve(page(["b", "c"], null)));
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadingMore).toBe(false);
  });

  it("a failed Show more keeps the items and says so; the next try clears it", async () => {
    const fetchPage = vi.fn<(cursor?: string) => Promise<MediaPage<Item>>>(async (cursor?: string) => {
      if (cursor === "c1" && fetchPage.mock.calls.length === 1) throw new Error("down");
      return page(["z"], null);
    });
    const { result } = renderHook(() => useMediaList(fetchPage, page(["a"], "c1")));
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(result.current.moreFailed).toBe(true));
    expect(result.current.items.map((i) => i.id)).toEqual(["a"]);
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["a", "z"]));
    expect(result.current.moreFailed).toBe(false);
  });

  it("a first-page failure is an error; retry asks again", async () => {
    let fail = true;
    const fetchPage = vi.fn<(cursor?: string) => Promise<MediaPage<Item>>>(async () => {
      if (fail) throw new Error("down");
      return page(["a"], null);
    });
    const { result } = renderHook(() => useMediaList(fetchPage, null));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("error"));
    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("a new source drops the shown list, and a Show more answer (or failure) for the old one is ignored", async () => {
    const oldMore = deferred<MediaPage<Item>>();
    const oldFail = deferred<MediaPage<Item>>();
    let round = 0;
    const first = vi.fn<(cursor?: string) => Promise<MediaPage<Item>>>((cursor?: string) => {
      if (!cursor) return Promise.resolve(page(["a"], "c1"));
      round++;
      return round === 1 ? oldMore.promise : oldFail.promise;
    });
    const second = vi.fn<(cursor?: string) => Promise<MediaPage<Item>>>(async () => page(["n"], "n1"));
    const { result, rerender } = renderHook(({ f }) => useMediaList(f, page(["a"], "c1")), {
      initialProps: { f: first as (cursor?: string) => Promise<MediaPage<Item>> },
    });
    act(() => result.current.loadMore());
    rerender({ f: second });
    expect(result.current.status).toBe("loading");
    expect(result.current.items).toEqual([]);
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["n"]));
    await act(async () => oldMore.resolve(page(["stale"], null)));
    expect(result.current.items.map((i) => i.id)).toEqual(["n"]);
    expect(result.current.hasMore).toBe(true);
    // An old failure is not the new list's.
    rerender({ f: first });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["a"]));
    act(() => result.current.loadMore());
    rerender({ f: second });
    await act(async () => oldFail.reject(new Error("down")));
    expect(result.current.moreFailed).toBe(false);
  });

  it("a first page that answers after unmount (or after the source changed) is dropped", async () => {
    const late = deferred<MediaPage<Item>>();
    const fetchPage = vi.fn<(cursor?: string) => Promise<MediaPage<Item>>>(() => late.promise);
    const { result, unmount } = renderHook(() => useMediaList(fetchPage, null));
    unmount();
    await act(async () => late.resolve(page(["a"], null)));
    expect(result.current.items).toEqual([]);
    const lateFail = deferred<MediaPage<Item>>();
    const b = renderHook(() => useMediaList(() => lateFail.promise, null));
    b.unmount();
    await act(async () => lateFail.reject(new Error("down")));
    expect(b.result.current.status).toBe("loading");
  });
});

describe("about: platform names", () => {
  it("every platform has its name", () => {
    expect(
      (
        [
          "website",
          "mastodon",
          "bluesky",
          "youtube",
          "twitch",
          "x",
          "instagram",
          "tiktok",
          "discord",
          "github",
          "other",
        ] as const
      ).map(platformName),
    ).toEqual([
      t("fuChannel.socials.website"),
      "Mastodon",
      "Bluesky",
      "YouTube",
      "Twitch",
      "X",
      "Instagram",
      "TikTok",
      "Discord",
      "GitHub",
      t("fuChannel.socials.other"),
    ]);
  });
});

describe("category page helpers", () => {
  it("tab search: Overview is bare, Live and Videos their tab, Clips adds only non-default filters", () => {
    expect(categoryTabSearch("overview")).toEqual({});
    expect(categoryTabSearch("live")).toEqual({ tab: "live" });
    expect(categoryTabSearch("live", { sort: "top", range: "7d" })).toEqual({ tab: "live" });
    expect(categoryTabSearch("videos", { sort: "top", range: "7d" })).toEqual({ tab: "videos" });
    expect(categoryTabSearch("clips")).toEqual({ tab: "clips" });
    expect(categoryTabSearch("clips", { sort: "recent", range: "all" })).toEqual({ tab: "clips" });
    expect(categoryTabSearch("clips", { sort: "top", range: "30d" })).toEqual({
      tab: "clips",
      sort: "top",
      range: "30d",
    });
    expect(isCategoryTab("clips")).toBe(true);
    expect(isCategoryTab("about")).toBe(false);
    expect(isCategoryTab(undefined)).toBe(false);
  });

  it("an unknown category: the not-found state pointing back to the directory", async () => {
    await renderInRouter(<CategoryNotFound />, "/directory/nope");
    const state = await screen.findByTestId("category-not-found");
    expect(state.textContent).toContain(t("discovery.category.notFound"));
    expect(state.textContent).toContain(t("discovery.category.notFoundHint"));
  });
});

describe("video tiles", () => {
  it("a clip without a creator names no one; an untitled tile gets its kind's title", () => {
    const tile = clipTile({
      id: "c1",
      channelSlug: "rivertide",
      title: "  ",
      creator: null,
      status: "ready",
      durationSeconds: 30,
      url: null,
      thumbnailUrl: null,
      views: 0,
      createdAt: "2026-11-01T12:00:00.000Z",
      windowStartedAt: null,
      category: null,
    } as never);
    expect(tile).toMatchObject({ kind: "clips", clippedBy: null, views: 0 });
    expect(tileTitle(tile)).toBe(t("channel.tabs.untitledClip"));
    const vod = vodTile({
      id: "v1",
      channelSlug: "rivertide",
      title: "",
      thumbnailUrl: null,
      durationSeconds: 1,
      createdAt: "2026-11-01T12:00:00.000Z",
    } as never);
    expect(vod).toMatchObject({ kind: "vods", views: null, clippedBy: null });
    expect(tileTitle(vod)).toBe(t("channel.tabs.untitledVideo"));
  });
});
