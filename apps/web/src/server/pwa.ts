// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web app manifest (ADR 0028 decision 7), named from the instance (AGENTS.md rule 5): one image
 * serves every instance, so it is built per request rather than shipped as a static file.
 * Production: `server/http.ts` (`/manifest.webmanifest`); dev: `scripts/vite-pwa.ts`.
 */
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

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: WebManifestIcon[];
}

export function webManifest(config: Pick<PublicConfig, "instanceName">): WebManifest {
  return {
    id: "/",
    name: config.instanceName,
    short_name: config.instanceName,
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Dark first (AGENTS.md design rules): the splash and title bar before the page paints.
    background_color: PWA_THEME_COLORS.dark,
    theme_color: PWA_THEME_COLORS.dark,
    icons: [
      { src: PWA_ICONS.svg, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: PWA_ICONS.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** `/manifest.webmanifest`; the caller adds the cache and security headers. */
export function manifestResponse(config: PublicConfig): Response {
  return new Response(JSON.stringify(webManifest(config)), {
    headers: { "content-type": MANIFEST_CONTENT_TYPE },
  });
}
