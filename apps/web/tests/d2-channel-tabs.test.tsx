// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-channel (F2): the channel page's tabs are search params (`?tab=videos|clips|about`, Home bare),
 * so each is a link and Back steps through them; a bad `tab` is Home; a tab switch does not reload
 * the page's data; the Videos and Clips grids page with "Show more", retry after a failure, and say
 * when they are empty (with a stream-manager action for the owner, none for a visitor). The real
 * route component renders inside a memory router; the player, chat and support dialog are stubs.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

// The page renders through the router and its loader; on a busy CI runner the first paint can
// take longer than testing-library's 1 s default.
configure({ asyncUtilTimeout: 5_000 });

const boot = vi.hoisted(() => ({
  me: null as null | { id: string; username: string; displayName: string; channelSlug: string | null; role: string },
}));
// How many times the stubs mounted: a layout change must never remount the player or chat.
const mounts = vi.hoisted(() => ({ player: 0, chat: 0 }));
// Stands in for the polled summary: when set, `useChannel` returns it instead of the loader's.
const polled = vi.hoisted(() => ({ summary: null as unknown }));

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: boot.me, config: { publicUrl: "https://air.example.test" }, now: Date.now() }),
}));
vi.mock("../src/lib/use-channel.ts", () => ({
  useChannel: (_slug: string, initial: unknown) => polled.summary ?? initial,
}));
vi.mock("../src/player/player.tsx", () => ({
  Player: ({ live, offline }: { live: boolean; offline?: React.ReactNode }) => {
    React.useEffect(() => {
      mounts.player += 1;
    }, []);
    return (
      <div data-testid="player" data-live={String(live)}>
        {live ? null : offline}
      </div>
    );
  },
}));
vi.mock("../src/chat/chat-panel.tsx", () => ({
  ChatPanel: ({ className }: { className?: string }) => {
    React.useEffect(() => {
      mounts.chat += 1;
    }, []);
    return <div data-testid="chat" className={className} />;
  },
}));
vi.mock("../src/components/support/support-dialog.tsx", () => ({
  SupportButton: () => <span data-testid="support-stub" />,
}));

const { Route } = await import("../src/routes/_app/$channel.tsx");
const { parseChannelSearch, tabSearch, isChannelTab, CHANNEL_TABS } =
  await import("../src/components/channel/channel-data.ts");
const { ChannelMediaClientContext } = await import("../src/components/channel/use-media-list.ts");
const { TheatreContext } = await import("../src/player/theatre.ts");
const { chatColumnClass } = await import("../src/chat/layout.ts");
type ChannelPage = import("../src/components/channel/panels-loader.ts").ChannelPage;
type MediaClient = import("../src/components/channel/use-media-list.ts").ChannelMediaClient;
type Vod = import("../src/components/channel/channel-data.ts").VodItem;
type Clip = import("../src/components/channel/channel-data.ts").ClipItem;

afterEach(() => {
  cleanup();
  boot.me = null;
  mounts.player = 0;
  mounts.chat = 0;
  polled.summary = null;
});

const uuid = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

function vod(n: number, over: Partial<Vod> = {}): Vod {
  return {
    id: uuid(100 + n),
    channelSlug: "fern",
    title: `Stream ${n}`,
    status: "ready",
    views: 0,
    visibility: "public",
    durationSeconds: 3600 + n,
    thumbnailUrl: null,
    playlistUrl: null,
    createdAt: new Date(Date.UTC(2026, 9, 30 - n)).toISOString(),
    expiresAt: null,
    failedReason: null,
    captions: [],
    category: null,
    ...over,
  };
}

function clip(n: number, over: Partial<Clip> = {}): Clip {
  return {
    id: uuid(200 + n),
    channelSlug: "fern",
    title: `Clip ${n}`,
    creator: { id: uuid(9), username: "viewer1", displayName: "Viewer One" },
    status: "ready",
    durationSeconds: 30,
    url: null,
    thumbnailUrl: null,
    views: n,
    createdAt: new Date(Date.UTC(2026, 9, 30 - n)).toISOString(),
    windowStartedAt: null,
    vodId: null,
    vodOffsetSeconds: null,
    category: null,
    ...over,
  };
}

