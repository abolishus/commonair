// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HTTP surface: OpenAPI (REST) under /api, oRPC RPC under /rpc, better-auth under
 * /api/auth, the OpenAPI document, ALTCHA challenges and the internal MediaMTX hooks.
 */
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { experimental_ZodSmartCoercionPlugin as ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import type { Server } from "bun";
import { AUTH_BASE_PATH, AUTH_ROUTES } from "@commonair/contracts/auth";
import { OVERLAY_EVENTS_PATH } from "@commonair/contracts/events";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { generateOpenApi } from "@commonair/contracts/openapi";
import { sourceLink } from "@commonair/config/site";
import { hmacHex, timingSafeEqual } from "@commonair/tokens";
import { newChallenge } from "./auth/altcha.ts";
import { createAuth, type Auth } from "./auth/index.ts";
import type { Deps } from "./deps.ts";
import { toClientError } from "./lib/errors.ts";
import { clientIp, looksProxied } from "./lib/ip.ts";
import { canonicalIp, rateLimitSubjectIp } from "./lib/netrange.ts";
import { overlayTokenOf, type BaseContext, type RequestInfo } from "./lib/orpc.ts";
import { rateLimitKey } from "./lib/ratelimit.ts";
import { coopHook, isCoopHookPath } from "./coop/hooks.ts";
import { isOpsHookPath, opsHook } from "./ops/hooks.ts";
import { overlayHub } from "./overlay/stream.ts";
import { overlayTokenHash, resolveOverlayToken } from "./overlay/tokens.ts";
import { mediaAuth, mediaNotReady, mediaReady } from "./media/hooks.ts";
import { isTestHookPath, testHook } from "./moderation/hooks.ts";
import { router } from "./router.ts";

const MAX_INTERNAL_BODY = 64 * 1024;
/** Same as `STRIPE_WEBHOOK_PATH` in money/stripe-webhook.ts (not imported: that module loads lazily). */
const STRIPE_WEBHOOK_ROUTE = "/api/webhooks/stripe";

export interface ApiApp {
  fetch(req: Request, server?: Pick<Server<undefined>, "requestIP">): Promise<Response>;
  auth: Auth;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export function createApp(deps: Deps): ApiApp {
  const auth = createAuth(deps);
  if (deps.env.COOP_TEST_HOOKS)
    deps.logger.warn(
      "COOP_TEST_HOOKS is on: POST /internal/coop/tick runs co-op jobs on demand; never on a public instance",
      {
        testHooks: true,
      },
    );
  if (deps.env.OPS_TEST_HOOKS)
    deps.logger.warn(
      "OPS_TEST_HOOKS is on: POST /internal/ops/tick runs deletion, export cleanup and VOD retention on demand; never on a public instance",
      { testHooks: true },
    );
  const allowedOrigins = new Set(
    [deps.site.publicUrl, ...deps.env.AUTH_TRUSTED_ORIGINS].map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return o;
      }
    }),
  );

  const clientInterceptors = [
    async ({ next, path }: { next: () => Promise<unknown>; path: readonly string[] }) => {
      try {
        return await next();
      } catch (err) {
        const mapped = toClientError(err);
        if (mapped.code === "INTERNAL_SERVER_ERROR")
          deps.logger.error("procedure failed", { procedure: path.join("."), err: mapped.cause ?? err });
        throw mapped;
      }
    },
  ];
  const rpc = new RPCHandler(router, { clientInterceptors: [...clientInterceptors] });
  // Each handler gets its own array: oRPC plugins push their interceptors into it.
  // REST query strings and path params arrive as strings; coerce them to the schema's types.
  const openapi = new OpenAPIHandler(router, {
    clientInterceptors: [...clientInterceptors],
    plugins: [new ZodSmartCoercionPlugin()],
  });

  let openApiDoc: Promise<unknown> | null = null;
  const openApiDocument = () =>
    (openApiDoc ??= generateOpenApi({
      title: deps.site.name,
      version: deps.version,
      serverUrl: `${deps.env.API_PUBLIC_URL.replace(/\/+$/, "")}/api`,
      sourceUrl: sourceLink(deps.site),
    }));

  const internalAuthorized = (req: Request) =>
    timingSafeEqual(req.headers.get(INTERNAL_SECRET_HEADER) ?? "", deps.env.INTERNAL_API_SECRET);

  async function readJson(req: Request): Promise<unknown> {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_INTERNAL_BODY) return null;
    const text = await req.text();
    if (text.length > MAX_INTERNAL_BODY) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    if (!origin) return {};
    if (allowedOrigins.has(origin))
      return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" };
    // Other origins may call with bearer tokens, never with cookies.
    return { "access-control-allow-origin": "*", vary: "Origin" };
  }

  function preflight(req: Request): Response {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(req),
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      },
    });
  }

  let warnedUntrustedProxy = false;

  async function requestInfo(
    req: Request,
    url: URL,
    server?: Pick<Server<undefined>, "requestIP">,
  ): Promise<RequestInfo> {
    const socketIp = server?.requestIP(req as Request)?.address ?? "0.0.0.0";
    const forwardedFor = req.headers.get("x-forwarded-for");
    // Canonical form, so every spelling of one client hashes alike here and in media/hooks.ts.
    const ip = canonicalIp(clientIp(socketIp, forwardedFor, deps.env.TRUSTED_PROXY_CIDRS));
    if (!warnedUntrustedProxy && looksProxied(socketIp, forwardedFor, deps.env.TRUSTED_PROXY_CIDRS)) {
      warnedUntrustedProxy = true;
      deps.logger.warn(
        "requests carry X-Forwarded-For from an untrusted private peer: every client behind that proxy shares one rate-limit subject; set TRUSTED_PROXY_CIDRS",
      );
    }
    return {
      headers: req.headers,
      url,
      method: req.method,
      ip,
      ipHash: await hmacHex(deps.env.AUTH_SECRET, `ip:${ip}`),
      rateLimitHash: await hmacHex(deps.env.AUTH_SECRET, `rl:${rateLimitSubjectIp(ip)}`),
      userAgent: req.headers.get("user-agent"),
    };
  }

  /** Cross-origin requests from origins we do not trust lose their cookies. */
  function stripCredentials(req: Request): Request {
    const origin = req.headers.get("origin");
    if (!origin || allowedOrigins.has(origin) || !req.headers.has("cookie")) return req;
    const headers = new Headers(req.headers);
    headers.delete("cookie");
    return new Request(req, { headers });
  }

  /** The overlay alert stream (SSE). Authenticated only by the overlay token; cookies are ignored. */
  async function overlayEvents(
    raw: Request,
    url: URL,
    server?: Pick<Server<undefined>, "requestIP">,
  ): Promise<Response> {
    if (raw.method !== "GET") return json({ code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405);
    const info = await requestInfo(raw, url, server);
    const nowMs = deps.now().getTime();
    const rl = await deps.rateLimitStore.hit(
      rateLimitKey("default", `ip:${info.rateLimitHash}`),
      deps.rateLimits.default,
      nowMs,
      `${nowMs}:${crypto.randomUUID()}`,
    );
    if (!rl.allowed)
      return json({ code: "RATE_LIMITED", message: "Too many requests" }, 429, {
        "retry-after": String(rl.retryAfterSeconds),
      });
    const token = overlayTokenOf(info);
    const resolved = token ? await resolveOverlayToken(deps.db, token, deps.now()) : null;
    if (!token || !resolved) return json({ code: "UNAUTHORIZED", message: "A valid overlay token is required" }, 401);
    return overlayHub(deps).open(resolved, await overlayTokenHash(token), raw.signal);
  }

  async function handle(raw: Request, server?: Pick<Server<undefined>, "requestIP">): Promise<Response> {
    const url = new URL(raw.url);
    const path = url.pathname;

    if (path === INTERNAL_ROUTES.mediaAuth && raw.method === "POST")
      return new Response(null, { status: await mediaAuth(deps, await readJson(raw)) });
    if ((path === INTERNAL_ROUTES.mediaReady || path === INTERNAL_ROUTES.mediaNotReady) && raw.method === "POST") {
      if (!internalAuthorized(raw)) return new Response(null, { status: 401 });
      const body = await readJson(raw);
      const status =
        path === INTERNAL_ROUTES.mediaReady ? await mediaReady(deps, body) : await mediaNotReady(deps, body);
      return new Response(null, { status });
    }
    if (isTestHookPath(path)) {
      // Disabled hooks answer 404 before the secret check, like any unknown internal path.
      if (!deps.env.MODERATION_TEST_HOOKS) return new Response(null, { status: 404 });
      if (!internalAuthorized(raw)) return new Response(null, { status: 401 });
      return testHook(deps, path, raw.method, await readJson(raw));
    }
    if (isCoopHookPath(path)) {
      // Off: 404 before the secret check, like any unknown internal path.
      if (!deps.env.COOP_TEST_HOOKS) return new Response(null, { status: 404 });
      if (!internalAuthorized(raw)) return new Response(null, { status: 401 });
      return coopHook(deps, raw.method, await readJson(raw));
    }
    if (isOpsHookPath(path)) {
      // Off: 404 before the secret check, like any unknown internal path.
      if (!deps.env.OPS_TEST_HOOKS) return new Response(null, { status: 404 });
      if (!internalAuthorized(raw)) return new Response(null, { status: 401 });
      return opsHook(deps, raw.method, await readJson(raw));
    }
    if (path.startsWith("/internal/")) return new Response(null, { status: 404 });

    // Stripe webhooks: server to server, signature-authenticated, no cookies or CORS. The module
    // (and with it every Stripe module) loads only when the Stripe adapter is configured.
    if (path === STRIPE_WEBHOOK_ROUTE && deps.env.PAYMENTS_PROVIDER === "stripe") {
      const { handleStripeWebhook } = await import("./money/stripe-webhook.ts");
      const info = await requestInfo(raw, url, server);
      return handleStripeWebhook(deps, raw, info.rateLimitHash);
    }

    if (raw.method === "OPTIONS" && (path.startsWith("/api/") || path.startsWith("/rpc/"))) return preflight(raw);
    const cors = corsHeaders(raw);
    const withCors = (res: Response) => {
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    };

    if (path === OVERLAY_EVENTS_PATH) return withCors(await overlayEvents(raw, url, server));

    if (path === "/api/openapi.json" && raw.method === "GET")
      return withCors(json(await openApiDocument(), 200, { "cache-control": "public, max-age=300" }));

    if (path.startsWith(`${AUTH_BASE_PATH}/`)) {
      const origin = raw.headers.get("origin");
      // Auth is first-party only: no CORS for other origins.
      const authCors = origin && allowedOrigins.has(origin) ? cors : {};
      const info = await requestInfo(raw, url, server);
      if (path === AUTH_ROUTES.altchaChallenge && raw.method === "GET") {
        const challenge = await newChallenge({ hmacKey: deps.env.ALTCHA_HMAC_KEY, now: () => deps.now().getTime() });
        return json(challenge, 200, authCors);
      }
      if (raw.method !== "GET") {
        const nowMs = deps.now().getTime();
        const rl = await deps.rateLimitStore.hit(
          rateLimitKey("auth", `ip:${info.rateLimitHash}`),
          deps.rateLimits.auth,
          nowMs,
          `${nowMs}:${crypto.randomUUID()}`,
        );
        if (!rl.allowed)
          return json(
            { code: "RATE_LIMITED", message: "Too many requests", data: { retryAfterSeconds: rl.retryAfterSeconds } },
            429,
            { ...authCors, "retry-after": String(rl.retryAfterSeconds) },
          );
      }
      const res = await auth.handler(raw);
      for (const [k, v] of Object.entries(authCors)) res.headers.set(k, v);
      return res;
    }

    const isRpc = path === "/rpc" || path.startsWith("/rpc/");
    if (isRpc || path.startsWith("/api/")) {
      const req = stripCredentials(raw);
      const context: BaseContext = { deps, auth, req: await requestInfo(req, url, server) };
      const result = isRpc
        ? await rpc.handle(req, { prefix: "/rpc", context })
        : await openapi.handle(req, { prefix: "/api", context });
      if (result.matched) {
        const res = result.response;
        if (res.status === 429) {
          // Surface the retry hint to HTTP clients too.
          const body = (await res
            .clone()
            .json()
            .catch(() => null)) as { data?: { retryAfterSeconds?: number } } | null;
          const after =
            body?.data?.retryAfterSeconds ??
            (body as { json?: { data?: { retryAfterSeconds?: number } } } | null)?.json?.data?.retryAfterSeconds;
          if (after) res.headers.set("retry-after", String(after));
        }
        if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store");
        return withCors(res);
      }
    }
    return withCors(json({ code: "NOT_FOUND", message: "Not found" }, 404));
  }

  return {
    auth,
    async fetch(req, server) {
      try {
        return await handle(req, server);
      } catch (err) {
        if (err instanceof ORPCError) return json({ code: err.code, message: err.message }, err.status);
        deps.logger.error("request failed", { err, path: new URL(req.url).pathname, method: req.method });
        return json({ code: "INTERNAL_SERVER_ERROR", message: "Internal server error" }, 500);
      }
    },
  };
}
