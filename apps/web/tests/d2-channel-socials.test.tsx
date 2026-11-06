// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The About tab's social links (`Channel.socials`): the page's own guard (https without
 * credentials, known platforms), the visible label, and the links themselves: the streamer's
 * order, one icon each, `rel="noopener noreferrer me"`, a new tab said in the accessible name,
 * keyboard reachable. Plus `summarize`'s new fields and the clip filter helpers.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ChannelAboutSection, ChannelSocials, platformName } from "../src/components/channel/about.tsx";
import { channelAbout, isHttpsUrl, socialLabel } from "../src/components/channel/channel-data.ts";
import {
  clipFilterFrom,
  clipFilterSearch,
  isDefaultClipFilter,
  parseClipFilter,
} from "../src/components/channel/clip-filters.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { cleanTags, summarize } from "../src/lib/channel-summary.ts";

afterEach(cleanup);

function inRouter(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

describe("channelAbout socials", () => {
  it("keeps https links on known platforms, in order; drops anything else", () => {
    const about = channelAbout({
      description: " Hi ",
      socials: [
        { platform: "mastodon", url: "https://mastodon.example.org/@fern" },
        { platform: "website", url: "http://example.org/fern" },
        { platform: "x", url: "https://user:pass@example.org/fern" },
        { platform: "myspace" as never, url: "https://example.org/old" },
        { platform: "github", url: "not a url" },
        { platform: "other", url: "https://example.org/fern/notes" },
      ],
    });
    expect(about).toEqual({
      bio: "Hi",
      socials: [
        { platform: "mastodon", url: "https://mastodon.example.org/@fern" },
        { platform: "other", url: "https://example.org/fern/notes" },
      ],
    });
  });

  it("an API without the field is no links", () => {
    expect(channelAbout({ description: "" } as never).socials).toEqual([]);
  });

  it("isHttpsUrl and socialLabel", () => {
    expect(isHttpsUrl("https://example.org")).toBe(true);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl("ftp://example.org")).toBe(false);
    expect(socialLabel("https://www.example.org/")).toBe("example.org");
    expect(socialLabel("https://example.org/@fern/")).toBe("example.org/@fern");
    expect(socialLabel("https://example.org:8443/a/b")).toBe("example.org:8443/a/b");
    expect(socialLabel("nope")).toBe("nope");
  });
});

describe("ChannelSocials", () => {
  const socials = [
    { platform: "website", url: "https://example.org/fern" },
    { platform: "bluesky", url: "https://bsky.example.org/profile/fern" },
    { platform: "other", url: "https://example.org/fern/notes" },
  ] as const;

  it("one link each, in order, opening a new tab with rel me and a full accessible name", async () => {
    inRouter(<ChannelSocials name="Fernsby" socials={socials} />);
    const list = await screen.findByTestId("channel-socials");
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("aria-label")).toBe("Fernsby's links");
    const links = screen.getAllByTestId("channel-social-link");
    expect(links.map((a) => [a.getAttribute("data-platform"), a.getAttribute("href")])).toEqual(
      socials.map((s) => [s.platform, s.url]),
    );
    for (const a of links) {
      expect(a.tagName).toBe("A");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer me");
      expect(a.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      // Focusable: a real link, never a tabindex trick.
      expect(a.getAttribute("tabindex")).toBeNull();
    }
    expect(links[0]?.getAttribute("aria-label")).toBe("Website: example.org/fern (opens in a new tab)");
    expect(links[1]?.getAttribute("aria-label")).toBe("Bluesky: bsky.example.org/profile/fern (opens in a new tab)");
    expect(links[2]?.textContent).toBe("example.org/fern/notes");
  });

  it("renders nothing without links", async () => {
    const { container } = inRouter(
      <>
        <span data-testid="mounted" />
        <ChannelSocials name="Fernsby" socials={[]} />
      </>,
    );
    await screen.findByTestId("mounted");
    expect(container.querySelector('[data-testid="channel-socials"]')).toBeNull();
  });

  it("every platform has a name (brands as written, website and other translated)", () => {
    expect(platformName("x")).toBe("X");
    expect(platformName("youtube")).toBe("YouTube");
    expect(platformName("website")).toBe("Website");
    expect(platformName("other")).toBe("Link");
  });

  it("the About card shows the category and the links under the bio", async () => {
    inRouter(
      <ChannelAboutSection
        name="Fernsby"
        about={{ bio: "I paint.", socials: [...socials] }}
        category={{ slug: "art", name: "Art" }}
        followers={<span>3 followers</span>}
        panels={[]}
      />,
    );
    const about = await screen.findByTestId("channel-about");
    expect(about.querySelector('[data-testid="channel-meta-category"]')?.getAttribute("href")).toBe("/directory/art");
    expect(about.querySelectorAll('[data-testid="channel-social-link"]')).toHaveLength(3);
  });
});

describe("summarize: category, tags and lastLiveAt", () => {
  const base = {
    id: "c",
    slug: "fern",
    displayName: "Fern",
    title: "",
    avatarUrl: null,
    followerCount: 0,
    theme: {},
    live: null,
    category: { id: "k1", slug: "art", name: "Art" },
    tags: [" cozy ", "Cozy", ""],
    lastLiveAt: "2026-11-01T10:00:00.000Z",
  };

  it("carries them from channels.get", () => {
    const s = summarize(base as never);
    expect(s.category).toEqual({ id: "k1", slug: "art", name: "Art" });
    expect(s.tags).toEqual(["cozy"]);
    expect(s.lastLiveAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("missing fields (an older API or a partial double) are null and empty", () => {
    const s = summarize({ ...base, category: undefined, tags: undefined, lastLiveAt: undefined } as never);
    expect(s.category).toBeNull();
    expect(s.tags).toEqual([]);
    expect(s.lastLiveAt).toBeNull();
    expect(cleanTags(undefined)).toEqual([]);
  });
});

describe("clip filter helpers", () => {
  it("parses, defaults and drops the defaults from the URL", () => {
    expect(parseClipFilter({ sort: "top", range: "7d" })).toEqual({ sort: "top", range: "7d" });
    expect(parseClipFilter({ sort: "recent", range: "all" })).toEqual({});
    expect(parseClipFilter({ sort: ["top"], range: 7 })).toEqual({});
    expect(clipFilterFrom({})).toEqual({ sort: "recent", range: "all" });
    expect(clipFilterFrom({ range: "30d" })).toEqual({ sort: "recent", range: "30d" });
    expect(clipFilterSearch({ sort: "recent", range: "all" })).toEqual({});
    expect(clipFilterSearch({ sort: "top", range: "30d" })).toEqual({ sort: "top", range: "30d" });
    expect(isDefaultClipFilter({ sort: "recent", range: "all" })).toBe(true);
    expect(isDefaultClipFilter({ sort: "top", range: "all" })).toBe(false);
    expect(isDefaultClipFilter({ sort: "recent", range: "7d" })).toBe(false);
  });
});
