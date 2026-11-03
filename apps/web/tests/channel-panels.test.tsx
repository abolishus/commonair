// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The channel page's panels and banner (batch 8, B8-web; docs/testing/b8-selectors.md): a panel's
 * body is text (HTML in it stays text), links are `nofollow ugc` in a new tab, images lazy with the
 * title as alt, no section without panels, no empty title box; the banner's reserved 6:1 frame,
 * `alt=""`, and hidden on a suspended channel or a mature one before 18+; the accessibility rules
 * axe would flag; and 20 panels fit a 320 px column.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BANNER_RATIO, ChannelBanner, ChannelBannerSkeleton } from "../src/components/channel/banner.tsx";
import {
  bannerVisible,
  channelExtras,
  safeHttpUrl,
  type ChannelPanelView,
} from "../src/components/channel/panels-data.ts";
import { ChannelPanels, PANEL_LINK_REL, hostOf } from "../src/components/channel/panels.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const MEDIA = "https://media.example.test/channels/c1/panels/p.png";
const panel = (n: number, over: Partial<ChannelPanelView> = {}): ChannelPanelView => ({
  id: `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`,
  title: `Panel ${n}`,
  body: `Body ${n}`,
  imageUrl: null,
  linkUrl: null,
  ...over,
});

const byTestId = (root: ParentNode, id: string) => [...root.querySelectorAll(`[data-testid="${id}"]`)];

/** The rules axe would flag here: button-name, link-name, image-alt, label references, duplicate ids. */
function a11yViolations(root: ParentNode): string[] {
  const out: string[] = [];
  const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? "").trim() || (el.textContent ?? "").trim();
  for (const el of root.querySelectorAll("a, button")) if (nameOf(el) === "") out.push(`name: ${el.outerHTML}`);
  for (const el of root.querySelectorAll("img")) if (!el.hasAttribute("alt")) out.push(`image-alt: ${el.outerHTML}`);
  for (const el of root.querySelectorAll("[aria-labelledby]"))
    for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean))
      if (!document.getElementById(id)) out.push(`aria-labelledby points at missing #${id}`);
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  return out;
}

