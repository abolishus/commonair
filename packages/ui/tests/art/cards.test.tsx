// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D1 card set: StreamCard size="feature", the reason meta line, MediaCard kind="vod"|"clip",
 * ChannelChip, the auto-fill CardGrid, CategoryTile's muted 0-live state, EmptyState v2 and the
 * layout-mirroring skeletons.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react";
import type * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { InboxIcon } from "@hugeicons/core-free-icons";
import {
  CategoryTileSkeleton,
  ChannelChip,
  ChannelChipRow,
  ChannelChipSkeleton,
  EmptyState,
  LocaleProvider,
  MAX_CARD_TAGS,
  MediaCardSkeleton,
  Skeleton,
  SkeletonGroup,
  SkeletonText,
  StreamCard,
  StreamCardSkeleton,
} from "../../src/index.ts";
import {
  CardGrid,
  CategoryGrid,
  CategoryTile,
  MediaCard,
  MediaGrid,
  StreamGrid,
} from "../../src/blocks/media/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const stream: StreamCardData = {
  channel: { id: "c1", slug: "aurora", displayName: "Aurora Pixel", avatarUrl: null, accent: "violet" },
  broadcast: {
    id: "b1",
    title: "Painting a whole city skyline in one sitting",
    category: { id: "g1", slug: "art", name: "Art" },
    startedAt: "2026-11-06T10:00:00Z",
    mature: false,
    viewerCount: 1_234,
    thumbnailUrl: "https://media.invalid/t.webp",
  },
  tags: ["watercolour", "chill", "english", "cozy", "late"],
  language: "en",
  reason: "popular",
};

/** happy-dom reports every <img> as complete with no size; real browsers report "still loading". */
function imagesStillLoading(): void {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
}

function RouterLink({ children, ...props }: React.ComponentProps<"a">) {
  return (
    <a data-router="yes" {...props}>
      {children}
    </a>
  );
}

describe("StreamCard (default)", () => {
  test("the reason is a quiet meta line, not a chip", () => {
    render(<StreamCard stream={stream} href="/aurora" />);
    const reason = screen.getByText("Popular");
    expect(reason.tagName).toBe("P");
    expect(reason.getAttribute("data-slot")).toBe("stream-card-reason");
    expect(reason.getAttribute("data-reason")).toBe("popular");
    expect(reason.className).toContain("text-xs");
    expect(reason.className).toContain("text-muted-foreground");
    expect(reason.closest("ul")).toBeNull();
  });

  test("at most three tags, chips at least 24 px tall", () => {
    const { container } = render(<StreamCard stream={stream} href="/aurora" maxTags={10} />);
    expect(MAX_CARD_TAGS).toBe(3);
    const chips = container.querySelectorAll('[data-slot="stream-card-tag"]');
    expect([...chips].map((c) => c.textContent)).toEqual(["watercolour", "chill", "english"]);
    for (const chip of chips) expect(chip.className).toContain("min-h-6");
  });

  test("tag links are chips too, above the stretched link", () => {
    const { container } = render(
      <StreamCard stream={stream} href="/aurora" tagLink={(tag) => ({ href: `/directory?tag=${tag}` })} />,
    );
    const links = container.querySelectorAll('[data-slot="stream-card-tag-link"]');
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.className).toContain("min-h-6");
      expect(link.className).toContain("z-10");
    }
  });

  test("viewer counts are 12 px tabular figures", () => {
    const { container } = render(<StreamCard stream={stream} href="/aurora" />);
    const count = container.querySelector('[data-slot="viewer-count"]')!;
    expect(count.className).toContain("text-xs");
    expect(count.className).toContain("tabular-nums");
  });

  test("channel and category share one meta line", () => {
    render(<StreamCard stream={stream} href="/aurora" />);
    const line = screen.getByText("Aurora Pixel").closest("p")!;
    expect(within(line).getByText("Art")).toBeTruthy();
    expect(line.className).toContain("text-xs");
  });

  test("no thumbnail: the MediaFallback with the centred avatar, not a grey tile", () => {
    const { container } = render(
      <StreamCard stream={{ ...stream, broadcast: { ...stream.broadcast, thumbnailUrl: null } }} href="/aurora" />,
    );
    const fallback = container.querySelector('[data-slot="media-fallback"]')!;
    expect(fallback.getAttribute("data-kind")).toBe("nothumb");
    expect(fallback.getAttribute("data-accent")).toBe("violet");
    expect(fallback.querySelector('[data-slot="avatar"]')).toBeTruthy();
  });

  test("hover motion is opt-in: the thumbnail only scales under motion-safe", () => {
    imagesStillLoading();
    const { container } = render(<StreamCard stream={stream} href="/aurora" />);
    const img = container.querySelector("img")!;
    expect(img.className).toContain("motion-safe:group-hover/stream-card:scale-102");
    expect(img.className.split(" ").some((c) => c.startsWith("group-hover") && c.includes("scale"))).toBe(false);
  });

  test("one primary link; size defaults to default", () => {
    const { container } = render(<StreamCard stream={stream} href="/aurora" />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(container.querySelector("article")!.getAttribute("data-size")).toBe("default");
    expect(container.querySelector('[data-slot="stream-card-play"]')).toBeNull();
  });
});

