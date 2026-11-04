// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D3-watch (F11): "More from <channel>" (`watch-more-grid`) under a VOD or clip: D2-channel's shelf
 * with VODs on a VOD page and clips on a clip page, never the item being watched, at most six,
 * with the shelf's link to the channel's Videos or Clips tab. Left out when there is nothing else
 * or the list fails.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ClipItem, MediaPage, VodItem } from "../src/components/channel/channel-data.ts";
import { vodTiles } from "../src/components/channel/video-grid.tsx";
import { MORE_FROM_SIZE, moreFrom } from "../src/components/watch/share.ts";
import { WatchMore } from "../src/components/watch/watch-more.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: React.ReactNode;
  }) => {
    const path = to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "");
    const query = search && Object.keys(search).length > 0 ? `?${new URLSearchParams(search)}` : "";
    return (
      <a href={`${path}${query}`} {...rest}>
        {children}
      </a>
    );
  },
}));

afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const byId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`);
const cards = (root: ParentNode) => [...root.querySelectorAll('[data-testid="channel-video-card"]')];

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const vodItem = (n: number, over: Partial<VodItem> = {}): VodItem => ({
  id: id(n),
  channelSlug: "rivertide",
  title: `Broadcast ${n}`,
  status: "ready",
  visibility: "public",
  durationSeconds: 600,
  thumbnailUrl: null,
  playlistUrl: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  expiresAt: null,
  failedReason: null,
  captions: [],
  ...over,
});
const clipItem = (n: number): ClipItem => ({
  id: id(n),
  channelSlug: "rivertide",
  title: `Clip ${n}`,
  creator: null,
  status: "ready",
  durationSeconds: 30,
  url: null,
  thumbnailUrl: null,
  views: n,
  createdAt: "2026-11-01T12:00:00.000Z",
  windowStartedAt: null,
});
const page = <T,>(items: T[]): MediaPage<T> => ({ items, nextCursor: null });

describe("moreFrom", () => {
  const tiles = vodTiles(Array.from({ length: 10 }, (_, i) => vodItem(i + 1)));

  it("drops the current item and keeps the API's order", () => {
    const got = moreFrom(tiles, id(2));
    expect(got.map((x) => x.id)).toEqual([1, 3, 4, 5, 6, 7].map(id));
  });

  it("caps at six", () => {
    expect(MORE_FROM_SIZE).toBe(6);
    expect(moreFrom(tiles, "none")).toHaveLength(6);
  });

  it("fewer than six: all of the others; only the current one: none; empty: none", () => {
    expect(moreFrom(tiles.slice(0, 3), id(1)).map((x) => x.id)).toEqual([id(2), id(3)]);
    expect(moreFrom(tiles.slice(0, 1), id(1))).toEqual([]);
    expect(moreFrom([], id(1))).toEqual([]);
  });

  it("a size of zero or less shows nothing", () => {
    expect(moreFrom(tiles, id(1), 0)).toEqual([]);
    expect(moreFrom(tiles, id(1), -3)).toEqual([]);
  });
});

describe("WatchMore", () => {
  it("a VOD page: six other ready VODs, without the current one, and View all to the Videos tab", async () => {
    const items = [
      vodItem(1),
      vodItem(2, { status: "processing" }),
      ...Array.from({ length: 8 }, (_, i) => vodItem(i + 3)),
    ];
    const { container } = wrap(
      <WatchMore
        kind="vod"
        slug="rivertide"
        channelName="Rivertide"
        currentId={id(1)}
        fetchPage={async () => page(items)}
      />,
    );
    await waitFor(() => expect(byId(container, "watch-more-grid")?.getAttribute("data-state")).toBe("ready"));
    const grid = byId(container, "watch-more-grid") as HTMLElement;
    expect(grid.getAttribute("data-kind")).toBe("vod");
    const shown = cards(grid).map((c) => c.getAttribute("data-id"));
    expect(shown).toHaveLength(6);
    expect(shown).not.toContain(id(1));
    expect(shown).not.toContain(id(2));
    expect(cards(grid).every((c) => c.getAttribute("data-kind") === "vods")).toBe(true);
    expect(grid.textContent).toContain(t("watch.more.heading", { name: "Rivertide" }));
    expect(byId(grid, "channel-shelf-view-all")?.getAttribute("href")).toBe("/rivertide?tab=videos");
    expect(cards(grid)[0]?.querySelector("a")?.getAttribute("href")).toBe(`/rivertide/vods/${id(3)}`);
  });

  it("a clip page: clips, and View all to the Clips tab", async () => {
    const { container } = wrap(
      <WatchMore
        kind="clip"
        slug="rivertide"
        channelName="Rivertide"
        currentId={id(2)}
        fetchPage={async () => page([clipItem(1), clipItem(2), clipItem(3)])}
      />,
    );
    await waitFor(() => expect(byId(container, "watch-more-grid")?.getAttribute("data-state")).toBe("ready"));
    const grid = byId(container, "watch-more-grid") as HTMLElement;
    expect(cards(grid).map((c) => c.getAttribute("data-id"))).toEqual([id(1), id(3)]);
    expect(cards(grid).every((c) => c.getAttribute("data-kind") === "clips")).toBe(true);
    expect(byId(grid, "channel-shelf-view-all")?.getAttribute("href")).toBe("/rivertide?tab=clips");
  });

  it("shows loading frames first", () => {
    const { container } = wrap(
      <WatchMore
        kind="vod"
        slug="rivertide"
        channelName="Rivertide"
        currentId={id(1)}
        fetchPage={() => new Promise(() => undefined)}
      />,
    );
    expect(byId(container, "watch-more-grid")?.getAttribute("data-state")).toBe("loading");
  });

  it("only the current item: the section is left out", async () => {
    const fetchPage = vi.fn<() => Promise<MediaPage<VodItem>>>(async () => page([vodItem(1)]));
    const { container } = wrap(
      <WatchMore kind="vod" slug="rivertide" channelName="Rivertide" currentId={id(1)} fetchPage={fetchPage} />,
    );
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    await waitFor(() => expect(byId(container, "watch-more-grid")).toBeNull());
  });

  it("a failed list: the section is left out", async () => {
    const fetchPage = vi.fn<() => Promise<MediaPage<VodItem>>>(async () => {
      throw new Error("network");
    });
    const { container } = wrap(
      <WatchMore kind="vod" slug="rivertide" channelName="Rivertide" currentId={id(1)} fetchPage={fetchPage} />,
    );
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    await waitFor(() => expect(byId(container, "watch-more-grid")).toBeNull());
  });
});
