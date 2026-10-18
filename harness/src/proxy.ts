// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Forwarding proxy that gives each simulated client its own source address.
 *
 * The API trusts `x-forwarded-for` only from peers inside `TRUSTED_PROXY_CIDRS` (coreEnv). In a
 * harness run the stack sets `TRUSTED_PROXY_CIDRS=127.0.0.1/32` (or the harness host's address),
 * and every simulated client talks to the API through this proxy, tagging requests with
 * `x-harness-client-ip`. The proxy strips that tag and sets `x-forwarded-for` to it, so integrity
 * sees viewbots arriving from datacenter ranges and real-looking viewers from residential ranges.
 * Requests without a tag are forwarded without `x-forwarded-for`.
 */
import { SIMULATED_IP_HEADER } from "./api/client.ts";

/** Hop-by-hop headers never forwarded (RFC 9110 §7.6.1), plus ones fetch recomputes. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "content-length",
]);

export interface ForwardOptions {
  /** Upstream base URL, e.g. the API. */
  target: string;
  /** Path prefix to strip before forwarding (e.g. `/api-proxy`). */
  stripPrefix?: string;
  timeoutMs?: number;
}

/** Build the upstream request for an incoming one. Exported for unit tests. */
export function upstreamRequest(req: Request, opts: ForwardOptions): Request {
  const incoming = new URL(req.url);
  let path = incoming.pathname;
  if (opts.stripPrefix && path.startsWith(opts.stripPrefix)) path = path.slice(opts.stripPrefix.length) || "/";
  const target = new URL(opts.target);
  const url = new URL(`${target.pathname.replace(/\/+$/, "")}${path}${incoming.search}`, target.origin);
  const headers = new Headers();
  for (const [k, v] of req.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  const simulated = headers.get(SIMULATED_IP_HEADER);
  headers.delete(SIMULATED_IP_HEADER);
  headers.delete("x-forwarded-for");
  if (simulated && /^[\d.]+$|^[\da-f:]+$/i.test(simulated)) headers.set("x-forwarded-for", simulated);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
}

/** Forward and relay the response, keeping Set-Cookie and redirects intact for the client. */
export async function forward(req: Request, opts: ForwardOptions): Promise<Response> {
  try {
    const res = await fetch(upstreamRequest(req, opts));
    const headers = new Headers();
    for (const [k, v] of res.headers) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.has(key) || key === "content-encoding" || key === "set-cookie") continue;
      headers.set(k, v);
    }
    // Bun's fetch transparently decompresses, so the body is identity-encoded now.
    for (const cookie of res.headers.getSetCookie())
      headers.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/i, ""));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (err) {
    return new Response(`proxy upstream error: ${(err as Error).message}`, { status: 502 });
  }
}

export interface ForwardingProxy {
  url: string;
  stop(): Promise<void>;
}

/** Standalone proxy on a random loopback port. */
export function startForwardingProxy(opts: ForwardOptions): ForwardingProxy {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    fetch: (req) => forward(req, opts),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}
