// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { en, type EmailCatalog } from "./en.ts";

export { en, type EmailCatalog, type LayoutMessages } from "./en.ts";

/** A translation may be incomplete; missing strings fall back to English. */
export type PartialCatalog = { [K in keyof EmailCatalog]?: Partial<EmailCatalog[K]> };

/** Catalogs by BCP 47 tag, e.g. `{ de: deCatalog, "pt-BR": ptBrCatalog }`. */
export type Catalogs = Record<string, PartialCatalog>;

/** Fill gaps in `partial` from English, block by block and string by string. */
export function mergeCatalog(partial: PartialCatalog): EmailCatalog {
  const merged: Record<string, Record<string, string>> = {};
  for (const [block, messages] of Object.entries(en) as [keyof EmailCatalog, Record<string, string>][]) {
    merged[block] = { ...messages, ...(partial[block] as Record<string, string> | undefined) };
  }
  return merged as unknown as EmailCatalog;
}

/**
 * Pick the catalog for `locale`: exact tag, then its language (`pt-BR` →
 * `pt`), then English. Returns the locale actually used so `lang` and date
 * formatting match the strings.
 */
export function resolveCatalog(
  locale: string | undefined,
  catalogs: Catalogs = {},
): { locale: string; catalog: EmailCatalog } {
  const candidates = locale ? [locale, locale.split("-")[0] ?? locale] : [];
  for (const tag of candidates) {
    const partial = catalogs[tag];
    if (partial) return { locale: tag, catalog: mergeCatalog(partial) };
  }
  return { locale: "en", catalog: en };
}
