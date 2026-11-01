// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Right-to-left from the start (ADR 0029 decision 5): Arabic is not shipped yet (batch 5
 * decision (b)), so a registry with an injected `ar` fixture stands in for `locales/ar/`. Adding
 * Arabic later is only a catalog: direction follows the locale on the server and in the browser.
 */
import { localeDirection } from "@commonair/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createLocaleRegistry } from "../src/i18n/catalogs.ts";

const fixture = createLocaleRegistry({
  english: { "./locales/en/nav.json": { "nav.home": "Home" } },
  lazy: {
    "./locales/ar/nav.json": () => Promise.resolve({ "nav.home": "الرئيسية" }),
    "./locales/es/nav.json": () => Promise.resolve({ "nav.home": "Inicio" }),
  },
});

// The browser path loads through `loadLocale`; point it at the fixture.
vi.mock("../src/i18n/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/i18n/index.ts")>();
  return { ...actual, loadLocale: (tag: string) => fixture.load(tag) };
});

const { applyLocale } = await import("../src/i18n/client.ts");
const { negotiateRequest } = await import("../src/i18n/server.ts");
const { registry, setClientTranslator } = await import("../src/i18n/index.ts");

const deps = {
  fetchMe: () => Promise.reject(new Error("signed out")),
  instanceDefault: "en",
  locales: fixture,
};

async function serverLocale(headers: Record<string, string>): Promise<string> {
  // Not happy-dom's Request: a browser Request drops the forbidden `cookie` header.
  const all = new Map(Object.entries({ accept: "text/html", ...headers }));
  const request = { method: "GET", headers: { get: (name: string) => all.get(name) ?? null } } as unknown as Request;
  return (await negotiateRequest(request, { document: true, deps })).locale;
}

beforeEach(() => {
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});

afterEach(() => {
  setClientTranslator(registry.englishTranslator);
});

describe("direction", () => {
  it("is rtl for ar and its regions, ltr for en, es and the pseudo-locale", () => {
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("ar-EG")).toBe("rtl");
    for (const tag of ["en", "es", "es-MX", "en-XA"]) expect(localeDirection(tag)).toBe("ltr");
  });

  it("the fixture registry serves ar beside en and es", async () => {
    expect(fixture.supported).toEqual(["en", "ar", "es", "en-XA"]);
    expect((await fixture.load("ar")).t("nav.home" as never)).toBe("الرئيسية");
  });
});

describe("server: the document's lang and dir", () => {
  it("negotiates ar from the cookie and from Accept-Language, ar-EG falling back to ar", async () => {
    expect(await serverLocale({ cookie: "commonair-locale=ar" })).toBe("ar");
    expect(await serverLocale({ "accept-language": "ar-EG,ar;q=0.9" })).toBe("ar");
    expect(await serverLocale({ "accept-language": "ar-EG" })).toBe("ar");
    // The root renders <html lang={locale} dir={localeDirection(locale)}>.
    expect(localeDirection(await serverLocale({ "accept-language": "ar-EG" }))).toBe("rtl");
  });

  it("keeps en and es left-to-right", async () => {
    expect(localeDirection(await serverLocale({ "accept-language": "es-MX" }))).toBe("ltr");
    expect(localeDirection(await serverLocale({}))).toBe("ltr");
  });
});

describe("browser: applyLocale sets <html lang dir>", () => {
  it("ar sets rtl, and switching back to en or es restores ltr", async () => {
    const root = document.documentElement;
    await applyLocale("ar");
    expect([root.lang, root.dir]).toEqual(["ar", "rtl"]);
    await applyLocale("es");
    expect([root.lang, root.dir]).toEqual(["es", "ltr"]);
    await applyLocale("ar");
    await applyLocale("en");
    expect([root.lang, root.dir]).toEqual(["en", "ltr"]);
  });
});
