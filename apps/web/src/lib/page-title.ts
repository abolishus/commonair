// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SITE } from "@commonair/config/site";

/** Between the page and the site name in `<title>`. */
export const TITLE_SEPARATOR = " · ";

/**
 * A page's document title, "<page> · <site>" (WCAG 2.4.2: tabs and screen readers can tell pages
 * apart). Routes call it from `head()` with an already translated page name; `head()` re-runs on a
 * locale switch (the root invalidates the router), so the title follows the language.
 */
export function pageTitle(page: string): string {
  const name = page.trim();
  return name === "" ? SITE.name : `${name}${TITLE_SEPARATOR}${SITE.name}`;
}

/** The `head()` of a page whose title is just its name. */
export function titleHead(page: string): { meta: { title: string }[] } {
  return { meta: [{ title: pageTitle(page) }] };
}
