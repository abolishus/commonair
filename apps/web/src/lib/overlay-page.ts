// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The OBS overlay pages (`/overlay/*`): outside every layout and auth guard, transparent, and
 * with the token kept out of the `Referer` of anything they load.
 */

export const OVERLAY_PATH_PREFIX = "/overlay/";

/** Whether `pathname` is an OBS overlay page (the root then draws no background). */
export function isOverlayPath(pathname: string): boolean {
  return pathname.startsWith(OVERLAY_PATH_PREFIX);
}

/** The root's `<html>` and `<body>` attributes for a page. */
export interface RootChrome {
  htmlClass: string | undefined;
  dataOverlay: "true" | undefined;
  bodyClass: string;
}

/**
 * OBS browser sources composite the page over the stream: on `/overlay/*` nothing may paint a
 * background or a theme colour, so the root drops `bg-background`, `text-foreground` and the
 * theme class there.
 */
export function rootChrome(pathname: string, theme: string): RootChrome {
  if (isOverlayPath(pathname))
    return {
      htmlClass: "bg-transparent",
      dataOverlay: "true",
      bodyClass: "min-h-dvh bg-transparent font-sans antialiased",
    };
  return {
    htmlClass: theme === "light" ? "light" : undefined,
    dataOverlay: undefined,
    bodyClass: "min-h-dvh bg-background font-sans text-foreground antialiased",
  };
}

/** Head tags for an overlay page; they override the root's (deepest route wins per name). */
export function overlayHead(title: string) {
  return {
    meta: [
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex, nofollow" },
      // `normal`: no dark canvas behind a transparent page in OBS.
      { name: "color-scheme", content: "normal" },
      { title },
    ],
  };
}

/** The `token` query parameter of the page URL, or null. */
export function overlayTokenFrom(search: string): string | null {
  const token = new URLSearchParams(search).get("token");
  return token && token.trim() !== "" ? token : null;
}
