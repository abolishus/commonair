// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The request middleware and bootstrap path (ADR 0029 decision 3): `Me.locale`, then the cookie
 * (also for a member who never chose), then Accept-Language, then the instance default; one
 * `me.get` per document request, shared by the root loader and the route guards.
 */
import type { Me } from "@commonair/contracts/dto";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createLocaleRegistry } from "../src/i18n/catalogs.ts";
import { registry, t } from "../src/i18n/index.ts";
import {
  type LocaleDeps,
  isDocumentRequest,
  localeFromCookie,
  negotiateRequest,
  requestLocale,
  withRequestLocale,
} from "../src/i18n/server.ts";
import { loadBootstrap, loadSessionUser } from "../src/server/bootstrap.ts";

beforeAll(() => {
  // Nothing listens on the discard port: `instance.info` fails fast and bootstrap falls back.
  process.env.API_INTERNAL_URL = "http://127.0.0.1:9";
});

// Spanish does not ship yet: a registry with an `es` directory stands in for it.
const locales = createLocaleRegistry({
  english: { "./locales/en/all.json": registry.english },
  lazy: { "./locales/es/core.json": async () => ({ "nav.signIn": "Iniciar sesión" }) },
});

function me(locale: string | null): Me {
  return {
    id: "0190f0f0-0000-7000-8000-000000000001",
    username: "wren",
    displayName: "Wren",
    channelSlug: null,
    role: "user",
    locale,
  } as unknown as Me;
}

function deps(member: Me | null, instanceDefault = "en"): LocaleDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    instanceDefault,
    locales,
    fetchMe: async (cookie) => {
      calls.push(cookie);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!member) throw new Error("UNAUTHORIZED");
      return member;
    },
  };
}

function request(opts: { cookie?: string; acceptLanguage?: string; accept?: string; method?: string } = {}): Request {
  const headers = new Headers({ accept: opts.accept ?? "text/html,application/xhtml+xml,*/*;q=0.8" });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.acceptLanguage) headers.set("accept-language", opts.acceptLanguage);
  return new Request("http://web.test/channel/x", { headers, method: opts.method ?? "GET" });
}

const pick = async (member: Me | null, opts: Parameters<typeof request>[0], instanceDefault = "en") =>
  (await negotiateRequest(request(opts), { document: true, deps: deps(member, instanceDefault) })).locale;

describe("negotiation order", () => {
  const session = "better-auth.session_token=abc";

  it("prefers the signed-in member's Me.locale", async () => {
    expect(await pick(me("es"), { cookie: `${session}; commonair-locale=en-XA`, acceptLanguage: "en" })).toBe("es");
  });

  it("then the cookie, for a signed-out visitor and for a member who never chose", async () => {
    expect(await pick(null, { cookie: "commonair-locale=es", acceptLanguage: "en-US" })).toBe("es");
    expect(await pick(me(null), { cookie: `${session}; commonair-locale=es`, acceptLanguage: "en-US" })).toBe("es");
    expect(await pick(me(null), { cookie: `${session}; commonair-locale=en-XA`, acceptLanguage: "es" })).toBe("en-XA");
  });

  it("then Accept-Language, with language fallback", async () => {
    expect(await pick(me(null), { cookie: session, acceptLanguage: "fr, es-MX;q=0.8" })).toBe("es");
    expect(await pick(null, { acceptLanguage: "en-US" })).toBe("en");
  });

  it("then the instance default, then en", async () => {
    expect(await pick(null, { acceptLanguage: "fr" }, "es")).toBe("es");
    expect(await pick(null, {}, "fr")).toBe("en");
  });

  it("skips an unsupported choice at each step", async () => {
    expect(await pick(me("fr"), { cookie: `${session}; commonair-locale=de`, acceptLanguage: "es" })).toBe("es");
  });

  it("never reaches en-XA by Accept-Language fallback", async () => {
    expect(await pick(null, { acceptLanguage: "en-US" }, "fr")).toBe("en");
  });

  it("reads the locale cookie among others", () => {
    expect(localeFromCookie("a=1; commonair-locale=es ; b=2")).toBe("es");
    expect(localeFromCookie("commonair-theme=dark")).toBeUndefined();
    expect(localeFromCookie("commonair-locale=%E0%A4%A")).toBeUndefined();
    expect(localeFromCookie(undefined)).toBeUndefined();
  });
});

describe("one me.get per document request", () => {
  const cookie = "better-auth.session_token=abc; commonair-locale=en-XA";

  it("serves the root loader and a guard's getSessionUser from one lookup, in the negotiated locale", async () => {
    const d = deps(me("es"));
    const result = await withRequestLocale(request({ cookie }), "router", d, async () => {
      const [boot, guard] = await Promise.all([loadBootstrap(cookie), loadSessionUser(cookie)]);
      const again = await loadSessionUser(cookie);
      return { boot, guard, again };
    });
    expect(d.calls).toEqual([cookie]);
    expect(result.boot.locale).toBe("es");
    expect(result.boot.dir).toBe("ltr");
    expect(result.boot.me).toEqual({
      id: "0190f0f0-0000-7000-8000-000000000001",
      username: "wren",
      displayName: "Wren",
      channelSlug: null,
      role: "user",
    });
    expect(result.guard).toEqual(result.boot.me);
    expect(result.again).toEqual(result.boot.me);
  });

  it("renders t() in that locale for the whole request", async () => {
    const d = deps(me(null));
    const text = await withRequestLocale(request({ cookie }), "router", d, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return t("nav.signIn");
    });
    expect(text).toMatch(/^\[Šîĝñ îñ~+\]$/);
    expect(requestLocale()).toBeUndefined();
    expect(t("nav.signIn")).toBe("Sign in");
  });

  it("makes no API call for a signed-out document request", async () => {
    const d = deps(null);
    const boot = await withRequestLocale(request({ acceptLanguage: "es" }), "router", d, () =>
      loadBootstrap(undefined),
    );
    expect(d.calls).toEqual([]);
    expect(boot.locale).toBe("es");
    expect(boot.me).toBeNull();
  });

  it("does not negotiate with the session on a server-function request, but still looks it up once when asked", async () => {
    const d = deps(me("es"));
    const store = await negotiateRequest(request({ cookie: "better-auth.session_token=abc", acceptLanguage: "en" }), {
      document: false,
      deps: d,
    });
    expect(d.calls).toEqual([]);
    expect(store.locale).toBe("en");
    // A bootstrap fetched as a server function still reports the member's choice.
    expect(await store.sessionLocale()).toBe("es");
    expect(await store.sessionLocale()).toBe("es");
    expect(d.calls).toHaveLength(1);
  });

  it("bypasses the store for a different cookie", async () => {
    const d = deps(me("es"));
    const user = await withRequestLocale(request({ cookie }), "serverFn", d, () => loadSessionUser("other=1"));
    // The real API is unreachable here, so the direct lookup answers null; the store was not used.
    expect(user).toBeNull();
    expect(d.calls).toEqual([]);
  });
});

describe("isDocumentRequest", () => {
  it("is true only for GET/HEAD page requests that accept HTML", () => {
    expect(isDocumentRequest(request(), "router")).toBe(true);
    expect(isDocumentRequest(request({ method: "HEAD" }), "router")).toBe(true);
    expect(isDocumentRequest(request({ accept: "*/*" }), "router")).toBe(true);
    expect(isDocumentRequest(request(), "serverFn")).toBe(false);
    expect(isDocumentRequest(request({ method: "POST" }), "router")).toBe(false);
    expect(isDocumentRequest(request({ accept: "application/json" }), "router")).toBe(false);
  });
});