function page(over: Partial<ChannelPage> = {}): ChannelPage {
  return {
    summary: {
      id: uuid(1),
      slug: "fern",
      displayName: "Fernsby",
      title: "Cozy village",
      avatarUrl: null,
      accent: null,
      mature: false,
      live: null,
      category: { id: "0192f000-0000-7000-8000-0000000000c1", slug: "art", name: "Art" },
      tags: ["cozy"],
      lastLiveAt: null,
      followerCount: 12,
      following: null,
      portabilityGrant: null,
      movedTo: null,
    },
    extras: { bannerUrl: null, panels: [], suspended: false },
    about: { bio: "I build villages.", socials: [] },
    vods: { items: [vod(1), vod(2)], nextCursor: null },
    clips: { items: [clip(1)], nextCursor: null },
    ...over,
  };
}

const neverClient: MediaClient = {
  vods: () => Promise.reject(new Error("unexpected")),
  clips: () => Promise.reject(new Error("unexpected")),
  categoryVods: () => Promise.reject(new Error("unexpected")),
  categoryClips: () => Promise.reject(new Error("unexpected")),
};

function renderPage(
  data: ChannelPage,
  path = "/fern",
  client: MediaClient = neverClient,
  wrap: (node: React.ReactNode) => React.ReactNode = (node) => node,
) {
  const loader = vi.fn<() => ChannelPage>(() => data);
  const root = createRootRoute({ component: () => <Outlet /> });
  const app = createRoute({ getParentRoute: () => root, id: "_app", component: () => <Outlet /> });
  const channel = createRoute({
    getParentRoute: () => app,
    path: "$channel",
    validateSearch: Route.options.validateSearch as typeof parseChannelSearch,
    shouldReload: Route.options.shouldReload as never,
    loader,
    component: Route.options.component as never,
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: root.addChildren([app.addChildren([channel])]), history });
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <ChannelMediaClientContext.Provider value={client}>
          {wrap(<RouterProvider router={router} />)}
        </ChannelMediaClientContext.Provider>
      </TooltipProvider>
    </LocaleProvider>,
  );
  return { router, history, loader };
}

const tabs = () => screen.getByTestId("channel-tabs");
const clickTab = (id: string) => {
  act(() => {
    fireEvent.click(screen.getByTestId(`channel-tab-${id}`));
  });
};

describe("parseChannelSearch", () => {
  it("keeps the three named tabs and drops anything else (Home)", () => {
    expect(parseChannelSearch({ tab: "videos" })).toEqual({ tab: "videos" });
    expect(parseChannelSearch({ tab: "clips" })).toEqual({ tab: "clips" });
    expect(parseChannelSearch({ tab: "about" })).toEqual({ tab: "about" });
    for (const bad of ["home", "VIDEOS", "", " videos", 1, null, undefined, ["videos"], { tab: "x" }])
      expect(parseChannelSearch({ tab: bad })).toEqual({});
    expect(parseChannelSearch({})).toEqual({});
    expect(parseChannelSearch({ other: "1", tab: "clips" })).toEqual({ tab: "clips" });
  });

  it("tabSearch drops the param for Home, so /name stays the canonical URL", () => {
    expect(tabSearch("home")).toEqual({});
    for (const tab of ["videos", "clips", "about"] as const) expect(tabSearch(tab)).toEqual({ tab });
    expect(CHANNEL_TABS).toEqual(["home", "videos", "clips", "about"]);
    expect(isChannelTab("about")).toBe(true);
    expect(isChannelTab("schedule")).toBe(false);
  });

  it("is the route's validateSearch, and a tab switch does not reload the loader", () => {
    expect(Route.options.validateSearch).toBe(parseChannelSearch);
    const shouldReload = Route.options.shouldReload as (ctx: { cause: string }) => boolean;
    expect(shouldReload({ cause: "stay" })).toBe(false);
    expect(shouldReload({ cause: "enter" })).toBe(true);
  });
});

