// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** D1 art system: Arcs, SignalBars, EmptyArt, MediaFallback and CategoryArt (inline SVG from tokens only). */
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type * as React from "react";
import { describe, expect, test } from "vite-plus/test";
import { ChefHatIcon, InboxIcon } from "@hugeicons/core-free-icons";
import {
  Arcs,
  CategoryArt,
  EmptyArt,
  MediaFallback,
  SIGNAL_ACCENTS,
  SIGNAL_HEIGHTS,
  SignalBars,
  artHash,
  categoryFallback,
  categoryKind,
} from "../../src/index.ts";
import * as mediaBlocks from "../../src/blocks/media/index.ts";

const html = (node: React.ReactElement): string => renderToString(node);

describe("Arcs", () => {
  test("is decorative: aria-hidden, not focusable, and the caller cannot unhide it", () => {
    const { container } = render(<Arcs aria-hidden={false} className="size-10 text-brand" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("data-slot")).toBe("art-arcs");
    expect(svg.getAttribute("class")).toContain("size-10");
    expect(svg.getAttribute("viewBox")).toBe("80 80 352 352");
  });

  test("paints only with currentColor: no colour literal in the markup", () => {
    const markup = html(<Arcs crossed />);
    expect(markup).toContain("currentColor");
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
  });

  test("the four arcs and the dot; crossed adds one bar", () => {
    const { container, rerender } = render(<Arcs />);
    expect(container.querySelectorAll("path")).toHaveLength(4);
    expect(container.querySelector("circle")).toBeTruthy();
    expect(container.querySelector('[data-slot="art-arcs-cross"]')).toBeNull();
    rerender(<Arcs crossed />);
    expect(container.querySelectorAll("path")).toHaveLength(5);
    expect(container.querySelector("svg")!.getAttribute("data-crossed")).toBe("true");
  });
});

