// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The locales the app ships and their translators (ADR 0029 decisions 2, 3 and 6). English is
 * bundled; every other `locales/<lang>/` loads on first use and falls back to English per key;
 * `en-XA` has no files and is English run through `pseudoLocalize`.
 */
import { type MessageArgs, PSEUDO_LOCALE, createTranslator, pseudoLocalize } from "@commonair/i18n";
import type { MessageKey } from "./keys/index.gen.ts";

export const SOURCE_LOCALE = "en";

export interface Translator {
  readonly locale: string;
  readonly t: (key: MessageKey, args?: MessageArgs) => string;
}

type Catalog = Readonly<Record<string, string>>;
type Loader = () => Promise<unknown>;

const PATH = /\/locales\/([^/]+)\/([^/]+)\.json$/;

function langOf(path: string): string | undefined {
  return PATH.exec(path)?.[1];
}

export interface LocaleRegistry {
  /** Every directory under `locales/` plus `en-XA`, English first. */
  readonly supported: readonly string[];
  readonly english: Record<MessageKey, string>;
  readonly englishTranslator: Translator;
  /** The translator once loaded (English and `en-XA` always are), else undefined. */
  peek(tag: string): Translator | undefined;
  /** Load a locale's namespaces once and cache its translator; an unsupported tag gets English. */
  load(tag: string): Promise<Translator>;
}

/**
 * Build the registry from glob maps (path → catalog / loader), so tests can inject locales that
 * do not exist yet. `onMissing` hears about untranslated or unparsable messages.
 */
export function createLocaleRegistry(opts: {
  english: Readonly<Record<string, unknown>>;
  lazy: Readonly<Record<string, Loader>>;
  onMissing?: (locale: string, key: string) => void;
}): LocaleRegistry {
  const englishCatalog: Record<string, string> = {};
  for (const [path, catalog] of Object.entries(opts.english))
    if (langOf(path) === SOURCE_LOCALE) Object.assign(englishCatalog, catalog as Catalog);
  const english = englishCatalog as Record<MessageKey, string>;

  const loaders = new Map<string, Loader[]>();
  for (const [path, loader] of Object.entries(opts.lazy)) {
    const lang = langOf(path);
    if (!lang || lang === SOURCE_LOCALE || lang === PSEUDO_LOCALE) continue;
    loaders.set(lang, [...(loaders.get(lang) ?? []), loader]);
  }
  const supported = [SOURCE_LOCALE, ...[...loaders.keys()].sort(), PSEUDO_LOCALE];

  const make = (locale: string, messages: Partial<Record<MessageKey, string>>): Translator => ({
    locale,
    t: createTranslator<MessageKey>({
      locale,
      messages,
      fallback: english,
      onMissing: opts.onMissing && ((key) => opts.onMissing?.(locale, key)),
    }),
  });

  const englishTranslator = make(SOURCE_LOCALE, english);
  const ready = new Map<string, Translator>([[SOURCE_LOCALE, englishTranslator]]);
  const pending = new Map<string, Promise<Translator>>();

  const peek = (tag: string): Translator | undefined => {
    const hit = ready.get(tag);
    if (hit) return hit;
    if (tag !== PSEUDO_LOCALE) return undefined;
    // Built on first use: English with every message pseudo-localized.
    const pseudo: Partial<Record<MessageKey, string>> = {};
    for (const [key, message] of Object.entries(english)) pseudo[key as MessageKey] = pseudoLocalize(message);
    const translator = make(PSEUDO_LOCALE, pseudo);
    ready.set(PSEUDO_LOCALE, translator);
    return translator;
  };

  const load = (tag: string): Promise<Translator> => {
    const hit = peek(tag);
    if (hit) return Promise.resolve(hit);
    const files = loaders.get(tag);
    if (!files) return Promise.resolve(englishTranslator);
    let promise = pending.get(tag);
    if (!promise) {
      promise = Promise.all(files.map((loader) => loader())).then(
        (catalogs) => {
          const messages: Record<string, string> = {};
          for (const catalog of catalogs) Object.assign(messages, catalog as Catalog);
          const translator = make(tag, messages as Partial<Record<MessageKey, string>>);
          ready.set(tag, translator);
          return translator;
        },
        () => {
          // A chunk that fails to load (a deploy mid-session) must not break the page.
          pending.delete(tag);
          return englishTranslator;
        },
      );
      pending.set(tag, promise);
    }
    return promise;
  };

  return { supported, english, englishTranslator, peek, load };
}

export function defaultRegistry(): LocaleRegistry {
  const warned = new Set<string>();
  return createLocaleRegistry({
    english: import.meta.glob("./locales/en/*.json", { eager: true, import: "default" }),
    lazy: import.meta.glob(["./locales/*/*.json", "!./locales/en/*.json"], { import: "default" }),
    onMissing: import.meta.env.DEV
      ? (locale, key) => {
          const id = `${locale}:${key}`;
          if (warned.has(id)) return;
          warned.add(id);
          console.warn(`[i18n] ${locale}: ${key} is untranslated or does not parse`);
        }
      : undefined,
  });
}