describe("the channel tabs", () => {
  it("opens on Home, and each tab is a search param that Back steps through", async () => {
    const { history, loader } = renderPage(page());
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("home"));
    // The phone layout's "Chat | About" switch is a tablist too (D4.1).
    const list = screen.getByRole("tablist", { name: "Channel sections" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Home", "Videos", "Clips", "About"]);

    clickTab("videos");
    await waitFor(() => expect(history.location.search).toBe("?tab=videos"));
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("videos"));
    expect(screen.getByTestId("channel-video-grid").getAttribute("data-kind")).toBe("vods");

    clickTab("clips");
    await waitFor(() => expect(history.location.search).toBe("?tab=clips"));
    clickTab("about");
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("about"));
    expect(screen.getByTestId("channel-about").textContent).toContain("I build villages.");

    act(() => history.back());
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("clips"));
    act(() => history.back());
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("videos"));
    act(() => history.back());
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("home"));
    expect(history.location.search).toBe("");

    clickTab("about");
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("about"));
    clickTab("home");
    await waitFor(() => expect(history.location.search).toBe(""));
    // Switching tabs stayed on the page: the loader ran once.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("a link opens its tab directly, and an unknown tab is Home", async () => {
    renderPage(page(), "/fern?tab=clips");
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("clips"));
    expect(screen.getByTestId("channel-video-grid").getAttribute("data-kind")).toBe("clips");
    cleanup();
    renderPage(page(), "/fern?tab=schedule");
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("home"));
  });

  it("only the active panel is mounted, and the selected tab says so", async () => {
    renderPage(page(), "/fern?tab=videos");
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("videos"));
    expect(screen.getByTestId("channel-tab-videos").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("channel-tab-home").getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByTestId("channel-about")).toBeNull();
    expect(screen.getAllByTestId("channel-video-grid")).toHaveLength(1);
  });
});

describe("the Videos and Clips grids", () => {
  it("lists ready VODs as links to their watch pages, newest first, and leaves others out", async () => {
    renderPage(
      page({
        vods: {
          items: [vod(1), vod(2, { status: "processing" }), vod(3), vod(4, { status: "failed" })],
          nextCursor: null,
        },
      }),
      "/fern?tab=videos",
    );
    const grid = await screen.findByTestId("channel-video-grid");
    expect(grid.getAttribute("data-count")).toBe("2");
    const cards = screen.getAllByTestId("channel-video-card");
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Stream 1"),
      expect.stringContaining("Stream 3"),
    ]);
    expect(cards[0]?.querySelector("a")?.getAttribute("href")).toBe(`/fern/vods/${uuid(101)}`);
    // Length on the thumbnail, the recording time as <time>, no view count (VODs have none).
    expect(cards[0]?.textContent).toContain("1:00:01");
    expect(cards[0]?.querySelector("time")?.getAttribute("datetime")).toBe(vod(1).createdAt);
    expect(cards[0]?.textContent).not.toMatch(/view/);
  });

  it("clips show views and who clipped them, and link to the clip page", async () => {
    renderPage(page({ clips: { items: [clip(1), clip(5)], nextCursor: null } }), "/fern?tab=clips");
    const cards = await screen.findAllByTestId("channel-video-card");
    expect(cards[0]?.textContent).toContain("1 view");
    expect(cards[1]?.textContent).toContain("5 views");
    expect(cards[0]?.textContent).toContain("Clipped by Viewer One");
    expect(cards[0]?.querySelector("a")?.getAttribute("href")).toBe(`/fern/clips/${uuid(201)}`);
  });

  it("Show more asks for the next page by cursor and appends it without duplicates", async () => {
    const vods = vi.fn<MediaClient["vods"]>(async () => ({ items: [vod(2), vod(3)], nextCursor: null }));
    renderPage(page({ vods: { items: [vod(1), vod(2)], nextCursor: "c2" } }), "/fern?tab=videos", {
      ...neverClient,
      vods,
    });
    const more = await screen.findByTestId("channel-video-grid-more");
    expect(more.textContent).toBe("Show more");
    act(() => {
      fireEvent.click(more);
    });
    act(() => {
      fireEvent.click(more);
    });
    await waitFor(() => expect(screen.getAllByTestId("channel-video-card")).toHaveLength(3));
    expect(vods).toHaveBeenCalledTimes(1);
    expect(vods).toHaveBeenCalledWith("fern", "c2");
    expect(screen.queryByTestId("channel-video-grid-more")).toBeNull();
  });

  it("a list that failed on the server is asked again in the browser, with Retry on failure", async () => {
    let fail = true;
    const vods = vi.fn<MediaClient["vods"]>(async () => {
      if (fail) throw new Error("down");
      return { items: [vod(1)], nextCursor: null };
    });
    renderPage(page({ vods: null }), "/fern?tab=videos", { ...neverClient, vods });
    await waitFor(() => expect(screen.getByTestId("channel-video-grid").getAttribute("data-state")).toBe("error"));
    expect(screen.getByText("This list didn't load")).toBeTruthy();
    fail = false;
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(screen.getAllByTestId("channel-video-card")).toHaveLength(1));
    expect(vods).toHaveBeenCalledTimes(2);
  });
});

