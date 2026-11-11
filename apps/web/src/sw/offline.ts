// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The offline page (README D7.6, responsive-a11y.md P10): what the worker answers when a page
 * navigation fails for want of a network. It is built in the worker from the bundled `d7-pwa`
 * strings and the design tokens' colours (read from the token source at build time by
 * `scripts/vite-pwa.ts`), so nothing is fetched or cached for it, and it holds nothing personal:
 * the brand mark (the precached icon), "You're offline", Retry and the public entry pages.
 * Pure, so it is unit-tested.
 */
import { localeDirection } from "@commonair/i18n";
import { pwaLocale, pwaText } from "../components/pwa/pwa-text.ts";
import { PWA_ICONS } from "../pwa/icons.ts";
import type { OfflinePalette, OfflineTheme } from "./offline-theme.ts";

export type { OfflinePalette, OfflineTheme } from "./offline-theme.ts";

/** The pages linked from the offline page: public entry points, nothing tied to an account. */
export const OFFLINE_LINKS = [
  { key: "d7Pwa.offline.home", href: "/" },
  { key: "d7Pwa.offline.following", href: "/following" },
  { key: "d7Pwa.offline.browse", href: "/directory" },
] as const;

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** A colour value safe inside a `<style>` (token values are build input, but never trusted blindly). */
function cssValue(value: string): string {
  return /^[\w\s#%().,/-]+$/.test(value) ? value : "initial";
}

function palette(p: OfflinePalette): string {
  return [
    `--bg:${cssValue(p.background)}`,
    `--fg:${cssValue(p.foreground)}`,
    `--muted:${cssValue(p.mutedForeground)}`,
    `--border:${cssValue(p.border)}`,
    `--primary:${cssValue(p.primary)}`,
    `--primary-fg:${cssValue(p.primaryForeground)}`,
    `--ring:${cssValue(p.ring)}`,
  ].join(";");
}

/** The path (and query) to retry: the failed page itself on this origin, else the home page. */
export function retryHref(requestUrl: string, origin: string): string {
  try {
    const url = new URL(requestUrl);
    return url.origin === origin ? `${url.pathname}${url.search}` : "/";
  } catch {
    return "/";
  }
}

/**
 * The page's HTML in the best bundled locale for `languages`. No script: Retry is a link to the
 * failed page, so it works with a strict CSP. Dark first, light where the system asks for it;
 * square corners, 44 px targets and a visible focus ring, as in the app.
 */
export function offlineDocument(opts: {
  languages: readonly string[];
  theme: OfflineTheme;
  requestUrl: string;
  origin: string;
}): string {
  const lang = pwaLocale(opts.languages);
  const text = (key: Parameters<typeof pwaText>[0]) => escapeHtml(pwaText(key, lang));
  const title = text("d7Pwa.offline.title");
  const links = OFFLINE_LINKS.map((link) => `<li><a href="${link.href}">${text(link.key)}</a></li>`).join("");
  const style = [
    `:root{color-scheme:dark;${palette(opts.theme.dark)}}`,
    `@media (prefers-color-scheme: light){:root{color-scheme:light;${palette(opts.theme.light)}}}`,
    "*{box-sizing:border-box}",
    "html,body{margin:0;min-height:100%}",
    "body{background:var(--bg);color:var(--fg);font:400 1rem/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:1rem}",
    "main{width:100%;max-width:28rem;display:flex;flex-direction:column;align-items:flex-start;gap:1rem}",
    "h1{margin:0;font-size:1.5rem;line-height:1.25;font-weight:600}",
    "p{margin:0}",
    ".muted{color:var(--muted);font-size:.875rem}",
    "a{color:inherit;text-underline-offset:4px;outline:none}",
    "a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}",
    ".retry{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 1.25rem;background:var(--primary);color:var(--primary-fg);font-weight:600;text-decoration:none}",
    "nav{width:100%;border-top:1px solid var(--border);padding-top:1rem}",
    "ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:0 1.5rem}",
    "li a{display:inline-flex;align-items:center;min-height:2.75rem}",
  ].join("");
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(lang)}" dir="${localeDirection(lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark light">',
    '<meta name="robots" content="noindex">',
    `<title>${title}</title>`,
    `<link rel="icon" href="${PWA_ICONS.svg}" type="image/svg+xml">`,
    `<style>${style}</style>`,
    "</head>",
    "<body>",
    '<main data-testid="pwa-offline">',
    `<img src="${PWA_ICONS.svg}" width="64" height="64" alt="">`,
    `<h1>${title}</h1>`,
    `<p>${text("d7Pwa.offline.body")}</p>`,
    `<a class="retry" data-testid="pwa-offline-retry" href="${escapeHtml(retryHref(opts.requestUrl, opts.origin))}">${text("d7Pwa.offline.retry")}</a>`,
    `<p class="muted">${text("d7Pwa.offline.cached")}</p>`,
    `<nav aria-label="${text("d7Pwa.offline.linksLabel")}"><ul>${links}</ul></nav>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

/** The headers the page goes out with: never stored, and nothing but its own styles and icon may load. */
export const OFFLINE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** The offline page as the navigation's answer: a 503, since the page itself was not reached. */
export function offlineResponse(opts: Parameters<typeof offlineDocument>[0]): Response {
  return new Response(offlineDocument(opts), { status: 503, headers: OFFLINE_HEADERS });
}
