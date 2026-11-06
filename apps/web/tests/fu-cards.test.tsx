// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Card link slots (follow-up to D1): a live card's category and tags, and an offline tile's
 * category, are links inside the card (no `CardLinks` row under it), never nested in the card's
 * channel link, and reached by Tab after it. The category page lists its tags as links.
 */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ART, MUSIC, boot, category, home, live, offline, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    categories: { list: async () => ({ items: [], nextCursor: null }) },
    directory: { live: async () => ({ items: [], nextCursor: null }) },
  }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const { DiscoveryStreamCard, DiscoveryStreamGrid } = await import("../src/components/discovery/stream-cards.tsx");
const { CategoryNotFound, CategoryPage } = await import("../src/components/discovery/category-page.tsx");
const { Directory } = await import("../src/components/directory.tsx");
const { homeLayout } = await import("../src/lib/directory-sections.ts");

beforeEach(() => {
  fake.boot = boot();
});
afterEach(cleanup);

const hrefs = (root: ParentNode) => [...root.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("live card link slots", () => {
  it("the category and tags are links inside the card, after the channel link, none nested", async () => {
    await renderInRouter(
      <DiscoveryStreamCard card={live("fern", { category: ART, tags: ["cozy", "chill", "en", "late"] })} />,
      "/directory",
    );
    const card = screen.getByTestId("stream-card");
    expect(card.getAttribute("data-channel")).toBe("fern");
    expect(document.querySelector('[data-slot="card-links"]')).toBeNull();
    expect(card.querySelector("a a")).toBeNull();
    // Three tags at most, as before.
    expect(hrefs(card)).toEqual([
      "/fern",
      "/directory/art",
      "/directory?tag=cozy",
      "/directory?tag=chill",
      "/directory?tag=en",
    ]);
    const category = card.querySelector('[data-testid="card-category-link"]');
    expect(category?.getAttribute("data-slot")).toBe("stream-card-category-link");
    expect(category?.textContent).toBe("Art");
    const tags = card.querySelectorAll('[data-testid="card-tag-link"]');
    expect(tags).toHaveLength(3);
    expect(tags[0]?.getAttribute("aria-label")).toBe("Live channels tagged cozy");
    // The category shows once (no plain-text copy beside the link).
    expect(card.textContent?.match(/Art/g)).toHaveLength(1);
    // Tab order is document order: nothing reorders it with a positive tabindex.
    expect([...card.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0)).toEqual(
      [],
    );
  });

  it("no category, no tags: only the channel link", async () => {
    await renderInRouter(<DiscoveryStreamCard card={live("fern", { category: null, tags: [] })} />, "/directory");
    expect(hrefs(screen.getByTestId("stream-card"))).toEqual(["/fern"]);
  });
});

describe("offline tile category slot", () => {
  it("the category link sits in the tile, beside (not inside) the channel-card link", async () => {
    const layout = homeLayout(
      home({ recentlyLive: [offline("napper", "2026-11-03T00:00:00.000Z", { category: MUSIC })] }),
      false,
    );
    await renderInRouter(
      <Directory
        sections={layout.sections}
        hero={layout.hero}
        categoryShelves={[]}
        offline={layout.offline}
        categories={[]}
      />,
    );
    const tile = screen.getByTestId("home-recent-tile");
    expect(tile.className).toContain("relative");
    const channel = tile.querySelector('[data-testid="channel-card"]') as HTMLElement;
    expect(channel.getAttribute("href")).toBe("/napper");
    expect(channel.className).toContain("after:inset-0");
    const link = tile.querySelector('[data-testid="card-category-link"]') as HTMLElement;
    expect(link.getAttribute("href")).toBe("/directory/music");
    expect(link.className).toContain("z-10");
    expect(channel.contains(link)).toBe(false);
    expect(tile.querySelector("a a")).toBeNull();
  });
});

describe("the category page header", () => {
  it("lists its live channels' tags as tag-filter links", async () => {
    await renderInRouter(
      <CategoryPage
        category={category(ART, 2)}
        live={{
          items: [live("a1", { category: ART, tags: ["cozy"] }), live("a2", { category: ART, tags: ["pixel"] })],
          nextCursor: null,
        }}
      />,
      "/directory/art",
    );
    const list = screen.getByRole("list", { name: "Tags on live channels" });
    const links = [...list.querySelectorAll('[data-testid="card-tag-link"]')];
    expect(links.map((a) => a.getAttribute("href") ?? "").sort((x, y) => x.localeCompare(y))).toEqual([
      "/directory?tag=cozy",
      "/directory?tag=pixel",
    ]);
    expect(links.map((a) => a.textContent ?? "").sort((x, y) => x.localeCompare(y))).toEqual(["#cozy", "#pixel"]);
  });
});

describe("the discovery grid", () => {
  it("shows loadingCount skeletons and no cards while loading", async () => {
    const { container } = await renderInRouter(
      <DiscoveryStreamGrid cards={[live("fern")]} loading loadingCount={4} />,
      "/directory",
    );
    expect(container.querySelectorAll('[data-slot="stream-card-skeleton"]')).toHaveLength(4);
    expect(screen.queryByTestId("stream-card")).toBeNull();
  });

  it("loads the first `eager` thumbnails eagerly and the rest lazily; dense adds a column", async () => {
    // happy-dom reports every <img> as complete with no size, which the card reads as broken.
    const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    const withThumb = (slug: string) => {
      const card = live(slug);
      return { ...card, broadcast: { ...card.broadcast, thumbnailUrl: `/thumbs/${slug}.webp` } };
    };
    const { container } = await renderInRouter(
      <DiscoveryStreamGrid cards={[withThumb("a"), withThumb("b"), withThumb("c")]} eager={1} dense />,
      "/directory",
    );
    expect([...container.querySelectorAll("img[src^='/thumbs']")].map((img) => img.getAttribute("loading"))).toEqual([
      "eager",
      "lazy",
      "lazy",
    ]);
    expect((container.querySelector(".grid") as HTMLElement).className).toContain("2xl:grid-cols-4");
    complete.mockRestore();
  });
});

describe("an unknown category", () => {
  it("shows the not-found state", async () => {
    await renderInRouter(<CategoryNotFound />, "/directory");
    expect(screen.getByTestId("category-not-found").textContent).toContain("This category does not exist");
  });
});
