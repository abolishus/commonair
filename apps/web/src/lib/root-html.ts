// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { localeDirection } from "@commonair/i18n";
import type { Theme } from "@commonair/ui";
import { rootChrome } from "./overlay-page.ts";

/**
 * On `<html>` from the server until React has hydrated. While it is there no transitions run, so
 * a colour that settles during hydration (the header's selected states, inputs' borders) does not
 * fade in after the first paint (F14).
 */
export const HYDRATING_ATTRIBUTE = "data-hydrating";

/** Inline in the head (`style-src 'unsafe-inline'` allows it), so it holds from the first paint. */
export const HYDRATING_CSS = `html[${HYDRATING_ATTRIBUTE}] *, html[${HYDRATING_ATTRIBUTE}] *::before, html[${HYDRATING_ATTRIBUTE}] *::after { transition: none !important; }`;

export interface RootHtmlAttributes {
  lang: string;
  dir: "ltr" | "rtl";
  "data-theme": Theme;
  "data-overlay": "true" | undefined;
  "data-hydrating": "" | undefined;
  className: string | undefined;
}

/**
 * The root's `<html>` attributes, the same on the server and on the hydrating client: the theme
 * comes from the cookie (`boot.theme`), so the first paint is already in the right theme.
 */
export function rootHtmlAttributes(o: {
  locale: string;
  theme: Theme;
  pathname: string;
  hydrating: boolean;
}): RootHtmlAttributes {
  const chrome = rootChrome(o.pathname, o.theme);
  return {
    lang: o.locale,
    dir: localeDirection(o.locale),
    "data-theme": o.theme,
    "data-overlay": chrome.dataOverlay,
    "data-hydrating": o.hydrating ? "" : undefined,
    className: chrome.htmlClass,
  };
}