describe("channelExtras", () => {
  it("orders panels by position, keeps http(s) URLs as they are and drops unsafe ones", () => {
    const x = channelExtras({
      bannerUrl: "https://media.example.test/channels/c1/banner/b.png",
      suspended: false,
      panels: [
        {
          id: "b",
          position: 1,
          title: "Second",
          body: "",
          imageUrl: "javascript:alert(1)",
          linkUrl: "data:text/html,x",
        },
        { id: "a", position: 0, title: "First", body: "Hi", imageUrl: MEDIA, linkUrl: "https://shop.example.org/x" },
      ],
    });
    expect(x.bannerUrl).toBe("https://media.example.test/channels/c1/banner/b.png");
    expect(x.panels.map((p) => p.id)).toEqual(["a", "b"]);
    expect(x.panels[0]).toMatchObject({ imageUrl: MEDIA, linkUrl: "https://shop.example.org/x" });
    expect(x.panels[1]).toMatchObject({ imageUrl: null, linkUrl: null });
  });

  it("leaves out a panel with nothing to show", () => {
    const x = channelExtras({
      bannerUrl: null,
      suspended: true,
      panels: [{ id: "a", position: 0, title: "  ", body: "", imageUrl: null, linkUrl: null }],
    });
    expect(x).toEqual({ bannerUrl: null, panels: [], suspended: true });
  });

  it("safeHttpUrl accepts only absolute http(s)", () => {
    expect(safeHttpUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHttpUrl("http://a.example/x")).toBe("http://a.example/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("/relative")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("the panels", () => {
  it("render nothing without panels", () => {
    const { container } = wrap(<ChannelPanels panels={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("keep HTML in the body as text, with its line breaks", () => {
    const body = 'Pixel <b onclick="steal()">sprites</b>\n<script>alert(1)</script>';
    const { container } = wrap(<ChannelPanels panels={[panel(1, { body })]} />);
    const el = byTestId(container, "channel-panel-body")[0] as HTMLElement;
    expect(el.textContent).toBe(body);
    expect(el.querySelector("b, script")).toBeNull();
    expect(el.className).toContain("whitespace-pre-line");
  });

  it("links open in a new tab as nofollow ugc, with an icon and a label through t()", () => {
    const { container } = wrap(<ChannelPanels panels={[panel(1, { linkUrl: "https://shop.example.org/seeds" })]} />);
    const a = byTestId(container, "channel-panel-link")[0] as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://shop.example.org/seeds");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe(PANEL_LINK_REL);
    expect(PANEL_LINK_REL.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer", "nofollow", "ugc"]));
    expect(a.textContent).toBe(en["channelPage.panels.link"].replace("{host}", "shop.example.org"));
    expect(a.getAttribute("aria-label")).toBe(en["channelPage.panels.linkLabel"].replace("{host}", "shop.example.org"));
    expect(a.querySelector("svg[aria-hidden]")).not.toBeNull();
  });

  it("images are lazy, in a fixed frame, with the title as alt", () => {
    const { container } = wrap(<ChannelPanels panels={[panel(1, { imageUrl: MEDIA })]} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(MEDIA);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("Panel 1");
    expect(img.parentElement?.getAttribute("data-slot")).toBe("aspect-ratio");
  });

  it("a panel with only an image, or only a link, has no empty title box", () => {
    const { container } = wrap(
      <ChannelPanels
        panels={[
          panel(1, { title: "", body: "", imageUrl: MEDIA }),
          panel(2, { title: "", body: "", linkUrl: "https://a.example/" }),
        ]}
      />,
    );
    const cards = byTestId(container, "channel-panel");
    expect(cards.map((c) => c.getAttribute("data-panel-index"))).toEqual(["0", "1"]);
    expect(container.querySelector('[data-slot="card-title"]')).toBeNull();
    expect(container.querySelector('[data-slot="card-header"]')).toBeNull();
    expect(byTestId(container, "channel-panel-body")).toHaveLength(0);
  });

  it("20 panels stack in one column at 320 px: no fixed widths, every cell can shrink", () => {
    const { container } = wrap(
      <ChannelPanels
        panels={Array.from({ length: 20 }, (_, i) =>
          panel(i, { body: "x".repeat(400), linkUrl: `https://very-long-host-name-${i}.example.org/a/b/c` }),
        )}
      />,
    );
    expect(byTestId(container, "channel-panel")).toHaveLength(20);
    const grid = container.querySelector("ul") as HTMLElement;
    expect(grid.className).toContain("grid-cols-1");
    const classes = [...container.querySelectorAll("[class]")].flatMap((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/),
    );
    expect(classes.filter((c) => /^(min-)?w-(\[\d+px\]|\d{2,})$/.test(c))).toEqual([]);
    expect(byTestId(container, "channel-panel-body").every((b) => b.className.includes("break-words"))).toBe(true);
    expect(a11yViolations(container)).toEqual([]);
  });

  it("hostOf shows where a link goes", () => {
    expect(hostOf("https://shop.example.org/seeds")).toBe("shop.example.org");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("the banner", () => {
  it("reserves its 6:1 frame, is decorative and lazy", () => {
    const { container } = wrap(<ChannelBanner url="https://media.example.test/channels/c1/banner/b.png" />);
    const frame = byTestId(container, "channel-banner")[0] as HTMLElement;
    expect(frame.getAttribute("data-slot")).toBe("aspect-ratio");
    expect(frame.style.getPropertyValue("--ratio")).toBe(String(BANNER_RATIO));
    const img = frame.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe("https://media.example.test/channels/c1/banner/b.png");
    expect(a11yViolations(container)).toEqual([]);
  });

  it("its skeleton holds the same frame", () => {
    const { container } = wrap(<ChannelBannerSkeleton />);
    const frame = container.querySelector('[data-slot="aspect-ratio"]') as HTMLElement;
    expect(frame.style.getPropertyValue("--ratio")).toBe(String(BANNER_RATIO));
    expect(byTestId(container, "channel-banner")).toHaveLength(0);
  });

  it("is hidden on a suspended channel, behind the T1 interstitial, and on a mature one before 18+", () => {
    const base = {
      bannerUrl: "https://m.example/b.png",
      suspended: false,
      mature: false,
      confirmed: false,
      locked: false,
    };
    expect(bannerVisible(base)).toBe(true);
    expect(bannerVisible({ ...base, bannerUrl: null })).toBe(false);
    expect(bannerVisible({ ...base, suspended: true })).toBe(false);
    expect(bannerVisible({ ...base, locked: true })).toBe(false);
    expect(bannerVisible({ ...base, mature: true })).toBe(false);
    expect(bannerVisible({ ...base, mature: true, confirmed: true })).toBe(true);
    expect(bannerVisible({ ...base, mature: true, confirmed: true, suspended: true })).toBe(false);
  });
});
