// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public face of the API's readiness. Caddy rewrites `/readyz/api` here (infra/caddy/Caddyfile)
 * for the status page's outside probes; the service's own `/readyz` (packages/service/src/server.ts)
 * stays unlimited for compose health checks and internal probes, which never pass through Caddy.
 *
 * Each answer runs the readiness checks (a Postgres query, a Valkey ping), so an unauthenticated
 * caller is held to `DEFAULT_RATE_LIMITS.readyz` per hashed address. That budget is far above the
 * status stack's probe rate (one probe per target every `probeIntervalSeconds`, 5 s at the
 * fastest: 12 a minute), so the probe never sees a 429; a 429 would read as a failed sample.
 */
import type { RateLimitResult } from "./lib/ratelimit.ts";

/** Where Caddy sends `/readyz/api`. Not under `/internal/`: that prefix is 404 at Caddy. */
export const PUBLIC_READYZ_PATH = "/readyz/public";

const headers = { "cache-control": "no-store", "content-type": "application/json" };

export interface PublicReadyzDeps {
  /** One hit on the caller's readiness budget. */
  hit: () => Promise<RateLimitResult>;
  /** The service's own `/readyz` answer (pass or fail per check, never error text). */
  ready: () => Promise<Response>;
  logger: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export async function publicReadyz(method: string, d: PublicReadyzDeps): Promise<Response> {
  if (method !== "GET" && method !== "HEAD")
    return Response.json(
      { code: "METHOD_NOT_ALLOWED", message: "Use GET" },
      { status: 405, headers: { ...headers, allow: "GET, HEAD" } },
    );
  let rl: RateLimitResult | null = null;
  try {
    rl = await d.hit();
  } catch (err) {
    // Fail open: the limiter lives on Valkey, and readiness is what reports Valkey down. A 500
    // here would hide which check failed.
    d.logger.warn("readyz rate limiter unavailable", { errorName: (err as Error).name });
  }
  if (rl && !rl.allowed)
    return Response.json(
      { code: "RATE_LIMITED", message: "Too many requests" },
      { status: 429, headers: { ...headers, "retry-after": String(rl.retryAfterSeconds) } },
    );
  try {
    const res = await d.ready();
    // Relay status and body only: nothing else from the internal answer reaches the public.
    return new Response(method === "HEAD" ? null : await res.text(), { status: res.status, headers });
  } catch (err) {
    d.logger.warn("readyz self-probe failed", { errorName: (err as Error).name });
    return Response.json({ ok: false, checks: {} }, { status: 503, headers });
  }
}