describe("StreamCard size=feature", () => {
  const feature = (props: Partial<React.ComponentProps<typeof StreamCard>> = {}) =>
    render(<StreamCard stream={stream} href="/aurora" size="feature" ctaLabel="Watch now" {...props} />);

  test("62/38 at 768 px and up, stacked below", () => {
    imagesStillLoading();
    const { container } = feature();
    const card = container.querySelector("article")!;
    expect(card.getAttribute("data-size")).toBe("feature");
    expect(card.className).toContain("flex-col");
    expect(card.className).toContain("md:flex-row");
    expect(card.className).toContain("bg-card");
    const media = container.querySelector('[data-slot="stream-card-media"]')!;
    expect(media.className).toContain("md:w-31/50");
    expect(media.className).toContain("aspect-video");
  });

  test("a poster with a Play affordance; never a player, never autoplay", () => {
    imagesStillLoading();
    const { container } = feature();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("[autoplay]")).toBeNull();
    const play = container.querySelector('[data-slot="stream-card-play"]')!;
    expect(play.getAttribute("aria-hidden")).toBe("true");
    expect(play.querySelector("svg")).toBeTruthy();
    // Above the fold: the poster loads eagerly unless asked otherwise.
    expect(container.querySelector("img")!.getAttribute("loading")).toBe("eager");
  });

  test("one stretched link: the call to action only looks like a button", () => {
    feature();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("/aurora");
    expect(links[0]!.className).toContain("after:inset-0");
    const cta = screen.getByText("Watch now");
    expect(cta.getAttribute("aria-hidden")).toBe("true");
    expect(cta.closest("a")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("the title is a heading, the avatar has the live ring, the reason a meta line", () => {
    imagesStillLoading();
    const { container } = feature({ headingLevel: 2 });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(stream.broadcast.title);
    expect(container.querySelector('[data-slot="avatar"]')!.getAttribute("data-live")).toBe("true");
    expect(screen.getByText("Popular").tagName).toBe("P");
  });

  test("slot links still work at feature size, none nested", () => {
    const { container } = feature({
      channelLink: { href: "/aurora/about" },
      categoryLink: { href: "/directory/art", render: <RouterLink /> },
    });
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/aurora/about",
      "/directory/art",
      "/aurora",
    ]);
    expect(container.querySelector("a a")).toBeNull();
  });

  test("no CTA label, no CTA", () => {
    const { container } = render(<StreamCard stream={stream} href="/aurora" size="feature" />);
    expect(container.querySelector('[data-slot="stream-card-cta"]')).toBeNull();
  });

  test("its skeleton has the same split", () => {
    const { container } = render(<StreamCardSkeleton size="feature" />);
    const skeleton = container.querySelector('[data-slot="stream-card-skeleton"]')!;
    expect(skeleton.getAttribute("data-size")).toBe("feature");
    expect(skeleton.className).toContain("md:flex-row");
    expect(skeleton.querySelector('[data-slot="skeleton-thumbnail"]')!.className).toContain("md:w-31/50");
  });
});

