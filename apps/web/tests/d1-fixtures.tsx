// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared fixtures for the D1-web tests (d1-*.test.ts[x]): DTOs, the bootstrap, and a router to render in. */
import type { Category, ChannelCard, StreamCard } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type * as React from "react";
import type { Bootstrap } from "../src/lib/bootstrap-types.ts";
import type { DirectoryHome } from "../src/lib/directory-sections.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

export function live(
  slug: string,
  over: {
    viewers?: number;
    category?: { id: string; slug: string; name: string } | null;
    tags?: string[];
    name?: string;
    reason?: StreamCard["reason"];
  } = {},
): StreamCard {
  return {
    channel: { id: `id-${slug}`, slug, displayName: over.name ?? slug, avatarUrl: null, accent: "zinc" },
    broadcast: {
      id: `b-${slug}`,
      title: `${slug} live`,
      category: over.category === undefined ? null : over.category,
      startedAt: "2026-11-01T12:00:00.000Z",
      mature: false,
      viewerCount: over.viewers ?? 1,
      thumbnailUrl: null,
    },
    tags: over.tags ?? [],
    language: "en",
    reason: over.reason ?? "popular",
  };
}

export function offline(
  slug: string,
  lastLiveAt: string | null = "2026-11-01T12:00:00.000Z",
  over: { name?: string; category?: ChannelCard["category"]; latestVod?: ChannelCard["latestVod"] } = {},
): ChannelCard {
  return {
    channel: { id: `id-${slug}`, slug, displayName: over.name ?? slug, avatarUrl: null, accent: "zinc" },
    title: `${slug} last show`,
    category: over.category ?? null,
    lastLiveAt,
    followerCount: 0,
    mature: false,
    latestVod: over.latestVod ?? null,
  };
}

export const ART = { id: "cat-art", slug: "art", name: "Art" };
export const MUSIC = { id: "cat-music", slug: "music", name: "Music" };
export const GAMES = { id: "cat-games", slug: "games", name: "Games" };

export function category(
  ref: { id: string; slug: string; name: string },
  liveChannels: number,
  over: Partial<Pick<Category, "viewerCount" | "tags">> = {},
): Category {
  return { ...ref, boxArtUrl: null, mature: false, liveChannels, viewerCount: 0, tags: [], videoCount: 0, ...over };
}

export function home(over: Partial<DirectoryHome> = {}): DirectoryHome {
  return {
    spotlight: [],
    newAndLive: [],
    live: [],
    following: [],
    recentlyLive: [],
    followingOffline: [],
    ...over,
  };
}

export function boot(over: Partial<Bootstrap> = {}): Bootstrap {
  return {
    config: {} as Bootstrap["config"],
    instance: { name: "Test Air", sourceUrl: null, p2pDefault: "off", chatSafety: false },
    me: null,
    theme: "dark",
    now: Date.parse("2026-11-04T12:00:00.000Z"),
    locale: "en",
    dir: "ltr",
    localeFromUser: false,
    consent: null,
    ...over,
  };
}

export const MEMBER: NonNullable<Bootstrap["me"]> = {
  id: "u1",
  username: "viewer1",
  displayName: "Viewer One",
  channelSlug: null,
  role: "user",
};

/**
 * Renders `node` as the page at `path`, inside a router that knows the discovery routes (so links
 * and `navigate` resolve), with the locale and tooltip providers. Returns the router too.
 */
export async function renderInRouter(node: React.ReactNode, path = "/") {
  const root = createRootRoute({
    component: () => (
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </LocaleProvider>
    ),
  });
  const page = () => <>{node}</>;
  const routes = ["/", "/directory", "/directory/$category", "/search", "/signin", "/signup", "/$channel"].map((p) =>
    createRoute({ getParentRoute: () => root, path: p, component: page }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const result = render(<RouterProvider router={router} />);
  return { ...result, router };
}
