// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The locale in the browser (ADR 0029 decision 3). `src/client.tsx` loads the server's choice
 * (`<html lang>`) before hydrating, so the first client render matches the server's HTML.
 * Switching loads the catalog, updates `<html lang dir>` and remounts the tree under
 * `LocaleProvider` (`t()` is not reactive; local component state is lost, which a language switch
 * may do).
 *
 * N2-core never stores a choice on its own: the switcher calls `rememberLocale` with the
 * visitor's Preferences consent. Without it the choice lives in this tab's `sessionStorage`
 * only; after hydration a supported tab choice that differs from the server's is applied with
 * one remount (`restoreTabLocale`).
 */
import { localeDirection } from "@commonair/i18n";
import { LOCALE_COOKIE } from "./cookie.ts";
import { SUPPORTED_LOCALES, loadLocale, setClientTranslator } from "./index.ts";

export { LOCALE_COOKIE } from "./cookie.ts";
/** `sessionStorage` key of a tab-only choice (no Preferences consent). */
export const LOCALE_SESSION_KEY = "commonair-locale";
const YEAR_SECONDS = 31_536_000;

let remount: ((locale: string) => void) | null = null;

/** The root registers how to remount its tree; returns the unregister function. */
export function onLocaleApplied(fn: (locale: string) => void): () => void {
  remount = fn;
  return () => {
    if (remount === fn) remount = null;
  };
}

/** Before hydration: make `t()` render in the server's locale. */
export async function bootClientLocale(tag: string): Promise<void> {
  setClientTranslator(await loadLocale(tag || "en"));
}

/** Load `tag`'s catalog, make it active, update `<html lang dir>` and remount the tree. */
export async function applyLocale(tag: string): Promise<void> {
  const translator = await loadLocale(tag);
  setClientTranslator(translator);
  const root = document.documentElement;
  root.lang = translator.locale;
  root.dir = localeDirection(translator.locale);
  remount?.(translator.locale);
}

/**
 * Keep a language choice: in the Preferences cookie when the visitor allows it, else for this tab
 * only. Signed-in members also save it with `me.update({ locale })` (the caller's job).
 */
export function rememberLocale(tag: string, opts: { preferencesAllowed: boolean }): void {
  if (opts.preferencesAllowed) {
    try {
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(tag)}; path=/; max-age=${YEAR_SECONDS}; samesite=lax`;
    } catch {
      // Cookies blocked: the choice still applies to this page.
    }
    try {
      sessionStorage.removeItem(LOCALE_SESSION_KEY);
    } catch {
      // Storage blocked: nothing to clear.
    }
    return;
  }
  try {
    sessionStorage.setItem(LOCALE_SESSION_KEY, tag);
  } catch {
    // Storage blocked (private mode, sandboxed frame): the choice lasts until the next load.
  }
}

/** Expire the cookie (Preferences withdrawn); N2-consent moves the choice to the tab. */
export function forgetLocaleCookie(): void {
  try {
    document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax`;
  } catch {
    // Cookies blocked: there is nothing to expire.
  }
}

/** The tab-only choice, if it names a supported locale. */
export function tabLocale(): string | undefined {
  try {
    const tag = sessionStorage.getItem(LOCALE_SESSION_KEY);
    return tag && SUPPORTED_LOCALES.includes(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** After hydration: apply the tab's choice when it differs from what the server rendered. */
export async function restoreTabLocale(serverLocale: string): Promise<void> {
  const tag = tabLocale();
  if (tag && tag !== serverLocale) await applyLocale(tag);
}