describe("each grid's empty state", () => {
  const empty = () => page({ vods: { items: [], nextCursor: null }, clips: { items: [], nextCursor: null } });

  it.each(["videos", "clips"] as const)("%s, as a visitor: says so, with no action", async (tab) => {
    renderPage(empty(), `/fern?tab=${tab}`);
    const state = await screen.findByTestId("channel-media-empty");
    expect(state.getAttribute("data-own")).toBe("false");
    expect(state.getAttribute("data-kind")).toBe(tab === "videos" ? "vods" : "clips");
    expect(state.textContent).toContain(tab === "videos" ? "No videos yet" : "No clips yet");
    expect(state.textContent).toContain("Fernsby");
    expect(state.querySelector('[data-testid="empty-state-action"]')).toBeNull();
  });

  it.each(["videos", "clips"] as const)("%s, as the owner: an action to the stream manager", async (tab) => {
    boot.me = { id: uuid(1), username: "fern", displayName: "Fernsby", channelSlug: "fern", role: "user" };
    renderPage(empty(), `/fern?tab=${tab}`);
    const state = await screen.findByTestId("channel-media-empty");
    expect(state.getAttribute("data-own")).toBe("true");
    expect(state.textContent).toContain(
      tab === "videos"
        ? "Go live and your stream is saved here as a video."
        : "Clips your viewers cut from your streams show up here.",
    );
    const action = state.querySelector('[data-testid="empty-state-action"]');
    expect(action?.tagName).toBe("A");
    expect(action?.getAttribute("href")).toBe("/dashboard");
    expect(action?.textContent).toBe("Stream manager");
  });

  it("a signed-in visitor who is not the owner gets no action", async () => {
    boot.me = { id: uuid(2), username: "viewer1", displayName: "Viewer", channelSlug: "viewer1", role: "user" };
    renderPage(empty(), "/fern?tab=videos");
    const state = await screen.findByTestId("channel-media-empty");
    expect(state.getAttribute("data-own")).toBe("false");
    expect(state.querySelector('[data-testid="empty-state-action"]')).toBeNull();
  });
});

describe("Home while live", () => {
  it("keeps the player and chat above the tabs, with Videos and Clips shelves that open their tabs", async () => {
    const live = page();
    live.summary.live = {
      id: uuid(50),
      title: "Live now",
      viewerCount: 40,
      catchingUpCount: 0,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      mature: false,
      restricted: null,
    };
    const { history } = renderPage(live);
    await waitFor(() => expect(screen.getByTestId("player").getAttribute("data-live")).toBe("true"));
    expect(screen.getByTestId("chat")).toBeTruthy();
    const shelves = screen.getAllByTestId("channel-shelf");
    expect(shelves.map((s) => s.getAttribute("data-kind"))).toEqual(["vods", "clips"]);
    // "View all" is a real link (middle-click, open in a new tab).
    const viewAll = screen.getAllByTestId("channel-shelf-view-all");
    expect(viewAll.map((a) => [a.tagName, a.textContent, a.getAttribute("href")])).toEqual([
      ["A", "View all", "/fern?tab=videos"],
      ["A", "View all", "/fern?tab=clips"],
    ]);
    act(() => {
      fireEvent.click(viewAll[1] as HTMLElement);
    });
    await waitFor(() => expect(history.location.search).toBe("?tab=clips"));
    // The player is still mounted on another tab.
    expect(screen.getByTestId("player").getAttribute("data-live")).toBe("true");
    expect(mounts.player).toBe(1);
  });

  it("with no ready VODs or clips, Home shows the About content instead of a blank panel", async () => {
    const live = livePage();
    live.vods = { items: [vod(1, { status: "processing" })], nextCursor: null };
    live.clips = { items: [], nextCursor: null };
    renderPage(live);
    await waitFor(() => expect(tabs().getAttribute("data-tab")).toBe("home"));
    expect(screen.queryAllByTestId("channel-shelf")).toHaveLength(0);
    expect(screen.getByTestId("channel-about").textContent).toContain("I build villages.");
  });
});

