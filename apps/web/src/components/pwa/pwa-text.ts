// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `d7-pwa` strings for the two places the app's `t()` cannot reach (README D7.6): the web
 * app manifest (built on the server per request, outside a render) and the service worker's
 * offline page (the worker bundles no `import.meta.glob`). Both bundle these catalogs and pick one
 * by the browser's languages, falling back to English per key, like `src/sw/messages.ts`.
 */
import { formatMessage, negotiateLocale } from "@commonair/i18n";
import en from "../../i18n/locales/en/d7-pwa.json" with { type: "json" };
import es from "../../i18n/locales/es/d7-pwa.json" with { type: "json" };

export type PwaTextKey = keyof typeof en;

type Catalog = Readonly<Partial<Record<PwaTextKey, string>>>;

const CATALOGS: Readonly<Record<string, Catalog>> = { en, es };
const FALLBACK = "en";

/** The bundled locale for these languages (`navigator.languages`, `Accept-Language`), else English. */
export function pwaLocale(languages: readonly string[]): string {
  return negotiateLocale(languages, Object.keys(CATALOGS)) ?? FALLBACK;
}

/** The message for `key` in `locale` (English per key when missing), formatted. */
export function pwaText(key: PwaTextKey, locale: string, args: Record<string, string> = {}): string {
  const source = CATALOGS[locale]?.[key] ?? en[key];
  return formatMessage(source, args, locale);
}
