// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMessage } from "@commonair/i18n";
import { checkTranslation } from "@commonair/i18n/catalog";
import { BUNDLED } from "./bundled.ts";
import { en, type EmailCatalog } from "./en.ts";
import type { Catalogs, PartialCatalog } from "./types.ts";

export { BUNDLED } from "./bundled.ts";
export { en, type EmailCatalog, type LayoutMessages } from "./en.ts";
export type { Catalogs, PartialCatalog } from "./types.ts";

/**
 * Whether a translated string can stand in for English: it parses and uses the same arguments the
 * same ways (`@commonair/i18n/catalog` `checkTranslation`). Anything else renders English.
 */
function usable(english: string, translated: unknown): translated is string {
  if (typeof translated !== "string") return false;
  try {
    parseMessage(translated);
  } catch {
    return false;
  }
  return checkTranslation(english, translated) === undefined;
}

interface Merged {
  catalog: EmailCatalog;
  /** `block.field` keys that came from English (missing, broken or with other arguments). */
  fallbacks: string[];
}

const merged = new WeakMap<PartialCatalog, Merged>();

function merge(partial: PartialCatalog): Merged {
  const cached = merged.get(partial);
  if (cached) return cached;
  const out: Record<string, Record<string, string>> = {};
  const fallbacks: string[] = [];
  for (const [block, messages] of Object.entries(en) as [keyof EmailCatalog, Record<string, string>][]) {
    const theirs = partial[block] as Record<string, unknown> | undefined;
    const target: Record<string, string> = {};
    for (const [field, english] of Object.entries(messages)) {
      const translated = theirs?.[field];
      if (usable(english, translated)) target[field] = translated;
      else {
        target[field] = english;
        fallbacks.push(`${block}.${field}`);
      }
    }
    out[block] = target;
  }
  const result = { catalog: out as unknown as EmailCatalog, fallbacks };
  merged.set(partial, result);
  return result;
}

/**
 * Fill gaps in `partial` from English, block by block and string by string. A string that does not
 * parse, or whose arguments differ from English's, is replaced by the English one.
 */
export function mergeCatalog(partial: PartialCatalog): EmailCatalog {
  return merge(partial).catalog;
}

/** The `block.field` keys `mergeCatalog(partial)` takes from English (empty for a complete, valid catalog). */
export function catalogFallbacks(partial: PartialCatalog): string[] {
  return [...merge(partial).fallbacks];
}

/**
 * Pick the catalog for `locale`: exact tag, then its language (`pt-BR` → `pt`), then English.
 * `catalogs` defaults to every bundled locale. Returns the locale actually used so `lang`, `dir`
 * and date formatting match the strings.
 */
export function resolveCatalog(
  locale: string | undefined,
  catalogs: Catalogs = BUNDLED,
): { locale: string; catalog: EmailCatalog } {
  const candidates = locale ? [locale, locale.split("-")[0] ?? locale] : [];
  for (const tag of candidates) {
    const partial = catalogs[tag];
    if (partial) return { locale: tag, catalog: partial === en ? en : mergeCatalog(partial) };
  }
  return { locale: "en", catalog: en };
}