describe("ChannelChip", () => {
  test("avatar, name and one meta line; the name is the one stretched link", () => {
    const { container } = render(
      <ChannelChip name="Mika Draws" href="/mika" accent="pink" meta="Art · 3 hours ago" data-testid="chip" />,
    );
    const chip = screen.getByTestId("chip");
    expect(chip.tagName).toBe("ARTICLE");
    expect(chip.getAttribute("data-accent")).toBe("pink");
    expect(chip.className).toContain("min-h-11");
    const link = screen.getByRole("link", { name: "Mika Draws" });
    expect(link.getAttribute("href")).toBe("/mika");
    expect(link.className).toContain("after:inset-0");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Art · 3 hours ago")).toBeTruthy();
    expect(container.querySelector('[data-slot="avatar"]')!.getAttribute("aria-hidden")).toBe("true");
  });

  test("renders through a router link, zinc without an accent, no meta line when empty", () => {
    const { container } = render(<ChannelChip name="Ferro" href="/ferro" render={<RouterLink />} />);
    expect(screen.getByRole("link").getAttribute("data-router")).toBe("yes");
    expect(container.querySelector("article")!.getAttribute("data-accent")).toBe("zinc");
    expect(container.querySelector("article .text-muted-foreground")).toBeNull();
  });

  test("a row wraps each chip in a list item; it scrolls below 768 px and wraps above", () => {
    const { container } = render(
      <ChannelChipRow aria-label="Recently live">
        <ChannelChip key="a" name="A" href="/a" />
        <ChannelChip key="b" name="B" href="/b" />
        {null}
      </ChannelChipRow>,
    );
    const list = screen.getByRole("list", { name: "Recently live" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).toContain("md:flex-wrap");
    expect(container.querySelectorAll("li > article")).toHaveLength(2);
  });

  test("its skeleton is the same 44 px row", () => {
    const { container } = render(<ChannelChipSkeleton />);
    const skeleton = container.querySelector('[data-slot="channel-chip-skeleton"]')!;
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton.className).toContain("min-h-11");
  });
});

const vod = {
  id: "v1",
  title: "Blind run, part 3: the ice level",
  channelName: "Quarter Pixel",
  accent: "pink",
  duration: "2:14:08",
  ago: "Yesterday",
  views: "312 views",
  kind: "Video",
};

