// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The service worker's strings. It cannot use the app's `t()` (that loads every catalog through
 * `import.meta.glob`), so it bundles the `n1-pwa` catalogs it needs and picks one by the browser's
 * languages. Only English today; a locale added here (N2) is picked up by `negotiateLocale`.
 */
import { formatMessage, negotiateLocale } from "@commonair/i18n";
import en from "../i18n/locales/en/n1-pwa.json" with { type: "json" };

type Catalog = Readonly<Record<string, string>>;

const CATALOGS: Readonly<Record<string, Catalog>> = { en };
const FALLBACK = "en";

/** The bundled locale for these browser languages (`navigator.languages`), English when none match. */
export function workerLocale(languages: readonly string[]): string {
  return negotiateLocale(languages, Object.keys(CATALOGS)) ?? FALLBACK;
}

/** The message for `key` in `locale` (falling back to English per key), formatted. */
export function workerMessage(key: keyof typeof en, args: Record<string, string>, locale: string): string {
  const source = CATALOGS[locale]?.[key] ?? en[key];
  return formatMessage(source, args, locale);
}
