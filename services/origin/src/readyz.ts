// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public face of the origin's readiness. Caddy rewrites `/readyz/origin` here
 * (infra/caddy/Caddyfile) for the status page's outside probes; the service's own `/readyz`
 * (packages/service/src/server.ts) stays unlimited for compose health checks and the API's status
 * probe, which never pass through Caddy.
 *
 * Each answer runs the readiness checks, so an unauthenticated caller gets `READYZ_PER_MINUTE`
 * per client address. That is far above the status stack's probe rate (one probe every
 * `probeIntervalSeconds`, 5 s at the fastest: 12 a minute), so the probe never sees a 429; a 429
 * would read as a failed sample. The counter is in process, like the relay-auth limiter
 * (`clientip.ts`): addresses stay in memory, never logged or persisted, and a replica's budget is
 * its own, which only makes the limit more generous.
 */
import { clientIp, FailureLimiter, parseCidr, type Cidr } from "./clientip.ts";

/** Where Caddy sends `/readyz/origin`. */
export const PUBLIC_READYZ_PATH = "/readyz/public";
export const READYZ_PER_MINUTE = 60;

const headers = { "cache-control": "no-store", "content-type": "application/json" };

export interface PublicReadyzOptions {
  /** TRUSTED_PROXY_CIDRS: Caddy's network, whose `X-Forwarded-For` names the client. */
  trustedProxyCidrs: string[];
  /** The service's own `/readyz` answer (pass or fail per check, never error text). */
  ready: () => Promise<Response>;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
  perMinute?: number;
  now?: () => number;
}

export function createPublicReadyz(
  opts: PublicReadyzOptions,
): (req: Request, peerIp: string | undefined) => Promise<Response> {
  const trusted = opts.trustedProxyCidrs.flatMap((c) => {
    const p = parseCidr(c);
    return p ? [p] : [];
  }) satisfies Cidr[];
  // Every hit counts (the limiter's "failure" is just a request here).
  const hits = new FailureLimiter(opts.perMinute ?? READYZ_PER_MINUTE, 60_000, 50_000, opts.now);
  return async (req, peerIp) => {
    if (req.method !== "GET" && req.method !== "HEAD")
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { ...headers, allow: "GET, HEAD" } },
      );
    const ip = clientIp(peerIp, req.headers.get("x-forwarded-for"), trusted) ?? "unknown";
    if (hits.blocked(ip))
      return Response.json(
        { error: "too_many_requests" },
        { status: 429, headers: { ...headers, "retry-after": "60" } },
      );
    hits.fail(ip);
    try {
      const res = await opts.ready();
      // Relay status and body only: nothing else from the internal answer reaches the public.
      return new Response(req.method === "HEAD" ? null : await res.text(), { status: res.status, headers });
    } catch (err) {
      opts.logger?.warn("readyz self-probe failed", { errorName: (err as Error).name });
      return Response.json({ ok: false, checks: {} }, { status: 503, headers });
    }
  };
}
