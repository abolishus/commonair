// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F13: link-preview tags (Open Graph, the Twitter card, canonical) from the instance the root
 * loader describes, on the channel, VOD, clip and proposal routes, from data their loaders have.
 */
import { SITE } from "@commonair/config/site";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ChannelPage } from "../src/components/channel/panels-loader.ts";
import { t } from "../src/i18n/index.ts";
import {
  DESCRIPTION_MAX,
  FALLBACK_IMAGE_PATH,
  absoluteUrl,
  canonicalUrl,
  previewText,
  seoHead,
  siteFromMatches,
  withSeo,
  type SeoHead,
} from "../src/lib/seo.ts";
import { titleHead } from "../src/lib/page-title.ts";

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, instance: { name: "Test Air" }, config: { publicUrl: "https://a.example" } }),
}));
vi.mock("../src/player/player.tsx", () => ({ Player: () => null }));
vi.mock("../src/chat/chat-panel.tsx", () => ({ ChatPanel: () => null }));

const SITE_A = { name: "Air A", publicUrl: "https://air.example" };
const ROOT = {
  routeId: "__root__",
  loaderData: { config: { instanceName: "Air A", publicUrl: "https://air.example/" } },
};

/** `property`/`name` → content. */
function tags(head: SeoHead | { meta?: unknown[]; links?: unknown[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (head.meta ?? []) as Record<string, string>[]) {
    const key = m.property ?? m.name;
    if (key && m.content !== undefined) out[key] = m.content;
  }
  for (const l of (head.links ?? []) as { rel: string; href: string }[]) out[`link:${l.rel}`] = l.href;
  return out;
}

describe("siteFromMatches", () => {
  it("reads the instance from the root loader's config, without a trailing slash", () => {
    expect(siteFromMatches([{ routeId: "/_app", loaderData: undefined }, ROOT])).toEqual(SITE_A);
  });
  it("falls back to the project defaults before the root has loaded or with a bad shape", () => {
    const fallback = { name: SITE.name, publicUrl: SITE.url };
    expect(siteFromMatches(undefined)).toEqual(fallback);
    expect(siteFromMatches([])).toEqual(fallback);
    expect(siteFromMatches([{ routeId: "__root__", loaderData: { config: { publicUrl: 42 } } }])).toEqual(fallback);
    expect(
      siteFromMatches([{ routeId: "__root__", loaderData: { config: { publicUrl: "https://b.example" } } }]),
    ).toEqual({ name: SITE.name, publicUrl: "https://b.example" });
  });
});

describe("previewText", () => {
  it("collapses whitespace and is null when empty", () => {
    expect(previewText("  a \n\n b\t c ")).toBe("a b c");
    expect(previewText("   ")).toBeNull();
    expect(previewText(null)).toBeNull();
    expect(previewText(undefined)).toBeNull();
  });
  it("cuts long text at a word with an ellipsis, never past the limit", () => {
    const long = "word ".repeat(100);
    const cut = previewText(long) ?? "";
    expect(cut.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(cut.endsWith("word…")).toBe(true);
    expect(previewText("x".repeat(300))?.length).toBe(DESCRIPTION_MAX);
    expect(previewText("a".repeat(DESCRIPTION_MAX))).toBe("a".repeat(DESCRIPTION_MAX));
  });
});

describe("absoluteUrl and canonicalUrl", () => {
  it("keeps http(s) URLs, resolves paths on the instance, refuses other schemes", () => {
    expect(absoluteUrl(SITE_A, "https://media.example/b.jpg")).toBe("https://media.example/b.jpg");
    expect(absoluteUrl(SITE_A, "/media/b.jpg")).toBe("https://air.example/media/b.jpg");
    expect(absoluteUrl(SITE_A, "javascript:alert(1)")).toBeNull();
    expect(absoluteUrl(SITE_A, "data:image/png;base64,AA")).toBeNull();
    expect(absoluteUrl(SITE_A, null)).toBeNull();
    expect(absoluteUrl(SITE_A, "")).toBeNull();
  });
  it("drops the query, hash and trailing slash, and stays on the instance's origin", () => {
    expect(canonicalUrl(SITE_A, "/fern/?tab=videos#x")).toBe("https://air.example/fern");
    expect(canonicalUrl(SITE_A, "fern")).toBe("https://air.example/fern");
    expect(canonicalUrl(SITE_A, "/")).toBe("https://air.example/");
    expect(canonicalUrl(SITE_A, "//evil.example/x")).toBe("https://air.example/x");
  });
});

describe("seoHead", () => {
  it("builds the title, Open Graph, the Twitter card and canonical", () => {
    const head = seoHead(SITE_A, {
      title: "Fernsby",
      description: "Painting live",
      path: "/fern",
      image: "https://media.example/banner.jpg",
      type: "video.other",
    });
    // The document title stays the route's own (`titleHead`); `withSeo` puts it first.
    expect(head.meta.some((m) => "title" in m)).toBe(false);
    const merged = withSeo(titleHead("Fernsby"), head);
    expect(merged.meta[0]).toEqual({ title: `Fernsby · ${SITE.name}` });
    expect(merged.meta.slice(1)).toEqual(head.meta);
    expect(merged.links).toEqual(head.links);
    expect(tags(head)).toEqual({
      "og:site_name": "Air A",
      "og:type": "video.other",
      "og:title": "Fernsby",
      "og:url": "https://air.example/fern",
      "og:image": "https://media.example/banner.jpg",
      "twitter:card": "summary_large_image",
      "twitter:title": "Fernsby",
      description: "Painting live",
      "og:description": "Painting live",
      "twitter:description": "Painting live",
      "link:canonical": "https://air.example/fern",
    });
  });
  it("without a still: the app icon and the small card; without a description: none", () => {
    const t2 = tags(seoHead(SITE_A, { title: "x", path: "/p", image: "javascript:x" }));
    expect(t2["og:image"]).toBe(`https://air.example${FALLBACK_IMAGE_PATH}`);
    expect(t2["twitter:card"]).toBe("summary");
    expect(t2["og:type"]).toBe("website");
    expect(t2["og:description"]).toBeUndefined();
    expect(t2.description).toBeUndefined();
  });
  it("an empty title falls back to the instance name", () => {
    expect(tags(seoHead(SITE_A, { title: " ", path: "/" }))["og:title"]).toBe("Air A");
  });
});

type Head = (ctx: unknown) => { meta?: unknown[]; links?: unknown[] };
const headOf = (route: { options: object }) => (route.options as { head: Head }).head;

function channelPage(over: { mature?: boolean; banner?: string | null; suspended?: boolean; live?: boolean } = {}) {
  return {
    summary: {
      id: "c1",
      slug: "fern",
      displayName: "Fernsby",
      title: "Cozy channel",
      avatarUrl: "https://media.example/avatar.png",
      accent: null,
      mature: over.mature ?? false,
      live:
        over.live === false
          ? null
          : {
              id: "b1",
              title: "Painting live",
              viewerCount: 3,
              catchingUpCount: 0,
              startedAt: "2026-11-06T10:00:00.000Z",
              mature: false,
              restricted: null,
            },
      followerCount: 1,
      category: null,
      tags: [],
      lastLiveAt: null,
      following: null,
      movedTo: null,
    },
    extras: {
      bannerUrl: over.banner === undefined ? "https://media.example/banner.jpg" : over.banner,
      panels: [],
      suspended: over.suspended ?? false,
    },
    about: { bio: "I paint rivers.", socials: [] },
    vods: null,
    clips: null,
  } as unknown as ChannelPage;
}

const { Route: Channel } = await import("../src/routes/_app/$channel.tsx");
const { Route: Vod } = await import("../src/routes/_app/$channel_.vods.$vodId.tsx");
const { Route: Clip } = await import("../src/routes/_app/$channel_.clips.$clipId.tsx");
const { Route: Proposal } = await import("../src/routes/_app/coop.proposals.$id.index.tsx");

describe("route heads", () => {
  it("channel: the live title, the banner, video type, canonical on the instance", () => {
    const head = headOf(Channel)({ params: { channel: "fern" }, loaderData: channelPage(), matches: [ROOT] });
    expect(head.meta?.[0]).toEqual({ title: `${t("pageTitle.channelLive", { name: "Fernsby" })} · ${SITE.name}` });
    const out = tags(head);
    expect(out["og:title"]).toBe(t("pageTitle.channelLive", { name: "Fernsby" }));
    expect(out["og:description"]).toBe("Painting live");
    expect(out["og:image"]).toBe("https://media.example/banner.jpg");
    expect(out["og:type"]).toBe("video.other");
    expect(out["link:canonical"]).toBe("https://air.example/fern");
    expect(out["og:site_name"]).toBe("Air A");
  });

  it("channel offline: the bio, the avatar without a banner, website type", () => {
    const out = tags(
      headOf(Channel)({
        params: { channel: "fern" },
        loaderData: channelPage({ live: false, banner: null }),
        matches: [ROOT],
      }),
    );
    expect(out["og:description"]).toBe("I paint rivers.");
    expect(out["og:image"]).toBe("https://media.example/avatar.png");
    expect(out["og:type"]).toBe("website");
  });

  it("a mature channel's preview has no image of its own; a suspended channel only a title", () => {
    const mature = tags(
      headOf(Channel)({ params: { channel: "fern" }, loaderData: channelPage({ mature: true }), matches: [ROOT] }),
    );
    expect(mature["og:image"]).toBe(`https://air.example${FALLBACK_IMAGE_PATH}`);
    expect(mature["twitter:card"]).toBe("summary");
    const suspended = headOf(Channel)({
      params: { channel: "fern" },
      loaderData: channelPage({ suspended: true }),
      matches: [ROOT],
    });
    expect(tags(suspended)).toEqual({});
    expect(headOf(Channel)({ params: { channel: "fern" } }).meta).toEqual([{ title: `fern · ${SITE.name}` }]);
  });

  it("VOD and clip: the item's title, a line naming the channel, the item's own URL", () => {
    const ok = { kind: "ok", title: "Tuesday build", channelName: "Rivertide" };
    const vod = tags(headOf(Vod)({ params: { channel: "rivertide", vodId: "v1" }, loaderData: ok, matches: [ROOT] }));
    expect(vod["og:title"]).toBe("Tuesday build · Rivertide");
    expect(vod["og:description"]).toBe(t("fixWeb.seo.vod", { channel: "Rivertide" }));
    expect(vod["og:type"]).toBe("video.other");
    expect(vod["link:canonical"]).toBe("https://air.example/rivertide/vods/v1");
    const clip = tags(
      headOf(Clip)({ params: { channel: "rivertide", clipId: "c1" }, loaderData: ok, matches: [ROOT] }),
    );
    expect(clip["og:description"]).toBe(t("fixWeb.seo.clip", { channel: "Rivertide" }));
    expect(clip["link:canonical"]).toBe("https://air.example/rivertide/clips/c1");
  });

  it("a missing VOD or clip gets no preview, only its not-available title", () => {
    expect(
      tags(headOf(Vod)({ params: { channel: "r", vodId: "v" }, loaderData: { kind: "missing" }, matches: [ROOT] })),
    ).toEqual({});
    expect(
      tags(headOf(Clip)({ params: { channel: "r", clipId: "c" }, loaderData: { kind: "error" }, matches: [ROOT] })),
    ).toEqual({});
  });

  it("proposal: a generic line with the instance name and the proposal's URL", () => {
    const out = tags(headOf(Proposal)({ params: { id: "p1" }, matches: [ROOT] }));
    expect(out["og:title"]).toBe(t("pageTitle.coopProposal"));
    expect(out["og:description"]).toBe(t("fixWeb.seo.proposal", { site: "Air A" }));
    expect(out["og:type"]).toBe("article");
    expect(out["link:canonical"]).toBe("https://air.example/coop/proposals/p1");
  });
});