describe("SignalBars", () => {
  const rects = (root: ParentNode) => [...root.querySelectorAll("rect")];

  test("twelve bars, each painted by its channel-accent token, in spectrum order", () => {
    const { container } = render(<SignalBars />);
    const bars = rects(container);
    expect(bars.map((r) => r.getAttribute("data-accent"))).toEqual([...SIGNAL_ACCENTS]);
    for (const bar of bars) expect(bar.getAttribute("class")).toBe("fill-channel-accent");
    expect(new Set(SIGNAL_ACCENTS).size).toBe(12);
  });

  test("bars variant uses the fixed heights; band is a flat strip", () => {
    const { container, rerender } = render(<SignalBars />);
    expect(rects(container).map((r) => Number(r.getAttribute("height")))).toEqual([...SIGNAL_HEIGHTS]);
    // Bars stand on the baseline.
    for (const r of rects(container)) expect(Number(r.getAttribute("y")) + Number(r.getAttribute("height"))).toBe(100);
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 47 100");
    rerender(<SignalBars variant="band" />);
    expect(rects(container).every((r) => r.getAttribute("height") === "100")).toBe(true);
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 12 100");
    expect(container.querySelector("svg")!.getAttribute("data-variant")).toBe("band");
  });

  test("a seed rotates the heights deterministically", () => {
    const heights = (seed?: string) =>
      rects(render(<SignalBars seed={seed} />).container).map((r) => Number(r.getAttribute("height")));
    expect(heights("music")).toEqual(heights("music"));
    const offset = artHash("music") % 12;
    expect(heights("music")[0]).toBe(SIGNAL_HEIGHTS[offset]);
    const all = new Set(["art", "music", "games", "chess", "cooking"].map((s) => heights(s).join()));
    expect(all.size).toBeGreaterThan(1);
  });

  test("stretches to its box, decorative, with default heights by variant", () => {
    const { container, rerender } = render(<SignalBars />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("h-6");
    rerender(<SignalBars variant="band" className="h-1" />);
    expect(container.querySelector("svg")!.getAttribute("class")).toContain("h-1");
    expect(container.querySelector("svg")!.getAttribute("class")).not.toContain("h-1.5");
  });
});

describe("EmptyArt", () => {
  test.each([
    ["sm", "size-14"],
    ["md", "size-24"],
    ["lg", "size-40"],
  ] as const)("size %s is %s", (size, cls) => {
    const { container } = render(<EmptyArt size={size} />);
    const art = container.querySelector('[data-slot="empty-art"]')!;
    expect(art.className).toContain(cls);
    expect(art.getAttribute("data-size")).toBe(size);
  });

  test("arcs (default), bars and glyph variants, all aria-hidden", () => {
    const { container, rerender } = render(<EmptyArt />);
    const art = () => container.querySelector('[data-slot="empty-art"]')!;
    expect(art().getAttribute("aria-hidden")).toBe("true");
    expect(art().getAttribute("data-variant")).toBe("arcs");
    expect(art().querySelector('[data-slot="art-arcs"]')).toBeTruthy();
    rerender(<EmptyArt variant="bars" />);
    expect(art().querySelector('[data-slot="art-signal-bars"]')).toBeTruthy();
    rerender(<EmptyArt variant="glyph" icon={InboxIcon} />);
    expect(art().getAttribute("data-variant")).toBe("glyph");
    // The glyph, plus the band on the plate's bottom edge.
    expect(art().querySelectorAll("svg")).toHaveLength(2);
    expect(art().querySelector('[data-slot="art-signal-bars"]')!.getAttribute("data-variant")).toBe("band");
    expect(art().querySelector(".bg-channel-accent\\/12")).toBeTruthy();
    expect(art().querySelector(".dark\\:bg-channel-accent\\/18")).toBeTruthy();
  });

  test("a glyph plate without an icon carries the arcs; crossed reaches the arcs", () => {
    const { container } = render(<EmptyArt variant="glyph" crossed />);
    expect(container.querySelector('[data-slot="art-arcs"]')!.getAttribute("data-crossed")).toBe("true");
  });

  test("never animates", () => {
    for (const variant of ["arcs", "bars", "glyph"] as const)
      expect(html(<EmptyArt variant={variant} icon={InboxIcon} />)).not.toMatch(/animate-|transition/);
  });
});

describe("MediaFallback", () => {
  test("an accent-tinted field (12 % light, 18 % dark) with the arcs at 30 %, never a grey slab", () => {
    const { container } = render(<MediaFallback accent="violet" name="Aurora Pixel" />);
    const root = container.querySelector('[data-slot="media-fallback"]')!;
    expect(root.getAttribute("data-accent")).toBe("violet");
    expect(root.className).toContain("bg-card");
    expect(root.className).not.toContain("bg-muted");
    const tint = root.querySelector('[data-slot="media-fallback-tint"]')!;
    expect(tint.className).toContain("bg-channel-accent/12");
    expect(tint.className).toContain("dark:bg-channel-accent/18");
    const arcs = root.querySelector('[data-slot="art-arcs"]')!;
    expect(arcs.getAttribute("class")).toContain("opacity-30");
    expect(arcs.getAttribute("class")).toContain("text-channel-accent");
  });

  test("offline: avatar at the bottom start; nothumb: centred; vod: no avatar", () => {
    const { container, rerender } = render(<MediaFallback kind="offline" name="Sly Kettle" />);
    const avatar = () => container.querySelector('[data-slot="avatar"]');
    expect(avatar()?.parentElement?.className).toContain("start-3 bottom-3");
    rerender(<MediaFallback kind="nothumb" name="Sly Kettle" />);
    expect(avatar()?.parentElement?.className).toContain("justify-center");
    rerender(<MediaFallback kind="vod" name="Sly Kettle" />);
    expect(avatar()).toBeNull();
    rerender(<MediaFallback kind="offline" />);
    expect(avatar()).toBeNull();
  });

  test("the art is hidden from assistive tech; the label is not", () => {
    const { container, getByText } = render(<MediaFallback kind="offline" name="Sly" label="Offline" />);
    const label = getByText("Offline");
    expect(label.closest("[aria-hidden]")).toBeNull();
    expect(label.getAttribute("data-slot")).toBe("media-fallback-label");
    expect(container.querySelector('[data-slot="art-arcs"]')!.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="avatar"]')!.closest('[aria-hidden="true"]')).toBeTruthy();
  });

  test("without an accent it inherits the nearest data-accent", () => {
    const { container } = render(<MediaFallback />);
    expect(container.querySelector('[data-slot="media-fallback"]')!.hasAttribute("data-accent")).toBe(false);
  });
});

describe("CategoryArt", () => {
  test("shapes: portrait 3:4, landscape 16:9, or fill the caller's box", () => {
    const shape = (s?: "portrait" | "landscape") =>
      render(<CategoryArt slug="music" shape={s} />).container.querySelector('[data-slot="category-art"]')!.className;
    expect(shape("portrait")).toContain("aspect-3/4");
    expect(shape("landscape")).toContain("aspect-video");
    expect(shape()).toContain("size-full");
  });

  test("the fallback: a tint (12 % light, 22 % dark), the kind's glyph and the bars strip", () => {
    const { container } = render(<CategoryArt slug="cooking" />);
    const art = container.querySelector('[data-slot="category-art"]')!;
    expect(art.getAttribute("aria-hidden")).toBe("true");
    expect(art.getAttribute("data-fallback")).toBe("food");
    const tone = Number(art.getAttribute("data-tone"));
    expect(tone).toBe(categoryFallback("cooking").tone);
    const tint = art.querySelector('[data-slot="category-art-tint"]')!;
    expect(tint.className).toContain(`bg-chart-${tone + 1}/12`);
    expect(tint.className).toContain(`dark:bg-chart-${tone + 1}/22`);
    expect(art.className).toContain(`text-chart-${tone + 1}`);
    const bars = art.querySelector('[data-slot="art-signal-bars"]')!;
    expect(bars.getAttribute("data-variant")).toBe("band");
    expect(bars.getAttribute("class")).toContain("bottom-0");
  });

  test("an accent replaces the chart tone", () => {
    const { container } = render(<CategoryArt slug="cooking" accent="orange" />);
    const art = container.querySelector('[data-slot="category-art"]')!;
    expect(art.hasAttribute("data-tone")).toBe(false);
    expect(art.getAttribute("data-accent")).toBe("orange");
    expect(art.querySelector('[data-slot="category-art-tint"]')!.className).toContain("dark:bg-channel-accent/22");
  });

  test("muted (0 live): --muted, no tint, faded bars", () => {
    const { container } = render(<CategoryArt slug="chess" muted />);
    const art = container.querySelector('[data-slot="category-art"]')!;
    expect(art.getAttribute("data-muted")).toBe("true");
    expect(art.className).toContain("bg-muted");
    expect(art.className).toContain("text-muted-foreground");
    expect(art.querySelector('[data-slot="category-art-tint"]')).toBeNull();
    expect(art.querySelector('[data-slot="art-signal-bars"]')!.getAttribute("class")).toContain("grayscale");
  });

  test("box art wins over the fallback; muted box art is desaturated", () => {
    const { container, rerender } = render(<CategoryArt slug="x" imageUrl="/box.webp" />);
    const img = () => container.querySelector("img")!;
    expect(img().getAttribute("alt")).toBe("");
    expect(img().getAttribute("loading")).toBe("lazy");
    expect(container.querySelector('[data-slot="art-signal-bars"]')).toBeNull();
    expect(img().className).not.toContain("grayscale");
    rerender(<CategoryArt slug="x" imageUrl="/box.webp" muted shape="landscape" />);
    expect(img().className).toContain("grayscale");
    expect(container.querySelector('[data-slot="category-art"]')!.className).toContain("aspect-video");
  });

  test.each([
    ["sm", "size-4"],
    ["md", "size-6"],
    ["lg", "size-10"],
  ] as const)("glyph size %s", (iconSize, cls) => {
    const { container } = render(<CategoryArt slug="music" iconSize={iconSize} />);
    expect(container.querySelector('[data-slot="category-art"] > svg')!.getAttribute("class")).toContain(cls);
  });

  test("the server and the browser draw the same tile", () => {
    expect(html(<CategoryArt slug="hollow-depths" />)).toBe(html(<CategoryArt slug="hollow-depths" />));
  });

  test("still importable from the media blocks", () => {
    expect(mediaBlocks.CategoryArt).toBe(CategoryArt);
    expect(mediaBlocks.categoryKind).toBe(categoryKind);
  });
});

describe("category kinds", () => {
  test.each([
    ["art", "art"],
    ["watercolour-painting", "art"],
    ["starfall", "other"],
    ["just-chatting", "talk"],
    ["software-game-dev", "tech"],
    ["tabletop-rpgs", "games"],
    ["food-drink", "food"],
    ["yoga", "fitness"],
    ["chess", "sports"],
    ["language-exchange", "learning"],
    ["outdoors", "travel"],
    ["true-crime-podcast", "podcast"],
    ["", "other"],
  ] as const)("%s → %s", (slug, kind) => {
    expect(categoryKind(slug)).toBe(kind);
  });

  test("the fallback tone is stable and in range", () => {
    for (const slug of ["", "a", "music", "hollow-depths", "ñandú"]) {
      const { tone } = categoryFallback(slug);
      expect(tone).toBe(categoryFallback(slug).tone);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(6);
    }
  });

  test("artHash is FNV-1a (32-bit, unsigned)", () => {
    expect(artHash("")).toBe(0x811c9dc5);
    expect(artHash("a")).toBe(0xe40c292c);
    expect(artHash("music")).toBeGreaterThan(0);
  });
});

describe("no art fetches or animates", () => {
  test.each([
    ["Arcs", <Arcs key="a" />],
    ["SignalBars", <SignalBars key="b" />],
    ["EmptyArt", <EmptyArt key="c" variant="glyph" icon={ChefHatIcon} />],
    ["MediaFallback", <MediaFallback key="d" name="X" label="Offline" />],
    ["CategoryArt", <CategoryArt key="e" slug="music" />],
  ])("%s: no remote URL, no animation, no inline style", (_name, node) => {
    // The SVG namespace is an identifier, not a fetch.
    const markup = html(node).replaceAll('xmlns="http://www.w3.org/2000/svg"', "");
    expect(markup).not.toMatch(/https?:\/\//);
    expect(markup).not.toMatch(/animate-/);
    expect(markup).not.toMatch(/style="/);
  });
});
