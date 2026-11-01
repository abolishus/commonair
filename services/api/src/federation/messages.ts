// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The platform's own text in federation documents (ADR 0030 decision 3: all text is the
 * streamer's or from a catalog). Remote readers have no session, so the instance's default
 * language (`INSTANCE_DEFAULT_LOCALE`) picks the catalog, falling back to English. Every key has
 * `en` and `es`, like the web catalogs (`REQUIRED_LOCALES`).
 */
const CATALOG = {
  en: {
    repliesNotRead: "Automated posts from a channel on {instance}. Replies and mentions are not read.",
  },
  es: {
    repliesNotRead: "Publicaciones automáticas de un canal en {instance}. Las respuestas y menciones no se leen.",
  },
} as const satisfies Record<string, Record<string, string>>;

export type FederationMessageKey = keyof (typeof CATALOG)["en"];
export const FEDERATION_LOCALES = Object.keys(CATALOG) as (keyof typeof CATALOG)[];

/** The catalog for a BCP 47 tag: exact, then the base language, then English. */
function catalogFor(locale: string): Record<FederationMessageKey, string> {
  const tag = locale.toLowerCase();
  const base = tag.split("-")[0] ?? "en";
  return (
    (CATALOG as Record<string, Record<FederationMessageKey, string>>)[tag] ??
    (CATALOG as Record<string, Record<FederationMessageKey, string>>)[base] ??
    CATALOG.en
  );
}

export function federationMessage(
  locale: string,
  key: FederationMessageKey,
  vars: Record<string, string> = {},
): string {
  return catalogFor(locale)[key].replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}
