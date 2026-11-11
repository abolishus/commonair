// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F1 and F2 on the web server: only a 401 from `me.get` means signed out (429, 5xx and network
 * failures leave the session unknown, and guards throw instead of redirecting), and a page that
 * failed because the API was busy or unreachable is a 503 with Retry-After, not a 500.
 */
import { isRedirect } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { withRequestLocale } from "../src/i18n/server.ts";
import { requireSession } from "../src/lib/guard.ts";
import { SessionUnavailableError, isSessionUnavailable } from "../src/lib/session.ts";
import {
  hasSessionCookie,
  loadBootstrap,
  loadSessionUser,
  localeDeps,
  lookupSession,
  sessionFailure,
} from "../src/server/bootstrap.ts";
import { UNAVAILABLE_RETRY_AFTER, createHandler, unavailablePage } from "../src/server/http.ts";
import { forwardingFetch, parseRetryAfter } from "../src/server/proxy.ts";

const API = "http://api.fix-session.test";
const COOKIE = "commonair.session_token=abc.def; commonair-theme=dark";

beforeAll(() => {
  process.env.API_INTERNAL_URL = API;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ME = {
  id: "0190f0f0-0000-7000-8000-000000000001",
  username: "wren",
  displayName: "Wren",
  channelSlug: null,
  role: "user",
  locale: null,
  pendingLegal: [{ kind: "terms", version: "2026-10-01" }],
  settingsSummary: { deletionScheduledFor: null, openAppeals: 1, openCopyright: 0 },
};

/** An oRPC error answer, as the API sends one. */
function rpcError(status: number, code: string, data?: unknown): Response {
  return Response.json({ json: { defined: true, code, status, message: code, data } }, { status });
}

type Answer = Response | Error;

/** Stub `fetch`: `me.get` answers `me`; `instance.info` is down (bootstrap falls back). */
function stubApi(me: () => Answer): { meCalls: () => number } {
  let meCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rpc/me/get")) {
        meCalls++;
        const answer = me();
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return rpcError(503, "SERVICE_UNAVAILABLE");
    }),
  );
  return { meCalls: () => meCalls };
}

describe("hasSessionCookie", () => {
  it.each([
    ["commonair.session_token=abc", true],
    ["__Secure-commonair.session_token=abc", true],
    ["a=1; better-auth.session_token=x; b=2", true],
    ["commonair-theme=dark; commonair-locale=es", false],
    ["commonair.session_token=", false],
    ["session_tokenx=abc", false],
    ["", false],
  ])("%s → %s", (cookie, expected) => {
    expect(hasSessionCookie(cookie)).toBe(expected);
  });
  it("is false without a cookie header", () => {
    expect(hasSessionCookie(undefined)).toBe(false);
  });
});

describe("sessionFailure", () => {
  const err = (fields: Record<string, unknown>) => Object.assign(new Error("x"), fields);
  it("a 401 (and other definitive 4xx) is signed out", () => {
    expect(sessionFailure(err({ code: "UNAUTHORIZED", status: 401 }))).toEqual({ status: "signedOut" });
    expect(sessionFailure(err({ code: "FORBIDDEN", status: 403 }))).toEqual({ status: "signedOut" });
    expect(sessionFailure(err({ code: "UNAUTHORIZED" }))).toEqual({ status: "signedOut" });
  });
  it("a 429 is unavailable, with the retry hint", () => {
    expect(sessionFailure(err({ code: "RATE_LIMITED", status: 429, data: { retryAfterSeconds: 7 } }))).toEqual({
      status: "unavailable",
      retryAfterSeconds: 7,
    });
  });
  it.each([500, 502, 503, 504, 408])("a %s is unavailable", (status) => {
    expect(sessionFailure(err({ code: "X", status }))).toEqual({ status: "unavailable", retryAfterSeconds: null });
  });
  it("a network failure or an unknown error is unavailable", () => {
    expect(sessionFailure(new TypeError("fetch failed"))).toEqual({ status: "unavailable", retryAfterSeconds: null });
    expect(sessionFailure("nope")).toEqual({ status: "unavailable", retryAfterSeconds: null });
  });
});