function livePage(): ChannelPage {
  const live = page();
  live.summary.live = {
    id: uuid(50),
    title: "Live now",
    viewerCount: 40,
    catchingUpCount: 0,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    mature: false,
    restricted: null,
  };
  return live;
}

/** A theatre provider with a toggle (D2-player's `t` key and button stand in here). */
function TheatreHost({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theatre, setTheatre] = React.useState(false);
  return (
    <TheatreContext.Provider value={{ theatre, setTheatre }}>
      <button type="button" data-testid="toggle-theatre" onClick={() => setTheatre(!theatre)}>
        Theatre
      </button>
      {children}
    </TheatreContext.Provider>
  );
}

describe("the theatre layout", () => {
  const layout = () => screen.getByTestId("channel-page").getAttribute("data-layout");

  it("is theatre while live, and chat is sized for it", async () => {
    renderPage(livePage(), "/fern", neverClient, (node) => (
      <TheatreContext.Provider value={{ theatre: true, setTheatre: () => {} }}>{node}</TheatreContext.Provider>
    ));
    await waitFor(() => expect(layout()).toBe("theatre"));
    expect(screen.getByTestId("chat").className).toBe(chatColumnClass({ theatre: true, fill: true }));
  });

  it("stays default while offline, even with theatre on", async () => {
    renderPage(page(), "/fern", neverClient, (node) => (
      <TheatreContext.Provider value={{ theatre: true, setTheatre: () => {} }}>{node}</TheatreContext.Provider>
    ));
    await waitFor(() => expect(layout()).toBe("default"));
    expect(screen.getByTestId("chat").className).toBe(chatColumnClass({ theatre: false, fill: true }));
  });

  it("toggling it never remounts the player or chat (the stream and chat connection stay)", async () => {
    renderPage(livePage(), "/fern", neverClient, (node) => <TheatreHost>{node}</TheatreHost>);
    await waitFor(() => expect(layout()).toBe("default"));
    const player = screen.getByTestId("player");
    const chat = screen.getByTestId("chat");
    for (const expected of ["theatre", "default", "theatre"]) {
      act(() => {
        fireEvent.click(screen.getByTestId("toggle-theatre"));
      });
      await waitFor(() => expect(layout()).toBe(expected));
    }
    expect(screen.getByTestId("player")).toBe(player);
    expect(screen.getByTestId("chat")).toBe(chat);
    expect(mounts).toEqual({ player: 1, chat: 1 });
  });
});

describe("going offline", () => {
  it("asks for the VOD list again, so the broadcast that just ended becomes the hero", async () => {
    const live = livePage();
    // While live, the broadcast is still recording: the loaded list has only an older VOD.
    live.vods = { items: [vod(5)], nextCursor: null };
    const vods = vi.fn<MediaClient["vods"]>(async () => ({ items: [vod(1), vod(5)], nextCursor: null }));
    renderPage(live, "/fern", { ...neverClient, vods }, (node) => <TheatreHost>{node}</TheatreHost>);
    await waitFor(() => expect(screen.getByTestId("player").getAttribute("data-live")).toBe("true"));
    expect(vods).not.toHaveBeenCalled();

    polled.summary = { ...live.summary, live: null };
    // A theatre toggle re-renders the page, standing in for the next poll.
    act(() => {
      fireEvent.click(screen.getByTestId("toggle-theatre"));
    });
    await waitFor(() => expect(vods).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("channel-offline-hero").getAttribute("href")).toBe(`/fern/vods/${uuid(101)}`),
    );
  });
});

