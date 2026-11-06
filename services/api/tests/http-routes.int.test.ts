// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's HTTP surface (`createApp`) through its own fetch: internal routes answer 401 without
 * the secret and 404 while their test hooks are off, CORS gives credentials only to trusted
 * origins and strips cookies from the rest, the raw routes (overlay stream, federation, the
 * portability keys, the Twitch callback, OpenAPI, ALTCHA) answer their methods, the auth and API
 * limiters surface `retry-after`, an untrusted proxy is warned about once, the dev-only flags warn
 * at start, and a failure anywhere is a bare JSON error without detail.
 */
import { ORPCError } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { createLogger } from "@commonair/observability";
import type { Deps } from "../src/deps.ts";
import { createApp } from "../src/http.ts";
import { TWITCH_IMPORT_CALLBACK_PATH, WELL_KNOWN_PATHS } from "../src/raw-routes.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

/** A fresh client address per call site: the limiters' keys live in the shared Valkey. */
const addr = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
const peer = (address = "127.0.0.1") => ({ requestIP: () => ({ address, family: "IPv4" as const, port: 1 }) });
function call(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
  from = "127.0.0.1",
): Promise<Response> {
  return app.fetch(new Request(`${api.url}${path}`, init), peer(from));
}
const secret = () => ({ [INTERNAL_SECRET_HEADER]: api.internalSecret });

function captured(): { lines: { level: string; msg: string }[]; logger: Deps["logger"] } {
  const lines: { level: string; msg: string }[] = [];
  const logger = createLogger({
    service: "http-test",
    level: "debug",
    write: (l) => {
      const o = JSON.parse(l) as { level: string; msg: string };
      lines.push({ level: o.level, msg: o.msg });
    },
  });
  return { lines, logger };
}