describe("lookupSession and loadSessionUser (F1)", () => {
  it("no session cookie: signed out without asking the API", async () => {
    const api = stubApi(() => Response.json({ json: ME }));
    expect(await lookupSession(undefined)).toEqual({ status: "signedOut" });
    expect(await lookupSession("commonair-theme=dark")).toEqual({ status: "signedOut" });
    expect(api.meCalls()).toBe(0);
  });

  it("200: signed in, with the pending legal documents for the shell's banner", async () => {
    stubApi(() => Response.json({ json: ME }));
    expect(await loadSessionUser(COOKIE)).toStrictEqual({
      id: ME.id,
      username: "wren",
      displayName: "Wren",
      channelSlug: null,
      role: "user",
      pendingLegal: [{ kind: "terms", version: "2026-10-01" }],
      settingsSummary: { deletionScheduledFor: null, openAppeals: 1, openCopyright: 0 },
    });
  });

  it("401: signed out, and the guard redirects to /signin", async () => {
    stubApi(() => rpcError(401, "UNAUTHORIZED"));
    expect(await lookupSession(COOKIE)).toEqual({ status: "signedOut" });
    expect(await loadSessionUser(COOKIE)).toBeNull();
    const err = await requireSession(() => loadSessionUser(COOKIE)).catch((e: unknown) => e);
    expect(isRedirect(err)).toBe(true);
  });

  it("429: unavailable; the guard throws SessionUnavailableError, never a redirect", async () => {
    stubApi(() => rpcError(429, "RATE_LIMITED", { retryAfterSeconds: 7 }));
    expect(await lookupSession(COOKIE)).toEqual({ status: "unavailable", retryAfterSeconds: 7 });
    const err = await requireSession(() => loadSessionUser(COOKIE)).catch((e: unknown) => e);
    expect(isRedirect(err)).toBe(false);
    expect(err).toBeInstanceOf(SessionUnavailableError);
    expect(isSessionUnavailable(err)).toBe(true);
    expect((err as SessionUnavailableError).data).toEqual({ retryAfterSeconds: 7 });
  });

  it.each([
    ["500", () => rpcError(500, "INTERNAL_SERVER_ERROR")],
    ["503", () => rpcError(503, "SERVICE_UNAVAILABLE")],
    ["a network failure", () => new TypeError("fetch failed")],
  ])("%s: unavailable", async (_name, answer: () => Answer) => {
    stubApi(answer);
    expect(await lookupSession(COOKIE)).toEqual({ status: "unavailable", retryAfterSeconds: null });
    await expect(loadSessionUser(COOKIE)).rejects.toBeInstanceOf(SessionUnavailableError);
  });

  it("the root loader keeps a signed-in member's place: me null, sessionUnavailable", async () => {
    stubApi(() => rpcError(429, "RATE_LIMITED", { retryAfterSeconds: 3 }));
    const boot = await loadBootstrap(COOKIE);
    expect(boot.me).toBeNull();
    expect(boot.sessionUnavailable).toBe(true);
  });

  it("a settled bootstrap carries no sessionUnavailable field", async () => {
    stubApi(() => rpcError(401, "UNAUTHORIZED"));
    expect("sessionUnavailable" in (await loadBootstrap(COOKIE))).toBe(false);
    stubApi(() => Response.json({ json: ME }));
    const boot = await loadBootstrap(COOKIE);
    expect(boot.me?.id).toBe(ME.id);
    expect("sessionUnavailable" in boot).toBe(false);
  });

  it("inside a request, one me.get serves the middleware, the root loader and every guard, failures included", async () => {
    const api = stubApi(() => rpcError(429, "RATE_LIMITED", { retryAfterSeconds: 2 }));
    const request = new Request("http://web.test/settings/notifications", {
      headers: { cookie: COOKIE, accept: "text/html" },
    });
    const result = await withRequestLocale(request, "router", localeDeps(), async () => {
      const [boot, guard] = await Promise.all([
        loadBootstrap(COOKIE),
        loadSessionUser(COOKIE).catch((e: unknown) => e),
      ]);
      const again = await lookupSession(COOKIE);
      return { boot, guard, again };
    });
    expect(api.meCalls()).toBe(1);
    expect(result.boot.sessionUnavailable).toBe(true);
    expect(result.guard).toBeInstanceOf(SessionUnavailableError);
    expect(result.again).toEqual({ status: "unavailable", retryAfterSeconds: 2 });
  });

  it("inside a request, a 401 is signed out with the same single call", async () => {
    const api = stubApi(() => rpcError(401, "UNAUTHORIZED"));
    const request = new Request("http://web.test/", { headers: { cookie: COOKIE, accept: "text/html" } });
    const user = await withRequestLocale(request, "router", localeDeps(), () => loadSessionUser(COOKIE));
    expect(user).toBeNull();
    expect(api.meCalls()).toBe(1);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(parseRetryAfter("Fri, 06 Nov 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Fri, 06 Nov 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("unavailablePage (F2)", () => {
  const html = (status: number) =>
    new Response("<!doctype html><p>page</p>", { status, headers: { "content-type": "text/html; charset=utf-8" } });

  it("an error page the API's trouble caused becomes a 503 with Retry-After", async () => {
    const res = unavailablePage(html(500), { status: 429, retryAfterSeconds: 9 });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("9");
    expect(await res.text()).toContain("page");
  });

  it("defaults and caps Retry-After", () => {
    expect(unavailablePage(html(500), { status: null, retryAfterSeconds: null }).headers.get("retry-after")).toBe(
      String(UNAVAILABLE_RETRY_AFTER),
    );
    expect(unavailablePage(html(500), { status: 429, retryAfterSeconds: 3600 }).headers.get("retry-after")).toBe("120");
    expect(unavailablePage(html(500), { status: 429, retryAfterSeconds: 0 }).headers.get("retry-after")).toBe("1");
  });

  it("leaves pages that rendered, real 500s and server-function answers alone", () => {
    expect(unavailablePage(html(200), { status: 429, retryAfterSeconds: 9 }).status).toBe(200);
    expect(unavailablePage(html(500), null).status).toBe(500);
    const fn = new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    expect(unavailablePage(fn, { status: 429, retryAfterSeconds: 9 }).status).toBe(500);
  });
});

describe("createHandler: the render's API trouble decides 500 or 503", () => {
  const RENDER_API = "http://api.internal:3001";

  function handlerFor(apiStatus: number | "down", pageStatus: number) {
    const base = Object.assign(
      async () => {
        if (apiStatus === "down") throw new TypeError("fetch failed");
        return new Response("{}", { status: apiStatus, headers: { "retry-after": "11" } });
      },
      { preconnect: () => undefined },
    ) as unknown as typeof fetch;
    const apiFetch = forwardingFetch(base, RENDER_API);
    return createHandler({
      apiUrl: RENDER_API,
      publicUrl: "https://stream.example.org",
      clientDir: "/nonexistent-dir-for-tests/",
      ssr: async () => {
        await apiFetch(`${RENDER_API}/rpc/directory/home`).catch(() => null);
        return new Response("<p>x</p>", { status: pageStatus, headers: { "content-type": "text/html" } });
      },
    });
  }

  it("a rate-limited render that failed is a 503 with the API's Retry-After", async () => {
    const res = await handlerFor(429, 500)(new Request("http://localhost/directory"), null);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("11");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("an unreachable API is a 503 too", async () => {
    const res = await handlerFor("down", 500)(new Request("http://localhost/"), null);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(UNAVAILABLE_RETRY_AFTER));
  });

  it("a page that rendered with a failed section stays a 200", async () => {
    const res = await handlerFor(429, 200)(new Request("http://localhost/"), null);
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("a 500 with no API trouble stays a 500", async () => {
    const res = await handlerFor(200, 500)(new Request("http://localhost/"), null);
    expect(res.status).toBe(500);
  });
});