describe("the Clips tab's sort and range", () => {
  it("parseChannelSearch keeps sort and range on Clips only, dropping unknown values", () => {
    expect(parseChannelSearch({ tab: "clips", sort: "top", range: "30d" })).toEqual({
      tab: "clips",
      sort: "top",
      range: "30d",
    });
    expect(parseChannelSearch({ tab: "clips", sort: "recent", range: "all" })).toEqual({ tab: "clips" });
    expect(parseChannelSearch({ tab: "clips", sort: "hot", range: "90d" })).toEqual({ tab: "clips" });
    expect(parseChannelSearch({ tab: "videos", sort: "top", range: "7d" })).toEqual({ tab: "videos" });
    expect(parseChannelSearch({ sort: "top", range: "7d" })).toEqual({});
  });

  it("the default filter uses the loader's page; a range is in the URL and asks for its own first page", async () => {
    const clips = vi.fn<MediaClient["clips"]>(async (_channel, _cursor, filter) => ({
      items: filter?.range === "7d" ? [clip(3)] : [clip(4), clip(5)],
      nextCursor: null,
    }));
    const { router } = renderPage(page(), "/fern?tab=clips", { ...neverClient, clips });
    await waitFor(() => expect(screen.getAllByTestId("channel-video-card")).toHaveLength(1));
    expect(clips).not.toHaveBeenCalled();
    expect(screen.getByTestId("clip-range-all").getAttribute("aria-pressed")).toBe("true");

    act(() => {
      fireEvent.click(screen.getByTestId("clip-range-7d"));
    });
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "clips", range: "7d" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("channel-video-card").map((c) => c.getAttribute("data-id"))).toEqual([uuid(203)]),
    );
    expect(clips).toHaveBeenLastCalledWith("fern", undefined, { sort: "recent", range: "7d" });

    act(() => {
      fireEvent.click(screen.getByTestId("clip-sort-top"));
    });
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "clips", sort: "top", range: "7d" }));
    expect(clips).toHaveBeenLastCalledWith("fern", undefined, { sort: "top", range: "7d" });
    // Another tab drops the filter from the URL.
    clickTab("videos");
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "videos" }));
  });

  it("a deep link with a range asks for that range; nothing in it is the filtered empty state", async () => {
    const clips = vi.fn<MediaClient["clips"]>(async () => ({ items: [], nextCursor: null }));
    renderPage(page(), "/fern?tab=clips&range=30d", { ...neverClient, clips });
    expect(await screen.findByTestId("clips-filtered-empty")).toBeTruthy();
    expect(clips).toHaveBeenCalledWith("fern", undefined, { sort: "recent", range: "30d" });
    expect(screen.queryByTestId("channel-media-empty")).toBeNull();
  });

  it("top over all time with nothing is the channel's own empty state (sort alone never filters out)", async () => {
    const clips = vi.fn<MediaClient["clips"]>(async () => ({ items: [], nextCursor: null }));
    renderPage(page(), "/fern?tab=clips&sort=top", { ...neverClient, clips });
    expect(await screen.findByTestId("channel-media-empty")).toBeTruthy();
    expect(clips).toHaveBeenCalledWith("fern", undefined, { sort: "top", range: "all" });
    expect(screen.queryByTestId("clips-filtered-empty")).toBeNull();
  });
});

describe("the polled summary drives the header metadata", () => {
  it("a new category and tags from the poll replace the header's", async () => {
    const live = livePage();
    renderPage(live, "/fern", neverClient, (node) => <TheatreHost>{node}</TheatreHost>);
    const first = await screen.findAllByTestId("channel-meta-category");
    expect(first[0]?.textContent).toBe("Art");
    expect(screen.getAllByTestId("channel-meta-tag").map((a) => a.textContent)).toEqual(["cozy"]);

    polled.summary = {
      ...live.summary,
      category: { id: uuid(70), slug: "music", name: "Music" },
      tags: ["lofi", "beats"],
    };
    act(() => {
      fireEvent.click(screen.getByTestId("toggle-theatre"));
    });
    await waitFor(() => expect(screen.getAllByTestId("channel-meta-category")[0]?.textContent).toBe("Music"));
    expect(screen.getAllByTestId("channel-meta-category")[0]?.getAttribute("href")).toBe("/directory/music");
    expect(screen.getAllByTestId("channel-meta-tag").map((a) => a.textContent)).toEqual(["lofi", "beats"]);
  });
});
