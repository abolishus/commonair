// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fixtures for the d3-home tests: video and clip cards, and a router that knows home's links. */
import type { ClipCard, VodCard } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type * as React from "react";
import { locale, uiMessages } from "../src/i18n/index.ts";

const channel = (slug: string) => ({
  id: `id-${slug}`,
  slug,
  displayName: slug,
  avatarUrl: null,
  accent: "zinc" as const,
});

export function video(id: string, slug = "aurora"): VodCard {
  return {
    id,
    channelSlug: slug,
    title: `${id} title`,
    status: "ready",
    visibility: "public",
    durationSeconds: 3_725,
    thumbnailUrl: null,
    playlistUrl: null,
    createdAt: "2026-11-01T12:00:00.000Z",
    expiresAt: null,
    failedReason: null,
    category: null,
    captions: [],
    channel: channel(slug),
  };
}

export function clip(id: string, slug = "aurora"): ClipCard {
  return {
    id,
    channelSlug: slug,
    title: `${id} clip`,
    creator: { id: "u9", username: "clipper", displayName: "Clipper" },
    status: "ready",
    durationSeconds: 30,
    url: null,
    thumbnailUrl: null,
    views: 1_234,
    createdAt: "2026-11-01T12:00:00.000Z",
    windowStartedAt: null,
    category: null,
    vodId: null,
    vodOffsetSeconds: null,
    channel: channel(slug),
  };
}

export const ok = <T,>(data: T) => ({ status: "ok" as const, data });
export const failed = { status: "failed" as const, retryAfterSeconds: null };

const PATHS = [
  "/",
  "/directory",
  "/directory/$category",
  "/transparency",
  "/coop",
  "/dashboard",
  "/signin",
  "/following",
  "/$channel",
  "/$channel/vods/$vodId",
  "/$channel/clips/$clipId",
];

/** Renders `node` at `path` in a router with home's link targets, the locale and tooltips. */
export async function renderHome(node: React.ReactNode, path = "/") {
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
  const routes = PATHS.map((p) => createRoute({ getParentRoute: () => root, path: p, component: page }));
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const result = render(<RouterProvider router={router} />);
  return { ...result, router };
}
