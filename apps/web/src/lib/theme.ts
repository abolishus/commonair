// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isTheme, type Theme } from "@commonair/ui";

/** Theme choice lives in a first-party cookie so the server renders the right `data-theme`. */
export const THEME_COOKIE = "commonair-theme";
const YEAR_SECONDS = 365 * 86_400;

export function themeFromCookie(cookie: string | undefined | null): Theme {
  for (const part of (cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === THEME_COOKIE && isTheme(value)) return value;
  }
  return "dark";
}

export function storeTheme(theme: Theme): void {
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${YEAR_SECONDS}; samesite=lax`;
}