describe("internal routes", () => {
  test("media ready and not-ready, and the upload commit, need the internal secret", async () => {
    for (const path of [INTERNAL_ROUTES.mediaReady, INTERNAL_ROUTES.mediaNotReady])
      expect((await call(api.app, path, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call(api.app, INTERNAL_ROUTES.uploadCommit, { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("a body that is not JSON, or too large, reads as nothing (the hook refuses it)", async () => {
    const bad = await call(api.app, INTERNAL_ROUTES.mediaReady, {
      method: "POST",
      headers: secret(),
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    const big = await call(api.app, INTERNAL_ROUTES.mediaReady, {
      method: "POST",
      headers: secret(),
      body: JSON.stringify({ path: "x".repeat(70 * 1024) }),
    });
    expect(big.status).toBe(400);
  });

  test("each test hook is 404 while its flag is off, and 401 without the secret while on", async () => {
    const hooks: [string, keyof Deps["env"]][] = [
      [INTERNAL_ROUTES.moderationScript, "MODERATION_TEST_HOOKS"],
      [INTERNAL_ROUTES.coopTick, "COOP_TEST_HOOKS"],
      [INTERNAL_ROUTES.opsTick, "OPS_TEST_HOOKS"],
      [INTERNAL_ROUTES.analyticsTick, "OPS_TEST_HOOKS"],
      [INTERNAL_ROUTES.b7Tick, "OPS_TEST_HOOKS"],
      [INTERNAL_ROUTES.interactTick, "INTERACT_TEST_HOOKS"],
    ];
    const env = api.deps.env as unknown as Record<string, unknown>;
    for (const [path, flag] of hooks) {
      const was = env[flag];
      env[flag] = false;
      try {
        expect((await call(api.app, path, { method: "POST", headers: secret(), body: "{}" })).status).toBe(404);
        env[flag] = true;
        expect((await call(api.app, path, { method: "POST", body: "{}" })).status).toBe(401);
      } finally {
        env[flag] = was;
      }
    }
    expect((await call(api.app, "/internal/nothing-here", { method: "POST", headers: secret() })).status).toBe(404);
  });

  test("with its flag on and the secret, each hook is reached (a method it does not take is 405)", async () => {
    const hooks: [string, keyof Deps["env"]][] = [
      [INTERNAL_ROUTES.moderationScript, "MODERATION_TEST_HOOKS"],
      [INTERNAL_ROUTES.coopTick, "COOP_TEST_HOOKS"],
      [INTERNAL_ROUTES.opsTick, "OPS_TEST_HOOKS"],
      [INTERNAL_ROUTES.analyticsTick, "OPS_TEST_HOOKS"],
      [INTERNAL_ROUTES.b7Tick, "OPS_TEST_HOOKS"],
      [INTERNAL_ROUTES.interactTick, "INTERACT_TEST_HOOKS"],
    ];
    const env = api.deps.env as unknown as Record<string, unknown>;
    for (const [path, flag] of hooks) {
      const was = env[flag];
      env[flag] = true;
      try {
        expect([path, (await call(api.app, path, { method: "DELETE", headers: secret() })).status]).toEqual([
          path,
          405,
        ]);
      } finally {
        env[flag] = was;
      }
    }
  });
});

describe("CORS", () => {
  test("a preflight from a trusted origin may send credentials; any other origin may not", async () => {
    const trusted = await call(api.app, "/api/me", { method: "OPTIONS", headers: { origin: "http://localhost:3000" } });
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");
    expect(trusted.headers.get("access-control-allow-methods")).toContain("PATCH");
    const other = await call(api.app, "/rpc/me", { method: "OPTIONS", headers: { origin: "https://elsewhere.test" } });
    expect(other.headers.get("access-control-allow-origin")).toBe("*");
    expect(other.headers.get("access-control-allow-credentials")).toBeNull();
    const none = await call(api.app, "/api/me", { method: "OPTIONS" });
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a trusted origin that is not a URL is matched as written", async () => {
    const app = createApp({ ...api.deps, env: { ...api.deps.env, AUTH_TRUSTED_ORIGINS: ["app-shell"] } });
    const r = await call(app, "/api/me", { method: "OPTIONS", headers: { origin: "app-shell" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("app-shell");
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("another origin's request loses its session cookie", async () => {
    const me = await signUpAndSignIn(api);
    const cookie = me.client.jar.header();
    const mine = await call(api.app, "/api/me", { headers: { cookie, origin: "http://localhost:3000" } });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    const theirs = await call(api.app, "/api/me", { headers: { cookie, origin: "https://elsewhere.test" } });
    expect(theirs.status).toBe(401);
    expect(theirs.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("raw routes", () => {
  test("the overlay stream takes GET with an overlay token only", async () => {
    expect((await call(api.app, "/overlay/events", { method: "POST" })).status).toBe(405);
    const anon = await call(api.app, "/overlay/events", {}, addr());
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await call(api.app, "/overlay/events?token=not-a-token", {}, addr())).status).toBe(401);
  });

  test("federation is 404 while off; on, a route answers only its method", async () => {
    expect((await call(api.app, WELL_KNOWN_PATHS.webfinger)).status).toBe(404);
    const env = api.deps.env as unknown as Record<string, unknown>;
    env.FEDERATION_ENABLED = true;
    try {
      const wrong = await call(api.app, WELL_KNOWN_PATHS.webfinger, { method: "POST" });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get("allow")).toBe("GET");
      // Server to server: a cookie sent along is dropped, and the route still answers.
      const withCookie = await call(api.app, `${WELL_KNOWN_PATHS.webfinger}?resource=acct:nobody@elsewhere.test`, {
        headers: { cookie: "commonair.session_token=x" },
      });
      expect(withCookie.status).toBeLessThan(500);
      expect(withCookie.status).not.toBe(405);
    } finally {
      env.FEDERATION_ENABLED = false;
    }
  });

  test("the portability key history is GET only", async () => {
    const ok = await call(api.app, WELL_KNOWN_PATHS.portability);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/json");
    expect((await call(api.app, WELL_KNOWN_PATHS.portability, { method: "POST" })).status).toBe(405);
  });

  test("the Twitch import callback does not exist without its flag and credentials", async () => {
    const r = await call(api.app, `${TWITCH_IMPORT_CALLBACK_PATH}?code=x&state=y`);
    expect(r.status).toBe(404);
  });

  test("the OpenAPI document is public and cached; ALTCHA hands out a challenge", async () => {
    const doc = await call(api.app, "/api/openapi.json");
    expect(doc.status).toBe(200);
    expect(doc.headers.get("cache-control")).toBe("public, max-age=300");
    expect(((await doc.json()) as { openapi?: string }).openapi).toMatch(/^3\./);
    const ch = await call(api.app, AUTH_ROUTES.altchaChallenge, { headers: { origin: "https://elsewhere.test" } });
    expect(ch.status).toBe(200);
    expect(await ch.json()).toHaveProperty("parameters");
    // First-party only: no CORS for another origin.
    expect(ch.headers.get("access-control-allow-origin")).toBeNull();
    const mine = await call(api.app, AUTH_ROUTES.altchaChallenge, { headers: { origin: "http://localhost:3000" } });
    expect(mine.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  test("an unknown path is a JSON 404", async () => {
    for (const p of ["/api/no-such-route", "/nothing"]) {
      const r = await call(api.app, p);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ code: "NOT_FOUND", message: "Not found" });
    }
  });

  test("the Stripe webhook route exists only with the Stripe adapter, and wants a signature", async () => {
    const env = api.deps.env as unknown as Record<string, unknown>;
    expect((await call(api.app, "/api/webhooks/stripe", { method: "POST", body: "{}" })).status).toBe(404);
    const saved = { p: env.PAYMENTS_PROVIDER, k: env.STRIPE_SECRET_KEY, w: env.STRIPE_WEBHOOK_SECRET };
    Object.assign(env, {
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_http",
      STRIPE_WEBHOOK_SECRET: "whsec_http",
    });
    try {
      const r = await call(api.app, "/api/webhooks/stripe", { method: "POST", body: "{}" }, addr());
      expect(r.status).toBe(400);
    } finally {
      Object.assign(env, { PAYMENTS_PROVIDER: saved.p, STRIPE_SECRET_KEY: saved.k, STRIPE_WEBHOOK_SECRET: saved.w });
    }
  });

  test("the OAuth token endpoint refuses an empty request, with CORS for any origin", async () => {
    const r = await call(api.app, "/api/oauth2/token", {
      method: "POST",
      headers: { origin: "https://elsewhere.test", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(r.status).toBe(400);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("limits", () => {
  const tight = (over: Partial<Deps["rateLimits"]>) =>
    createApp({ ...api.deps, rateLimits: { ...api.deps.rateLimits, ...over } });

  test("auth writes are limited per address, with retry-after; GETs are not", async () => {
    const app = tight({ auth: { max: 1, windowMs: 60_000 } });
    const from = addr();
    const post = () =>
      call(
        app,
        "/api/auth/sign-in/email",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ email: "nobody@test.invalid", password: "wrong-password-1" }),
        },
        from,
      );
    expect((await post()).status).not.toBe(429);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(((await limited.json()) as { data: { retryAfterSeconds: number } }).data.retryAfterSeconds).toBeGreaterThan(
      0,
    );
  });

  test("the overlay stream is limited per address before the token is looked at", async () => {
    const app = tight({ default: { max: 1, windowMs: 60_000 } });
    const from = addr();
    expect((await call(app, "/overlay/events", {}, from)).status).toBe(401);
    const r = await call(app, "/overlay/events", {}, from);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  test("one-click unsubscribe: GET sends the reader to the confirm page", async () => {
    const r = await call(api.app, "/api/email/unsubscribe?token=abc", {}, addr());
    expect(r.status).toBe(303);
    expect(r.headers.get("location")?.startsWith(api.deps.site.publicUrl)).toBe(true);
  });

  test("an API procedure's 429 carries retry-after for plain HTTP clients", async () => {
    const app = tight({ default: { max: 1, windowMs: 60_000 } });
    const from = addr();
    await call(app, "/api/instance", {}, from);
    const r = await call(app, "/api/instance", {}, from);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    const rpc = await call(
      app,
      "/rpc/instance/info",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      from,
    );
    expect(rpc.status).toBe(429);
    expect(rpc.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("logging and failures", () => {
  test("dev-only flags warn when the app is built", () => {
    const { lines, logger } = captured();
    createApp({
      ...api.deps,
      logger,
      env: {
        ...api.deps.env,
        COOP_TEST_HOOKS: true,
        OPS_TEST_HOOKS: true,
        INTERACT_TEST_HOOKS: true,
        WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: true,
      },
    });
    const warned = lines.filter((l) => l.level === "warn").map((l) => l.msg.split(" ")[0]);
    expect(warned).toEqual([
      "COOP_TEST_HOOKS",
      "OPS_TEST_HOOKS",
      "INTERACT_TEST_HOOKS",
      "WEB_PUSH_ALLOW_INSECURE_ENDPOINTS",
    ]);
  });

  test("X-Forwarded-For from an untrusted private peer is warned about once", async () => {
    const { lines, logger } = captured();
    const app = createApp({ ...api.deps, logger });
    for (let i = 0; i < 3; i++)
      await app.fetch(
        new Request(`${api.url}/api/instance`, { headers: { "x-forwarded-for": addr() } }),
        peer("10.250.0.9"),
      );
    expect(lines.filter((l) => l.msg.includes("TRUSTED_PROXY_CIDRS"))).toHaveLength(1);
  });

  test("a failure outside a procedure is a bare 500; an ORPCError keeps its code and status", async () => {
    const { lines, logger } = captured();
    const failing = (err: unknown) =>
      createApp({
        ...api.deps,
        logger,
        rateLimitStore: { ...api.deps.rateLimitStore, hit: () => Promise.reject(err) },
      });
    const boom = await call(failing(new Error("valkey down: secret detail")), "/overlay/events", {}, addr());
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(JSON.parse(text)).toEqual({ code: "INTERNAL_SERVER_ERROR", message: "Internal server error" });
    expect(text).not.toContain("secret detail");
    expect(lines.some((l) => l.level === "error" && l.msg === "request failed")).toBe(true);
    const typed = await call(
      failing(new ORPCError("PRECONDITION_FAILED", { status: 412, message: "nope" })),
      "/overlay/events",
      {},
      addr(),
    );
    expect(typed.status).toBe(412);
    expect(await typed.json()).toEqual({ code: "PRECONDITION_FAILED", message: "nope" });
  });
});
