// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-channel (F2) and D3.8: an offline channel is a content page (`channel-offline-home`). The
 * banner is on top, then "Last live <time> · <category>", then the Follow hero with the latest
 * playable VOD (a poster linking to its watch page, `channel-offline-hero`), the other videos and
 * About. With no playable VOD the hero says when they were last live, or that they never were. A
 * suspended channel keeps the player's offline card. "Last live" is `Channel.lastLiveAt` (polled
 * with the summary), with or without a VOD. Going live swaps the content page for the player,
 * which carries the viewer's Clip button.
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
import { cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

// The page renders through the router and its loader; on a busy CI runner the first paint can
// take longer than testing-library's 1 s default.
configure({ asyncUtilTimeout: 5_000 });

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, config: { publicUrl: "https://air.example.test" }, now: Date.now() }),
}));
vi.mock("../src/lib/use-channel.ts", () => ({ useChannel: (_slug: string, initial: unknown) => initial }));
vi.mock("../src/player/player.tsx", () => ({
  Player: ({ live, offline, clip }: { live: boolean; offline?: React.ReactNode; clip?: { signedIn: boolean } }) => (
    <div data-testid="player" data-live={String(live)}>
      {live ? null : offline}
      {live && clip ? (
        <button type="button" aria-label="Clip" data-testid="clip-button" data-signed-in={String(clip.signedIn)} />
      ) : null}
    </div>
  ),
}));
vi.mock("../src/chat/chat-panel.tsx", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("../src/components/support/support-dialog.tsx", () => ({ SupportButton: () => null }));

const { Route } = await import("../src/routes/_app/$channel.tsx");
const { playableVods } = await import("../src/components/channel/channel-data.ts");
const { OfflineHero } = await import("../src/components/channel/offline-hero.tsx");
const { vodTile } = await import("../src/components/channel/video-grid.tsx");
type ChannelPage = import("../src/components/channel/panels-loader.ts").ChannelPage;
type Vod = import("../src/components/channel/channel-data.ts").VodItem;

afterEach(cleanup);

const uuid = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const BANNER = "https://media.example.test/channels/c1/banner/b.png";

function vod(n: number, over: Partial<Vod> = {}): Vod {
  return {
    id: uuid(100 + n),
    channelSlug: "fern",
    title: `Stream ${n}`,
    status: "ready",
    visibility: "public",
    durationSeconds: 3600,
    thumbnailUrl: `https://media.example.test/vods/${n}.jpg`,
    playlistUrl: null,
    createdAt: new Date(Date.UTC(2026, 9, 30 - n, 18)).toISOString(),
    expiresAt: null,
    failedReason: null,
    captions: [],
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
      tags: [],
      lastLiveAt: "2026-10-29T19:00:00.000Z",
      followerCount: 3,
      following: null,
      portabilityGrant: null,
      movedTo: null,
    },
    extras: {
      bannerUrl: BANNER,
      panels: [{ id: uuid(7), title: "Schedule", body: "Evenings", imageUrl: null, linkUrl: null }],
      suspended: false,
    },
    about: { bio: "I build villages.", socials: [] },
    vods: { items: [vod(1), vod(2), vod(3)], nextCursor: null },
    clips: { items: [], nextCursor: null },
    ...over,
  };
}

