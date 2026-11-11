// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The offline page the service worker answers a failed navigation with (README D7.6). */
import { describe, expect, it } from "vite-plus/test";
import { pwaLocale, pwaText } from "../src/components/pwa/pwa-text.ts";
import en from "../src/i18n/locales/en/d7-pwa.json" with { type: "json" };
import es from "../src/i18n/locales/es/d7-pwa.json" with { type: "json" };
import { PWA_ICONS } from "../src/pwa/icons.ts";
import {
  OFFLINE_HEADERS,
  OFFLINE_LINKS,
  type OfflineTheme,
  escapeHtml,
  offlineDocument,
  offlineResponse,
  retryHref,
} from "../src/sw/offline.ts";

const ORIGIN = "https://air.example";
const THEME: OfflineTheme = {
  dark: {
    background: "oklch(0.141 0.005 285.823)",
    foreground: "oklch(0.985 0 0)",
    mutedForeground: "oklch(0.74 0.015 286.067)",
    border: "oklch(1 0 0 / 10%)",
    primary: "oklch(0.92 0.004 286.32)",
    primaryForeground: "oklch(0.21 0.006 285.885)",
    ring: "oklch(0.705 0.015 286.067)",
  },
  light: {
    background: "oklch(1 0 0)",
    foreground: "oklch(0.141 0.005 285.823)",
    mutedForeground: "oklch(0.5 0.016 285.938)",
    border: "oklch(0.92 0.004 286.32)",
    primary: "oklch(0.21 0.006 285.885)",
    primaryForeground: "oklch(0.985 0 0)",
    ring: "oklch(0.552 0.016 285.938)",
  },
};

const page = (languages: readonly string[] = ["en-US"], requestUrl = `${ORIGIN}/somebody`) =>
  offlineDocument({ languages, theme: THEME, requestUrl, origin: ORIGIN });

describe("offline page", () => {
  it("shows the brand mark, You're offline, Retry and the public pages", () => {
    const html = page();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<img src="${PWA_ICONS.svg}"`);
    expect(html).toContain(`<title>${escapeHtml(en["d7Pwa.offline.title"])}</title>`);
    expect(html).toContain(`<h1>${escapeHtml(en["d7Pwa.offline.title"])}</h1>`);
    expect(html).toContain(escapeHtml(en["d7Pwa.offline.body"]));
    expect(html).toContain(`href="/somebody">${en["d7Pwa.offline.retry"]}</a>`);
    for (const link of OFFLINE_LINKS) expect(html).toContain(`<a href="${link.href}">${en[link.key]}</a>`);
    expect(html).toContain('data-testid="pwa-offline"');
    expect(html).toContain('data-testid="pwa-offline-retry"');
  });

  it("speaks the browser's language, falling back to English", () => {
    const spanish = page(["es-MX", "en"]);
    expect(spanish).toContain('<html lang="es" dir="ltr">');
    expect(spanish).toContain(`<h1>${escapeHtml(es["d7Pwa.offline.title"])}</h1>`);
    expect(spanish).toContain(`>${es["d7Pwa.offline.retry"]}</a>`);
    expect(page(["fr-FR"])).toContain('<html lang="en" dir="ltr">');
    expect(page([])).toContain('<html lang="en"');
  });

  it("paints with the tokens: dark first, light where the system asks", () => {
    const html = page();
    expect(html).toContain(`:root{color-scheme:dark;--bg:${THEME.dark.background}`);
    expect(html).toContain(
      `@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:${THEME.light.background}`,
    );
    expect(html).toContain(`--border:${THEME.dark.border}`);
    // A visible focus ring and 44 px targets, as in the app; no script at all.
    expect(html).toContain("a:focus-visible{outline:2px solid var(--ring)");
    expect(html).toContain("min-height:2.75rem");
    expect(html).not.toContain("<script");
  });

  it("drops a colour value that could break out of the style sheet", () => {
    const evil = { ...THEME, dark: { ...THEME.dark, background: "red}</style><script>x()</script>" } };
    const html = offlineDocument({ languages: ["en"], theme: evil, requestUrl: `${ORIGIN}/`, origin: ORIGIN });
    expect(html).toContain("--bg:initial");
    expect(html).not.toContain("<script>");
  });

  it("retries the failed page itself, escaped, and never another origin", () => {
    expect(retryHref(`${ORIGIN}/somebody?tab=videos`, ORIGIN)).toBe("/somebody?tab=videos");
    expect(retryHref("https://evil.example/x", ORIGIN)).toBe("/");
    expect(retryHref("not a url", ORIGIN)).toBe("/");
    const html = page(["en"], `${ORIGIN}/search?q="><img src=x onerror=alert(1)>`);
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).not.toMatch(/href="[^"]*"[^>]*><img src=x/);
  });

  it("holds nothing personal: the same page for every viewer of a URL", () => {
    // Built from the URL, the languages and the tokens only: no cookie, session or API answer.
    expect(page(["en"])).toBe(page(["en"]));
    expect(page(["en"])).not.toMatch(/token|session|cookie|api\//i);
  });

  it("goes out as a 503 that nothing stores, with a strict CSP", async () => {
    const res = offlineResponse({ languages: ["en"], theme: THEME, requestUrl: `${ORIGIN}/`, origin: ORIGIN });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    expect(Object.keys(OFFLINE_HEADERS)).toContain("x-content-type-options");
    expect(await res.text()).toContain("<h1>");
  });

  it("escapes every HTML-special character", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("pwa strings", () => {
  it("picks a bundled locale and formats arguments", () => {
    expect(pwaLocale(["es-AR"])).toBe("es");
    expect(pwaLocale(["de"])).toBe("en");
    expect(pwaText("d7Pwa.install.menu", "en", { site: "Riverside" })).toBe("Install Riverside");
    expect(pwaText("d7Pwa.install.menu", "es", { site: "Riverside" })).toBe("Instalar Riverside");
    expect(pwaText("d7Pwa.offline.retry", "xx")).toBe("Retry");
  });
});
