// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * App message catalog (ADR 0029). Every user-facing string goes through `t()`, which renders in
 * the active locale: on the server the request's (an `AsyncLocalStorage` set by the request
 * middleware in `src/start.ts`, see `server.ts`), in the browser the one `client.ts` loaded
 * before hydrating, and English anywhere else (tests, scripts). `t()` is not reactive: a switch
 * remounts the tree (`applyLocale`).
 */
import { PSEUDO_LOCALE, pseudoLocalize } from "@commonair/i18n";
import { enMessages, type UiMessages } from "@commonair/ui/lib/messages";
import { type LocaleRegistry, type Translator, defaultRegistry } from "./catalogs.ts";
import type { MessageKey } from "./keys/index.gen.ts";

export type { MessageKey } from "./keys/index.gen.ts";
export type { Translator } from "./catalogs.ts";

export const registry: LocaleRegistry = defaultRegistry();
/** Locales a visitor can get: every `locales/<lang>/` directory plus `en-XA`. */
export const SUPPORTED_LOCALES: readonly string[] = registry.supported;

// The active translator: the server installs a per-request resolver; the browser sets one value.
let serverResolver: (() => Translator | undefined) | null = null;
let clientTranslator: Translator | null = null;

/** Server only (`server.ts`): read the active translator from the request store. */
export function setServerTranslatorResolver(resolve: () => Translator | undefined): void {
  serverResolver = resolve;
}

/** Browser only (`client.ts`): the translator every `t()` uses from now on. */
export function setClientTranslator(translator: Translator): void {
  clientTranslator = translator;
}

function active(): Translator {
  return (serverResolver ? serverResolver() : clientTranslator) ?? registry.englishTranslator;
}

/** Look up `key` in the active locale and format it (ICU plural/select, `{name}` placeholders). */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return active().t(key, vars);
}

/** The locale `t()` renders in right now. */
export function activeLocale(): string {
  return active().locale;
}

/** `tag`'s language subtag, for third-party widgets (ALTCHA); they have no pseudo-locale, so `en-XA` is `en`. */
export function baseLanguage(tag: string): string {
  if (tag === PSEUDO_LOCALE) return "en";
  return tag.split("-")[0]?.toLowerCase() || "en";
}

/** Load a locale's catalog (once) and return its translator; unsupported tags get English. */
export function loadLocale(tag: string): Promise<Translator> {
  return registry.load(tag);
}

let pseudoUi: UiMessages | null = null;

function pseudoMessages(messages: UiMessages): UiMessages {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return pseudoLocalize(value);
    if (typeof value === "function")
      return (...args: unknown[]) => pseudoLocalize(String((value as (...a: unknown[]) => unknown)(...args)));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(messages) as UiMessages;
}

/** Design-system strings for `locale`: English until N2-ui ships translations, pseudo for `en-XA`. */
export function uiMessagesFor(locale: string): UiMessages {
  if (locale !== PSEUDO_LOCALE) return enMessages;
  pseudoUi ??= pseudoMessages(enMessages);
  return pseudoUi;
}

/**
 * The source (English) locale and its `UiMessages`, for tests that render outside a request;
 * app code uses `activeLocale()` / `uiMessagesFor()`.
 */
export const locale = "en";
export const uiMessages: UiMessages = enMessages;