function renderPage(data: ChannelPage) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const app = createRoute({ getParentRoute: () => root, id: "_app", component: () => <Outlet /> });
  const channel = createRoute({
    getParentRoute: () => app,
    path: "$channel",
    loader: () => data,
    component: Route.options.component as never,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([channel])]),
    history: createMemoryHistory({ initialEntries: ["/fern"] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

describe("playableVods", () => {
  it("playableVods keeps ready ones only, in order", () => {
    const out = playableVods([vod(1), vod(2, { status: "recording" }), vod(3), vod(4, { status: "processing" })]);
    expect(out.map((v) => v.id)).toEqual([uuid(101), uuid(103)]);
  });
});

describe("the offline page with VODs", () => {
  it("banner on top, last live with the category, the latest VOD as the hero, then the rest", async () => {
    const { container } = renderPage(page());
    const home = await screen.findByTestId("channel-offline-home");
    const hero = screen.getByTestId("channel-offline-hero");
    expect(home.contains(hero)).toBe(true);
    expect(hero.getAttribute("data-vod")).toBe(uuid(101));
    expect([hero.tagName, hero.getAttribute("href")]).toEqual(["A", `/fern/vods/${uuid(101)}`]);
    expect(hero.textContent).toContain("Latest video");
    expect(screen.getByTestId("channel-offline-latest-meta").textContent).toContain("Stream 1");
    expect(hero.querySelector("img")?.getAttribute("src")).toBe("https://media.example.test/vods/1.jpg");
    // The content page replaces the offline card: no player, and the old standalone hero is gone.
    expect(screen.queryByTestId("player")).toBeNull();
    expect(container.querySelector('section[data-testid="channel-offline-hero"]')).toBeNull();

    const last = screen.getByTestId("channel-last-live");
    expect(last.textContent).toMatch(/^Last live /);
    expect(last.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-29T19:00:00.000Z");
    expect(last.querySelector('[data-testid="channel-meta-category"]')?.getAttribute("href")).toBe("/directory/art");

    // Banner first in the main column, above the header.
    const banner = screen.getByTestId("channel-banner");
    const header = container.querySelector("section h1");
    expect(banner.compareDocumentPosition(header as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();

    // No clips: only the Videos shelf, with the rest of the VODs.
    const shelf = screen.getByTestId("channel-shelf");
    expect(shelf.textContent).toContain("More videos");
    const shelfIds = [...shelf.querySelectorAll('[data-testid="channel-video-card"]')].map((c) =>
      c.getAttribute("data-id"),
    );
    expect(shelfIds).toEqual([uuid(102), uuid(103)]);
  });

  it("a VOD that is not ready is no hero: the Follow hero says when they were last live", async () => {
    renderPage(page({ vods: { items: [vod(1, { status: "processing" })], nextCursor: null } }));
    const follow = await screen.findByTestId("channel-offline-follow-hero");
    expect(follow.getAttribute("data-state")).toBe("lastLive");
    expect(screen.queryByTestId("channel-offline-hero")).toBeNull();
    expect(screen.queryByTestId("offline-state")).toBeNull();
    // Still "last live": the broadcast happened.
    expect(screen.getByTestId("channel-last-live")).toBeTruthy();
  });

  it("going live swaps the hero for the player", async () => {
    const live = page();
    live.summary.live = {
      id: uuid(50),
      title: "Back again",
      viewerCount: 9,
      catchingUpCount: 0,
      startedAt: new Date().toISOString(),
      mature: false,
      restricted: null,
    };
    renderPage(live);
    await waitFor(() => expect(screen.getByTestId("player").getAttribute("data-live")).toBe("true"));
    // Live viewers get the Clip button (D3.7), signed out too (it opens the sign-up prompt).
    expect(screen.getByTestId("clip-button").getAttribute("data-signed-in")).toBe("false");
    expect(screen.queryByTestId("channel-offline-home")).toBeNull();
    expect(screen.queryByTestId("channel-offline-hero")).toBeNull();
    expect(screen.queryByTestId("channel-last-live")).toBeNull();
    // Live, the banner sits in About so the player comes first.
    expect(screen.queryByTestId("channel-banner")).toBeNull();
  });
});

describe("the offline page with no VODs", () => {
  it("never live: the Follow hero says so, then the About content", async () => {
    const never = page({ vods: { items: [], nextCursor: null } });
    never.summary.lastLiveAt = null;
    renderPage(never);
    const follow = await screen.findByTestId("channel-offline-follow-hero");
    expect(follow.getAttribute("data-state")).toBe("never");
    expect(follow.textContent).toContain("Fernsby is offline");
    expect(screen.queryByTestId("offline-state")).toBeNull();
    expect(screen.queryByTestId("channel-offline-hero")).toBeNull();
    expect(screen.queryByTestId("channel-last-live")).toBeNull();
    const about = screen.getByTestId("channel-about");
    expect(about.textContent).toContain("About Fernsby");
    expect(about.textContent).toContain("I build villages.");
    expect(about.querySelector('[data-testid="channel-panels"]')).toBeTruthy();
    // The banner heads the page once, not again inside About.
    expect(screen.getAllByTestId("channel-banner")).toHaveLength(1);
  });

  it("Last live comes from the channel, not the VOD list: it shows with no VOD left", async () => {
    renderPage(page({ vods: { items: [], nextCursor: null } }));
    const last = await screen.findByTestId("channel-last-live");
    expect(last.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-29T19:00:00.000Z");
    expect(screen.queryByTestId("channel-offline-hero")).toBeNull();
  });

  it("with no bio, About says so instead of a blank card", async () => {
    renderPage(page({ vods: { items: [], nextCursor: null }, about: { bio: "", socials: [] } }));
    expect((await screen.findByTestId("channel-about-bio-empty")).textContent).toBe(
      "Fernsby has not written a bio yet.",
    );
  });

  it("a suspended channel shows no banner and no panels", async () => {
    renderPage(
      page({
        vods: { items: [], nextCursor: null },
        extras: { ...page().extras, suspended: true },
      }),
    );
    await screen.findByTestId("channel-about");
    expect(screen.queryByTestId("channel-banner")).toBeNull();
    expect(screen.queryByTestId("channel-panels")).toBeNull();
    // Suspended keeps the player's offline card, not the content page.
    expect(screen.getByTestId("offline-state")).toBeTruthy();
    expect(screen.queryByTestId("channel-offline-home")).toBeNull();
  });

  it("About states when the channel was created when the page has it", async () => {
    renderPage(page({ since: "2025-03-01T12:00:00.000Z" }));
    const since = await screen.findByTestId("channel-about-since");
    expect(since.querySelector("time")?.getAttribute("datetime")).toBe("2025-03-01T12:00:00.000Z");
  });

  it("About leaves the created date out when the page has none", async () => {
    renderPage(page());
    await screen.findByTestId("channel-about");
    expect(screen.queryByTestId("channel-about-since")).toBeNull();
  });
});

describe("OfflineHero", () => {
  it("is one link with the poster, length and title; an untitled VOD gets a name", () => {
    const root = createRootRoute({
      component: () => <OfflineHero tile={vodTile(vod(4, { title: "  ", thumbnailUrl: null }))} />,
    });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <RouterProvider router={router} />
      </LocaleProvider>,
    );
    return waitFor(() => {
      const hero = screen.getByTestId("channel-offline-hero");
      expect(hero.querySelectorAll("a")).toHaveLength(1);
      expect(hero.querySelector("img")).toBeNull();
      expect(hero.textContent).toContain("Untitled video");
      expect(hero.textContent).toContain("1:00:00");
      expect(hero.getAttribute("aria-labelledby")).toBe(hero.querySelector("h2")?.id);
    });
  });
});
