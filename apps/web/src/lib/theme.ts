// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isTheme, type Theme } from "@commonair/ui";
import { preferencesAllowed } from "./consent.ts";

/** Theme choice lives in a first-party cookie so the server renders the right `data-theme`. */
export const THEME_COOKIE = "commonair-theme";
/** `sessionStorage` key of a tab-only theme (no Preferences consent). */
export const THEME_SESSION_KEY = "commonair-theme";
const YEAR_SECONDS = 365 * 86_400;

export function themeFromCookie(cookie: string | undefined | null): Theme {
  for (const part of (cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === THEME_COOKIE && isTheme(value)) return value;
  }
  return "dark";
}

/** The theme cookie's value, if it holds a valid theme (no default). */
export function themeCookieValue(cookie: string | undefined | null): Theme | undefined {
  for (const part of (cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === THEME_COOKIE && isTheme(value)) return value;
  }
  return undefined;
}

export function writeThemeCookie(theme: Theme): void {
  try {
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${YEAR_SECONDS}; samesite=lax`;
  } catch {
    // Cookies blocked: the theme applies to this page only.
  }
}

export function expireThemeCookie(): void {
  try {
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax`;
  } catch {
    // Cookies blocked: there is nothing to expire.
  }
}

/** The tab-only theme, if any. */
export function tabTheme(): Theme | undefined {
  try {
    const value = sessionStorage.getItem(THEME_SESSION_KEY);
    return isTheme(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function setTabTheme(theme: Theme): void {
  try {
    sessionStorage.setItem(THEME_SESSION_KEY, theme);
  } catch {
    // Storage blocked: the theme lasts until the next load.
  }
}

/** The tab-only theme, removed from the tab (it is moving into the cookie). */
export function takeTabTheme(): Theme | undefined {
  const theme = tabTheme();
  try {
    sessionStorage.removeItem(THEME_SESSION_KEY);
  } catch {
    // Storage blocked: nothing to remove.
  }
  return theme;
}

/**
 * Keep the visitor's theme: in the Preferences cookie with consent, otherwise for this tab only
 * (and any old cookie expires, so the next visit uses the default).
 */
export function storeTheme(theme: Theme): void {
  if (preferencesAllowed()) {
    // Drop any tab-only theme too: the root prefers it over the cookie on every load.
    takeTabTheme();
    writeThemeCookie(theme);
    return;
  }
  setTabTheme(theme);
  expireThemeCookie();
}
