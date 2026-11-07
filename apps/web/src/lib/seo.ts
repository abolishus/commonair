// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Link-preview tags (F13): Open Graph, the Twitter card and the canonical link for the public
 * pages people share (channel, VOD, clip, proposal). The instance's name and public URL come from
 * `instanceSite()` on the server, handed to every page as the root loader's `config`; a route's
 * `head()` reads them from its matches, so one image serves any instance. No third-party tags:
 * these are plain `<meta>`/`<link>` elements that a crawler reads, nothing is loaded.
 */
import { SITE, type InstanceSite } from "@commonair/config/site";

export type SeoSite = Pick<InstanceSite, "name" | "publicUrl">;

export type SeoType = "website" | "profile" | "video.other" | "article";

export interface SeoPage {
  /** The page's own title, without the site name (`og:title`; the document title adds it). */
  title: string;
  description?: string | null;
  /** The page's path on this instance (`/name`, `/name/clips/id`); a query or hash is dropped. */
  path: string;
  /** A still for the preview (absolute, or relative to the instance); the app icon otherwise. */
  image?: string | null;
  type?: SeoType;
}

export type SeoMeta = { title: string } | { name: string; content: string } | { property: string; content: string };

export interface SeoHead {
  meta: SeoMeta[];
  links: { rel: string; href: string }[];
}

/** Longest `og:description` kept: previews cut around 200 characters anyway. */
export const DESCRIPTION_MAX = 200;

/** The app icon, the preview image when a page has no still of its own (`public/icons`). */
export const FALLBACK_IMAGE_PATH = "/icons/icon-512.png";

const ROOT_ROUTE_ID = "__root__";

const noSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * The instance from a `head()`'s matches: the root loader's `config` (`publicConfig`, built from
 * `instanceSite()`). Before the root has loaded (or in a test without it) the project defaults.
 */
export function siteFromMatches(matches: readonly { routeId?: string; loaderData?: unknown }[] | undefined): SeoSite {
  const root = matches?.find((m) => m.routeId === ROOT_ROUTE_ID) ?? matches?.[0];
  const data = root?.loaderData;
  if (typeof data === "object" && data !== null && "config" in data) {
    const config = (data as { config: unknown }).config;
    if (typeof config === "object" && config !== null) {
      const { instanceName, publicUrl } = config as { instanceName?: unknown; publicUrl?: unknown };
      if (typeof publicUrl === "string" && publicUrl !== "")
        return {
          name: typeof instanceName === "string" && instanceName !== "" ? instanceName : SITE.name,
          publicUrl: noSlash(publicUrl),
        };
    }
  }
  return { name: SITE.name, publicUrl: SITE.url };
}

/** Whitespace collapsed and cut at a word near `max`, with an ellipsis; null when empty. */
export function previewText(text: string | null | undefined, max = DESCRIPTION_MAX): string | null {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** An absolute http(s) URL on any origin, or a path resolved on the instance; null otherwise. */
export function absoluteUrl(site: SeoSite, value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, `${site.publicUrl}/`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The canonical URL of `path` on the instance: no query, no hash, no trailing slash but the root. */
export function canonicalUrl(site: SeoSite, path: string): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${site.publicUrl}/`);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${new URL(site.publicUrl).origin}${pathname}`;
}

/** The preview tags for a page (no document title: the route's `titleHead` keeps that). */
export function seoHead(site: SeoSite, page: SeoPage): SeoHead {
  const url = canonicalUrl(site, page.path);
  const description = previewText(page.description);
  const still = absoluteUrl(site, page.image);
  const image = still ?? `${site.publicUrl}${FALLBACK_IMAGE_PATH}`;
  const title = page.title.trim() || site.name;
  const meta: SeoMeta[] = [
    { property: "og:site_name", content: site.name },
    { property: "og:type", content: page.type ?? "website" },
    { property: "og:title", content: title },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    // A still gets the large card; the square app icon the small one.
    { name: "twitter:card", content: still ? "summary_large_image" : "summary" },
    { name: "twitter:title", content: title },
  ];
  if (description) {
    meta.push({ name: "description", content: description });
    meta.push({ property: "og:description", content: description });
    meta.push({ name: "twitter:description", content: description });
  }
  return { meta, links: [{ rel: "canonical", href: url }] };
}

/** A route's `titleHead(...)` with the preview tags after its title. */
export function withSeo(head: { meta: { title: string }[] }, seo: SeoHead): SeoHead {
  return { meta: [...head.meta, ...seo.meta], links: seo.links };
}
