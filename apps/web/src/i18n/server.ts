// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-request locale on the server (ADR 0029 decision 3). The request middleware (`src/start.ts`)
 * negotiates once and runs the whole request, streaming render included, inside an
 * `AsyncLocalStorage`, so `t()` never sees another request's locale. The store also memoizes the
 * visitor's `me.get`, so the root loader and route guards share one API call per document.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Me } from "@commonair/contracts/dto";
import { negotiateLocale, pickLocale } from "@commonair/i18n";
import { LOCALE_COOKIE } from "./cookie.ts";
import type { LocaleRegistry } from "./catalogs.ts";
import { type Translator, registry, setServerTranslatorResolver } from "./index.ts";

export interface LocaleDeps {
  /** `me.get` with the visitor's cookie; rejects when signed out or the API is unreachable. */
  fetchMe: (cookie: string) => Promise<Me>;
  /** `INSTANCE_DEFAULT_LOCALE`. */
  instanceDefault: string;
  /** The app's locales (tests inject one with locales that do not ship yet). */
  locales?: Pick<LocaleRegistry, "supported" | "load">;
}

export interface RequestLocale {
  readonly locale: string;
  readonly translator: Translator;
  /** The cookie header this store was negotiated for; a lookup for another cookie bypasses it. */
  readonly cookie: string | undefined;
  /** The signed-in member (memoized: at most one `me.get` per request), or null. */
  me(): Promise<Me | null>;
  /**
   * The locale for this visitor with their `Me.locale` taken into account, and whether that saved
   * choice decided it (the browser then ignores a tab-only choice: the member's choice comes first).
   */
  sessionLocale(): Promise<{ locale: string; fromUser: boolean }>;
}

const storage = new AsyncLocalStorage<RequestLocale>();
setServerTranslatorResolver(() => storage.getStore()?.translator);

export function requestLocale(): RequestLocale | undefined {
  return storage.getStore();
}

/** The `commonair-locale` cookie's value, if any. */
export function localeFromCookie(cookie: string | null | undefined): string | undefined {
  for (const part of (cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether a request renders a page: only those negotiate with the session. */
export function isDocumentRequest(request: Request, handlerType: "serverFn" | "router"): boolean {
  if (handlerType !== "router" || (request.method !== "GET" && request.method !== "HEAD")) return false;
  return /(^|,)\s*(\*\/\*|text\/html)/.test(request.headers.get("accept") || "*/*");
}

/**
 * Negotiate for one request. A document request asks the API who is signed in (their
 * `Me.locale` comes first); anything else uses the cookie, Accept-Language and the default.
 */
export async function negotiateRequest(
  request: Request,
  opts: { document: boolean; deps: LocaleDeps },
): Promise<RequestLocale> {
  const { deps } = opts;
  const locales = deps.locales ?? registry;
  const cookie = request.headers.get("cookie") ?? undefined;
  let mePromise: Promise<Me | null> | undefined;
  const me = () =>
    (mePromise ??= cookie
      ? deps.fetchMe(cookie).then(
          (m) => m,
          () => null,
        )
      : Promise.resolve(null));
  const pick = (userLocale: string | null | undefined) =>
    pickLocale({
      userLocale,
      stored: localeFromCookie(cookie),
      acceptLanguage: request.headers.get("accept-language"),
      instanceDefault: deps.instanceDefault,
      supported: locales.supported,
    });
  const fromUser = (userLocale: string | null | undefined) =>
    Boolean(userLocale && negotiateLocale([userLocale], locales.supported));
  const userLocale = opts.document ? (await me())?.locale : null;
  const translator = await locales.load(pick(userLocale));
  return {
    locale: translator.locale,
    translator,
    cookie,
    me,
    sessionLocale: async () => {
      if (opts.document) return { locale: translator.locale, fromUser: fromUser(userLocale) };
      const saved = (await me())?.locale;
      return { locale: pick(saved), fromUser: fromUser(saved) };
    },
  };
}

export function runWithRequestLocale<T>(store: RequestLocale, fn: () => T): T {
  return storage.run(store, fn);
}

/** The request middleware's body: negotiate, then run the rest of the request in that locale. */
export async function withRequestLocale<T>(
  request: Request,
  handlerType: "serverFn" | "router",
  deps: LocaleDeps,
  next: () => T | Promise<T>,
): Promise<T> {
  const store = await negotiateRequest(request, { document: isDocumentRequest(request, handlerType), deps });
  return await storage.run(store, next);
}
