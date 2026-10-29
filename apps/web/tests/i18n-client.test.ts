// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The browser side of the locale (ADR 0029 decision 3): the choice is a Preferences cookie only
 * with consent, else tab-only; switching sets `<html lang dir>` and remounts; blocked storage
 * never breaks the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  LOCALE_COOKIE,
  LOCALE_SESSION_KEY,
  applyLocale,
  bootClientLocale,
  forgetLocaleCookie,
  onLocaleApplied,
  rememberLocale,
  restoreTabLocale,
  tabLocale,
} from "../src/i18n/client.ts";
import { activeLocale, registry, setClientTranslator, t } from "../src/i18n/index.ts";

function cookieValue(): string | undefined {
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
}

beforeEach(() => {
  forgetLocaleCookie();
  sessionStorage.clear();
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});

afterEach(() => {
  vi.restoreAllMocks();
  setClientTranslator(registry.englishTranslator);
});

describe("rememberLocale", () => {
  it("names the cookie and the tab key", () => {
    expect(LOCALE_COOKIE).toBe("commonair-locale");
    expect(LOCALE_SESSION_KEY).toBeTruthy();
  });

  it("writes the cookie only with Preferences consent, and clears a tab choice", () => {
    sessionStorage.setItem(LOCALE_SESSION_KEY, "en");
    rememberLocale("en-XA", { preferencesAllowed: true });
    expect(cookieValue()).toBe("en-XA");
    expect(sessionStorage.getItem(LOCALE_SESSION_KEY)).toBeNull();
  });

  it("keeps the choice in this tab without consent, and writes no cookie", () => {
    rememberLocale("en-XA", { preferencesAllowed: false });
    expect(cookieValue()).toBeUndefined();
    expect(sessionStorage.getItem(LOCALE_SESSION_KEY)).toBe("en-XA");
    expect(tabLocale()).toBe("en-XA");
  });

  it("forgetLocaleCookie expires the cookie", () => {
    rememberLocale("en-XA", { preferencesAllowed: true });
    expect(cookieValue()).toBe("en-XA");
    forgetLocaleCookie();
    expect(cookieValue()).toBeUndefined();
  });

  it("survives storage and cookies that throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      set: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(() => rememberLocale("en-XA", { preferencesAllowed: false })).not.toThrow();
      expect(() => rememberLocale("en-XA", { preferencesAllowed: true })).not.toThrow();
      expect(() => forgetLocaleCookie()).not.toThrow();
      expect(tabLocale()).toBeUndefined();
    } finally {
      // Back to the prototype's accessor.
      delete (document as unknown as Record<string, unknown>).cookie;
    }
  });
});

describe("applyLocale", () => {
  it("loads the catalog, sets <html lang dir> and remounts", async () => {
    const remounts: string[] = [];
    const off = onLocaleApplied((locale) => remounts.push(locale));
    await applyLocale("en-XA");
    expect(document.documentElement.lang).toBe("en-XA");
    expect(document.documentElement.dir).toBe("ltr");
    expect(activeLocale()).toBe("en-XA");
    expect(t("nav.signIn")).toMatch(/^\[Šîĝñ îñ~+\]$/);
    expect(remounts).toEqual(["en-XA"]);
    off();
    await applyLocale("en");
    expect(document.documentElement.lang).toBe("en");
    expect(t("nav.signIn")).toBe("Sign in");
    expect(remounts).toEqual(["en-XA"]);
  });

  it("falls back to English for an unsupported tag", async () => {
    await applyLocale("xx");
    expect(document.documentElement.lang).toBe("en");
    expect(activeLocale()).toBe("en");
  });
});

describe("boot and tab restore", () => {
  it("boots in the server's locale before hydration", async () => {
    await bootClientLocale("en-XA");
    expect(activeLocale()).toBe("en-XA");
    await bootClientLocale("");
    expect(activeLocale()).toBe("en");
  });

  it("applies a supported tab choice that differs from the server's, once", async () => {
    const remounts: string[] = [];
    const off = onLocaleApplied((locale) => remounts.push(locale));
    sessionStorage.setItem(LOCALE_SESSION_KEY, "en-XA");
    await restoreTabLocale("en");
    expect(remounts).toEqual(["en-XA"]);
    await restoreTabLocale("en-XA");
    expect(remounts).toEqual(["en-XA"]);
    sessionStorage.setItem(LOCALE_SESSION_KEY, "klingon");
    await restoreTabLocale("en");
    expect(remounts).toEqual(["en-XA"]);
    off();
  });
});
