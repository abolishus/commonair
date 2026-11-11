// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web app manifest (ADR 0028 decision 7, README D7.6), named from the instance (AGENTS.md
 * rule 5): one image serves every instance, so it is built per request rather than shipped as a
 * static file. Its words come from the `d7-pwa` catalogs, in the language the caller passes.
 * Production: `server/http.ts` (`/manifest.webmanifest`); dev: `scripts/vite-pwa.ts`. Dev passes
 * the request's `Accept-Language`; production does once `server.ts` hands the request to its
 * `manifest` option (until then it answers in English).
 */
import { localeDirection, parseAcceptLanguage } from "@commonair/i18n";
import { pwaLocale, pwaText } from "../components/pwa/pwa-text.ts";
import { PWA_ICONS } from "../pwa/icons.ts";
import { PWA_THEME_COLORS } from "../pwa/theme.ts";
import type { PublicConfig } from "./env.ts";

export const MANIFEST_CONTENT_TYPE = "application/manifest+json";

export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: "any" | "maskable";
}

export interface WebManifestShortcut {
  name: string;
  short_name: string;
  url: string;
  icons: WebManifestIcon[];
}

export interface WebManifestScreenshot {
  src: string;
  sizes: string;
  type: string;
  form_factor: "narrow" | "wide";
  label: string;
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: "ltr" | "rtl";
  start_url: string;
  scope: string;
  display: "standalone";
  categories: string[];
  background_color: string;
  theme_color: string;
  icons: WebManifestIcon[];
  shortcuts: WebManifestShortcut[];
  screenshots: WebManifestScreenshot[];
}

/**
 * The install sheet's screenshots in `public/screenshots/` (PNGs rendered from the SVG art beside
 * them), at the sizes `responsive-a11y.md` P10 asks for: a phone (narrow) and a desktop (wide).
 */
export const PWA_SCREENSHOTS = {
  narrow: { src: "/screenshots/narrow.png", width: 750, height: 1334 },
  wide: { src: "/screenshots/wide.png", width: 1440, height: 900 },
} as const;

/** The app's long-press shortcuts: where a returning viewer or creator goes first. */
export const PWA_SHORTCUTS = [
  { key: "d7Pwa.shortcut.following", url: "/following" },
  { key: "d7Pwa.shortcut.browse", url: "/directory" },
  { key: "d7Pwa.shortcut.studio", url: "/dashboard" },
  { key: "d7Pwa.shortcut.inbox", url: "/inbox" },
] as const;

const sizes = (shot: { width: number; height: number }) => `${shot.width}x${shot.height}`;

/**
 * The manifest for an instance, in the best bundled locale for `languages` (best first), English
 * when none match.
 */
export function webManifest(
  config: Pick<PublicConfig, "instanceName">,
  languages: readonly string[] = [],
): WebManifest {
  const lang = pwaLocale(languages);
  const shortcutIcon: WebManifestIcon = { src: PWA_ICONS.icon192, sizes: "192x192", type: "image/png" };
  return {
    id: "/",
    name: config.instanceName,
    short_name: config.instanceName,
    description: pwaText("d7Pwa.manifest.description", lang, { site: config.instanceName }),
    lang,
    dir: localeDirection(lang),
    start_url: "/",
    scope: "/",
    display: "standalone",
    categories: ["entertainment", "social"],
    // Dark first (AGENTS.md design rules): the splash and title bar before the page paints.
    background_color: PWA_THEME_COLORS.dark,
    theme_color: PWA_THEME_COLORS.dark,
    icons: [
      { src: PWA_ICONS.svg, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: PWA_ICONS.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: PWA_SHORTCUTS.map(({ key, url }) => {
      const name = pwaText(key, lang);
      return { name, short_name: name, url, icons: [shortcutIcon] };
    }),
    screenshots: [
      {
        src: PWA_SCREENSHOTS.narrow.src,
        sizes: sizes(PWA_SCREENSHOTS.narrow),
        type: "image/png",
        form_factor: "narrow",
        label: pwaText("d7Pwa.screenshot.narrow", lang),
      },
      {
        src: PWA_SCREENSHOTS.wide.src,
        sizes: sizes(PWA_SCREENSHOTS.wide),
        type: "image/png",
        form_factor: "wide",
        label: pwaText("d7Pwa.screenshot.wide", lang),
      },
    ],
  };
}

/**
 * `/manifest.webmanifest` for a request's `Accept-Language` (English without one); the caller adds
 * the cache and security headers. Its words depend on that header, so it says `vary` and a shared
 * cache keeps one copy per language.
 */
export function manifestResponse(config: PublicConfig, acceptLanguage: string | null = null): Response {
  const manifest = webManifest(config, parseAcceptLanguage(acceptLanguage));
  return new Response(JSON.stringify(manifest), {
    headers: { "content-type": MANIFEST_CONTENT_TYPE, "content-language": manifest.lang, vary: "accept-language" },
  });
}