describe("MediaCard", () => {
  test("vod: avatar, title as the one stretched link, meta line, 12 px duration", () => {
    const { container } = render(<MediaCard media={vod} href="/videos/v1" kind="vod" />);
    const card = container.querySelector("article")!;
    expect(card.getAttribute("data-kind")).toBe("vod");
    expect(card.getAttribute("data-accent")).toBe("pink");
    const link = screen.getByRole("link");
    expect(link.textContent).toBe(vod.title);
    expect(link.className).toContain("after:inset-0");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(container.querySelector('[data-slot="avatar"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="media-card-meta"]')!.textContent).toBe(
      "Quarter Pixel · Yesterday · 312 views",
    );
    const duration = container.querySelector('[data-slot="media-card-duration"]')!;
    expect(duration.textContent).toBe("2:14:08");
    expect(duration.className).toContain("text-xs");
    expect(duration.className).toContain("tabular-nums");
    expect(container.querySelector('[data-slot="media-card-kind"]')!.textContent).toBe("Video");
  });

  test("clip: no avatar; the clipper, then the age", () => {
    const clip = { ...vod, id: "c1", kind: "Clip", duration: "0:28", clippedBy: "Clipped by Rosa" };
    const { container } = render(<MediaCard media={clip} href="/clips/c1" kind="clip" />);
    expect(container.querySelector("article")!.getAttribute("data-kind")).toBe("clip");
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(container.querySelector('[data-slot="media-card-meta"]')!.textContent).toBe(
      "Quarter Pixel · Clipped by Rosa · Yesterday",
    );
  });

  test("the legacy variant still picks the kind; kind wins over it", () => {
    const { container, rerender } = render(<MediaCard media={vod} variant="clip" />);
    expect(container.querySelector("article")!.getAttribute("data-kind")).toBe("clip");
    rerender(<MediaCard media={vod} variant="clip" kind="vod" />);
    expect(container.querySelector("article")!.getAttribute("data-kind")).toBe("vod");
    rerender(<MediaCard media={{ ...vod, highlightLabel: "Highlight" }} variant="highlight" />);
    expect(container.querySelector("article")!.getAttribute("data-kind")).toBe("vod");
    expect(screen.getByText("Highlight")).toBeTruthy();
  });

  test("the StreamCard footprint: a 16:9 frame and the same body spacing", () => {
    const { container } = render(<MediaCard media={vod} href="/v" />);
    const media = container.querySelector('[data-slot="media-card-media"]')!;
    expect(media.className).toContain("aspect-video");
    expect(media.className).toContain("w-full");
    expect(media.nextElementSibling!.className).toContain("pt-2.5");
  });

  test("missing or broken thumbnail: the MediaFallback (vod kind, no avatar)", () => {
    const { container, rerender } = render(<MediaCard media={vod} />);
    expect(container.querySelector('[data-slot="media-fallback"]')!.getAttribute("data-kind")).toBe("vod");
    rerender(<MediaCard media={{ ...vod, thumbnailUrl: "/t.webp" }} />);
    expect(container.querySelector('[data-slot="media-fallback"]')).toBeNull();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-slot="media-fallback"]')).toBeTruthy();
  });

  test("an unknown accent falls back to zinc", () => {
    const { container } = render(<MediaCard media={{ ...vod, accent: "chartreuse" }} />);
    expect(container.querySelector("article")!.getAttribute("data-accent")).toBe("zinc");
  });

  test("without href it is not a link; headingLevel makes the title a heading", () => {
    const { container, rerender } = render(<MediaCard media={vod} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector('[data-slot="media-card-link"]')!.tagName).toBe("SPAN");
    rerender(<MediaCard media={vod} href="/v" headingLevel={3} render={<RouterLink />} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(vod.title);
    expect(screen.getByRole("link").getAttribute("data-router")).toBe("yes");
  });

  test("lazy by default, eager on request; compact puts the frame beside the text", () => {
    const { container, rerender } = render(<MediaCard media={{ ...vod, thumbnailUrl: "/t.webp" }} />);
    expect(container.querySelector("img")!.getAttribute("loading")).toBe("lazy");
    rerender(<MediaCard media={{ ...vod, thumbnailUrl: "/t.webp" }} lazy={false} layout="compact" />);
    expect(container.querySelector("img")!.getAttribute("loading")).toBe("eager");
    expect(container.querySelector("article")!.className).toContain("items-start");
    expect(container.querySelector('[data-slot="media-card-media"]')!.className).toContain("w-32");
  });

  test("its skeleton: vod with an avatar, clip without", () => {
    const { container, rerender } = render(<MediaCardSkeleton />);
    expect(container.querySelector('[data-slot="skeleton-avatar"]')).toBeTruthy();
    rerender(<MediaCardSkeleton kind="clip" />);
    expect(container.querySelector('[data-slot="skeleton-avatar"]')).toBeNull();
    expect(container.querySelector('[data-slot="media-card-skeleton"]')!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the auto-fill media grid", () => {
  test("CardGrid: a query container around a 1-to-5 column grid, gap-x-4 gap-y-6", () => {
    const { container } = render(
      <CardGrid data-testid="grid">
        <span />
      </CardGrid>,
    );
    const outer = screen.getByTestId("grid");
    expect(outer.className).toContain("@container");
    const grid = outer.firstElementChild!;
    for (const cls of [
      "grid",
      "grid-cols-1",
      "gap-x-4",
      "gap-y-6",
      "@lg:grid-cols-2",
      "@3xl:grid-cols-3",
      "@5xl:grid-cols-4",
      "@7xl:grid-cols-5",
    ])
      expect(grid.className.split(" ")).toContain(cls);
    expect(container.querySelectorAll("span")).toHaveLength(1);
  });

  test("CardGrid max caps the columns", () => {
    render(<CardGrid max={2} data-testid="grid" />);
    const grid = screen.getByTestId("grid").firstElementChild!;
    expect(grid.className).toContain("@lg:grid-cols-2");
    expect(grid.className).not.toContain("@3xl:grid-cols-3");
  });

  test("StreamGrid uses it; dense caps at two; the first row loads eagerly", () => {
    imagesStillLoading();
    const streams = [0, 1, 2, 3].map((i) => ({ ...stream, channel: { ...stream.channel, id: `c${i}` } }));
    const { container, rerender } = render(<StreamGrid streams={streams} hrefFor={() => "/x"} />);
    expect(container.querySelector('[data-slot="card-grid"]')).toBeTruthy();
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("loading"))).toEqual([
      "eager",
      "eager",
      "eager",
      "lazy",
    ]);
    rerender(<StreamGrid streams={streams} hrefFor={() => "/x"} columns="dense" eager={1} />);
    expect(container.querySelector('[data-slot="card-grid"]')!.getAttribute("data-max")).toBe("2");
    expect(container.querySelectorAll('img[loading="eager"]')).toHaveLength(1);
  });

  test("MediaGrid: cards with router links, or skeletons while loading", () => {
    const items = [vod, { ...vod, id: "v2", title: "Two" }];
    const { container, rerender } = render(
      <MediaGrid media={items} hrefFor={(m) => `/videos/${m.id}`} renderLink={() => <RouterLink />} kind="vod" />,
    );
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/videos/v1", "/videos/v2"]);
    expect(screen.getAllByRole("link").every((a) => a.getAttribute("data-router") === "yes")).toBe(true);
    rerender(<MediaGrid media={items} loading loadingCount={3} kind="clip" columns={2} />);
    expect(container.querySelectorAll('[data-slot="media-card-skeleton"][data-kind="clip"]')).toHaveLength(3);
    expect(container.querySelector('[data-slot="card-grid"]')!.getAttribute("data-max")).toBe("2");
  });
});

const liveLabel = (n: string) => `${n} live`;
const viewerLabel = (n: string) => `${n} viewers`;

describe("CategoryTile", () => {
  const cat = { id: "music", slug: "music", name: "Music", liveCount: 3, viewers: 1_200, tags: ["a", "b", "c", "d"] };

  test("live: a live badge with the count; one stretched link", () => {
    const { container } = render(
      <CategoryTile
        category={cat}
        href="/directory/music"
        liveLabel={liveLabel}
        viewerLabel={viewerLabel}
        maxTags={9}
      />,
    );
    const badge = container.querySelector('[data-slot="category-tile-live"]')!;
    expect(badge.textContent).toBe("3 live");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link").className).toContain("after:inset-0");
    expect(screen.getByText("1.2K viewers").className).toContain("tabular-nums");
    // Tags: at most three, 24 px chips, not links.
    const chips = [...container.querySelectorAll("li > span")];
    expect(chips.map((c) => c.textContent)).toEqual(["a", "b", "c"]);
    for (const chip of chips) expect(chip.className).toContain("min-h-6");
    expect(container.querySelector("article")!.hasAttribute("data-muted")).toBe(false);
  });

  test("0 live: muted art and no zero badge, as a tile and as a chip", () => {
    const idle = { ...cat, liveCount: 0, viewers: 0 };
    const { container, rerender } = render(
      <CategoryTile category={idle} liveLabel={liveLabel} viewerLabel={viewerLabel} />,
    );
    expect(container.querySelector("article")!.getAttribute("data-muted")).toBe("true");
    expect(container.querySelector('[data-slot="category-art"]')!.getAttribute("data-muted")).toBe("true");
    expect(container.textContent).not.toContain("0 live");
    expect(container.textContent).not.toContain("0 viewers");
    expect(container.querySelector('[data-slot="live-badge"]')).toBeNull();
    rerender(<CategoryTile category={idle} layout="chip" liveLabel={liveLabel} viewerLabel={viewerLabel} />);
    expect(container.textContent).not.toContain("0 live");
    expect(container.querySelector("article")!.getAttribute("data-layout")).toBe("chip");
  });

  test("muted can be forced either way", () => {
    const { container } = render(<CategoryTile category={cat} muted liveLabel={liveLabel} viewerLabel={viewerLabel} />);
    expect(container.querySelector('[data-slot="category-art"]')!.getAttribute("data-muted")).toBe("true");
  });

  test("shapes: portrait by default, landscape for the compact shelf", () => {
    const { container, rerender } = render(
      <CategoryTile category={cat} liveLabel={liveLabel} viewerLabel={viewerLabel} />,
    );
    expect(container.querySelector('[data-slot="category-art"]')!.getAttribute("data-shape")).toBe("portrait");
    rerender(<CategoryTile category={cat} shape="landscape" liveLabel={liveLabel} viewerLabel={viewerLabel} />);
    expect(container.querySelector('[data-slot="category-art"]')!.className).toContain("aspect-video");
  });

  test("no card inside a card, and an optional heading", () => {
    const { container } = render(
      <CategoryTile category={cat} href="/m" headingLevel={3} liveLabel={liveLabel} viewerLabel={viewerLabel} />,
    );
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Music");
  });

  test("CategoryGrid loading shows tile-shaped skeletons in the grid's shape", () => {
    const { container } = render(
      <CategoryGrid
        categories={[]}
        loading
        loadingCount={2}
        shape="landscape"
        liveLabel={liveLabel}
        viewerLabel={viewerLabel}
      />,
    );
    const skeletons = container.querySelectorAll('[data-slot="category-tile-skeleton"]');
    expect(skeletons).toHaveLength(2);
    expect(skeletons[0]!.getAttribute("data-shape")).toBe("landscape");
    expect(render(<CategoryTileSkeleton />).container.querySelector(".aspect-3\\/4")).toBeTruthy();
  });
});

describe("EmptyState v2", () => {
  test("with an icon the art is the glyph plate; without, the arcs; art=none draws nothing", () => {
    const { container, rerender } = render(<EmptyState icon={InboxIcon} title="No clips yet" />);
    const art = () => container.querySelector('[data-slot="empty-art"]');
    expect(art()!.getAttribute("data-variant")).toBe("glyph");
    rerender(<EmptyState title="No clips yet" />);
    expect(art()!.getAttribute("data-variant")).toBe("arcs");
    rerender(<EmptyState title="No clips yet" art="bars" />);
    expect(art()!.getAttribute("data-variant")).toBe("bars");
    rerender(<EmptyState title="No clips yet" art="none" />);
    expect(art()).toBeNull();
  });

  test("title, body, then the primary action before the secondary one", () => {
    render(
      <EmptyState
        title="Nobody is live"
        body="Follow channels to hear when they go live."
        action={<a href="/directory">Browse</a>}
        secondaryAction={<a href="/following">Following</a>}
        headingLevel={3}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Nobody is live" })).toBeTruthy();
    const body = screen.getByText("Follow channels to hear when they go live.");
    expect(body.className).toContain("text-sm");
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Browse", "Following"]);
    const actions = screen.getByRole("link", { name: "Browse" }).parentElement!;
    expect(actions.getAttribute("data-slot")).toBe("empty-state-actions");
    expect(actions.className).toContain("flex-row");
  });

  test("description wins over body; no actions, no action row", () => {
    const { container } = render(<EmptyState title="T" description="D" body="B" />);
    expect(screen.getByText("D")).toBeTruthy();
    expect(screen.queryByText("B")).toBeNull();
    expect(container.querySelector('[data-slot="empty-state-actions"]')).toBeNull();
  });

  test.each([
    ["sm", "size-14", "text-sm"],
    ["md", "size-24", "text-base"],
    ["lg", "size-40", "text-2xl"],
  ] as const)("size %s: art %s, title %s", (size, art, title) => {
    const { container } = render(<EmptyState title="Gone" size={size} />);
    expect(container.querySelector('[data-slot="empty-state"]')!.getAttribute("data-size")).toBe(size);
    expect(container.querySelector('[data-slot="empty-art"]')!.className).toContain(art);
    expect(container.querySelector('[data-slot="empty-title"]')!.className).toContain(title);
  });

  test("the art is hidden from assistive tech; crossed reaches the arcs", () => {
    const { container } = render(<EmptyState title="Page not found" crossed size="lg" />);
    expect(container.querySelector('[data-slot="empty-art"]')!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-slot="art-arcs"]')!.getAttribute("data-crossed")).toBe("true");
  });
});

describe("skeletons", () => {
  test("every bone is static under reduced motion (pulse only behind motion-safe)", () => {
    const { container } = render(
      <SkeletonGroup>
        <StreamCardSkeleton />
        <StreamCardSkeleton size="feature" />
        <MediaCardSkeleton />
        <ChannelChipSkeleton />
        <CategoryTileSkeleton />
        <SkeletonText />
        <Skeleton />
      </SkeletonGroup>,
    );
    const bones = [
      ...container.querySelectorAll(
        '[data-slot="skeleton"], [data-slot="skeleton-thumbnail"], [data-slot="skeleton-avatar"]',
      ),
    ];
    expect(bones.length).toBeGreaterThan(20);
    for (const bone of bones) {
      const classes = bone.className.split(" ");
      expect(classes).toContain("animate-none");
      expect(classes).toContain("motion-safe:animate-pulse");
      expect(classes).not.toContain("animate-pulse");
    }
  });

  test("the stream card skeleton mirrors the card: frame, avatar, two title lines, meta, two tag chips", () => {
    const { container } = render(<StreamCardSkeleton />);
    const root = container.querySelector('[data-slot="stream-card-skeleton"]')!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector('[data-slot="skeleton-thumbnail"]')!.className).toContain("aspect-video");
    expect(root.querySelector('[data-slot="skeleton-avatar"]')!.className).toContain("size-8");
    expect(root.querySelectorAll(".h-6")).toHaveLength(2);
    // No full-width slab other than the frame itself.
    const bones = root.querySelectorAll('[data-slot="skeleton"], [data-slot="skeleton-thumbnail"]');
    const wide = [...bones].filter((b) => b.className.split(" ").includes("w-full"));
    expect(wide).toHaveLength(1);
  });
});

describe("hydration", () => {
  test.each([
    ["feature StreamCard", <StreamCard key="f" stream={stream} href="/a" size="feature" ctaLabel="Watch now" />],
    [
      "ChannelChip row",
      <ChannelChipRow key="r">
        <ChannelChip name="A" href="/a" meta="Art" />
      </ChannelChipRow>,
    ],
    ["MediaGrid", <MediaGrid key="m" media={[vod]} hrefFor={() => "/v"} />],
    ["EmptyState", <EmptyState key="e" icon={InboxIcon} title="T" secondaryAction={<a href="/x">X</a>} />],
  ])("%s hydrates without mismatch", async (_name, node) => {
    imagesStillLoading();
    const wrapped = <LocaleProvider locale="en">{node}</LocaleProvider>;
    const host = document.createElement("div");
    host.innerHTML = renderToString(wrapped);
    document.body.append(host);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(host, wrapped, { onRecoverableError: (e) => console.error(e) });
    });
    expect(errors).not.toHaveBeenCalled();
  });
});
