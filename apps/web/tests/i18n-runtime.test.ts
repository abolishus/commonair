// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The runtime catalog (ADR 0029): English outside a request, per-key fallback, `en-XA`, `UiMessages`. */
import { pickLocale } from "@commonair/i18n";
import { enMessages } from "@commonair/ui/lib/messages";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createLocaleRegistry } from "../src/i18n/catalogs.ts";
import {
  SUPPORTED_LOCALES,
  activeLocale,
  baseLanguage,
  loadLocale,
  registry,
  setClientTranslator,
  t,
  uiMessagesFor,
} from "../src/i18n/index.ts";

afterEach(() => {
  setClientTranslator(registry.englishTranslator);
});

describe("t() and activeLocale()", () => {
  it("is English outside a request", () => {
    expect(activeLocale()).toBe("en");
    expect(t("nav.signIn")).toBe("Sign in");
    expect(t("home.title", { name: "Test Air" })).toBe("Welcome to Test Air");
  });

  it("follows the client translator once one is set", async () => {
    setClientTranslator(await loadLocale("en-XA"));
    expect(activeLocale()).toBe("en-XA");
    expect(t("nav.signIn")).toMatch(/^\[Šîĝñ îñ~+\]$/);
  });

  it("ships English and en-XA, with no other locale yet", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "en-XA"]);
  });
});

describe("en-XA", () => {
  it("pseudo-localizes every message, keeping placeholders and plurals working", async () => {
    const xa = await loadLocale("en-XA");
    expect(xa.locale).toBe("en-XA");
    expect(xa.t("home.title", { name: "Test Air" })).toMatch(/^\[Ŵéļçöɱé ţö Test Air~+\]$/);
    expect(xa.t("follow.count", { count: 1234 })).toMatch(/^\[1,234 ƒöļļöŵéŕš~+\]$/);
    expect(xa.t("follow.count", { count: 1 })).toMatch(/^\[1 ƒöļļöŵéŕ~+\]$/);
    expect(xa.t("legal.version", {})).toMatch(/\{version\}/);
    // Built once, then cached.
    expect(await loadLocale("en-XA")).toBe(xa);
  });

  it("gives an unsupported tag English", async () => {
    expect((await loadLocale("fr")).locale).toBe("en");
  });

  it("pseudo-localizes UiMessages, the viewer count function too", () => {
    const xa = uiMessagesFor("en-XA");
    expect(xa.close).toMatch(/^\[Çļöšé~+\]$/);
    expect(xa.theme.dark).toMatch(/^\[Ðåŕķ~+\]$/);
    expect(xa.discoveryReason.new).toMatch(/^\[Ñéŵ šţŕéåɱéŕ~+\]$/);
    expect(xa.viewerCount("1,234", 1234)).toMatch(/^\[1,234 ṽéŕîƒîéð ṽîéŵéŕš~+\]$/);
    expect(xa.viewerCount("1", 1)).toMatch(/^\[1 ṽéŕîƒîéð ṽîéŵéŕ~+\]$/);
    expect(uiMessagesFor("en-XA")).toBe(xa);
    expect(uiMessagesFor("en")).toBe(enMessages);
    expect(uiMessagesFor("es")).toBe(enMessages);
  });

  it("maps to a real language for third-party widgets", () => {
    expect(baseLanguage("en-XA")).toBe("en");
    expect(baseLanguage("pt-BR")).toBe("pt");
    expect(baseLanguage("es")).toBe("es");
    expect(baseLanguage("")).toBe("en");
  });
});

describe("a locale added as JSON files only", () => {
  const english = {
    "./locales/en/core.json": { "app.title": "Title", "nav.signIn": "Sign in", "follow.count": "{count} f" },
    "./locales/en/ops.json": { "overlay.chatTitle": "Chat" },
  };
  let loads = 0;
  const lazy = {
    "./locales/es/core.json": async () => {
      loads++;
      return { "app.title": "Título", "follow.count": "{count, plural, one {# seguidor} other {# seguidores}}" };
    },
    "./locales/es/ops.json": async () => ({}),
    "./locales/en-XA/core.json": async () => ({ "app.title": "never loaded" }),
  };

  it("is supported and negotiable with no code change", () => {
    const reg = createLocaleRegistry({ english, lazy });
    expect(reg.supported).toEqual(["en", "es", "en-XA"]);
    expect(pickLocale({ acceptLanguage: "es-MX,es;q=0.9", instanceDefault: "en", supported: reg.supported })).toBe(
      "es",
    );
    expect(reg.peek("es")).toBeUndefined();
  });

  it("loads once and falls back to English per key", async () => {
    const missing: string[] = [];
    const reg = createLocaleRegistry({ english, lazy, onMissing: (locale, key) => missing.push(`${locale}:${key}`) });
    loads = 0;
    const [es, again] = await Promise.all([reg.load("es"), reg.load("es")]);
    expect(es).toBe(again);
    expect(loads).toBe(1);
    expect(reg.peek("es")).toBe(es);
    expect(es.t("app.title")).toBe("Título");
    expect(es.t("nav.signIn")).toBe("Sign in");
    expect(es.t("follow.count", { count: 2 })).toBe("2 seguidores");
    expect(es.t("overlay.chatTitle")).toBe("Chat");
    expect(missing).toEqual(["es:nav.signIn", "es:overlay.chatTitle"]);
  });

  it("gives English when a locale's chunk fails to load, and retries later", async () => {
    let fail = true;
    const reg = createLocaleRegistry({
      english,
      lazy: {
        "./locales/es/core.json": async () => {
          if (fail) throw new Error("chunk");
          return { "app.title": "Título" };
        },
      },
    });
    expect((await reg.load("es")).locale).toBe("en");
    fail = false;
    expect((await reg.load("es")).t("app.title")).toBe("Título");
  });
});
