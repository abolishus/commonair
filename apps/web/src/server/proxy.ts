// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Same-origin reverse proxy for `/api/*` and `/rpc/*` to the API. Same origin keeps better-auth
 * cookies first-party and lets the verification link (PUBLIC_URL + /api/auth/…) work.
 * Bodies stream in both directions; redirects and `set-cookie` reach the browser untouched.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** RFC 9110 §7.6.1 connection-specific headers, plus the de-facto `proxy-connection`. */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const PROXIED_PREFIXES = ["/api/", "/rpc/"] as const;

export function isProxied(pathname: string): boolean {
  return pathname === "/rpc" || PROXIED_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Copy headers minus hop-by-hop ones, including any named in `Connection`. */
export function stripHopByHop(source: Headers): Headers {
  const named = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Headers();
  for (const [k, v] of source) {
    if (HOP_BY_HOP.has(k) || named.has(k) || k === "set-cookie") continue;
    out.append(k, v);
  }
  // `Headers` iteration may fold cookies; re-add each one so none is lost or merged.
  for (const c of source.getSetCookie()) out.append("set-cookie", c);
  return out;
}

/** Dual-stack sockets report IPv4 peers as `::ffff:a.b.c.d`; forward the plain IPv4 form. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

/** Append the client's socket address to any `x-forwarded-for` chain (the API decides whom to trust). */
export function forwardedFor(existing: string | null, clientAddress: string | null): string | null {
  const chain = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (clientAddress) chain.push(normalizeAddress(clientAddress));
  return chain.length > 0 ? chain.join(", ") : null;
}

/** Forwarding headers a client could forge; the proxy sets its own (`x-forwarded-for` is appended to). */
export const CLIENT_FORWARDING_HEADERS = [
  "forwarded",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-prefix",
] as const;

export interface UpstreamTarget {
  /** API_INTERNAL_URL. */
  api: string;
  /** PUBLIC_URL: the origin browsers use, reported as x-forwarded-host/proto. */
  publicUrl: string;
}

export function upstreamRequest(req: Request, target: UpstreamTarget, clientAddress: string | null): Request {
  const url = new URL(req.url);
  const upstream = new URL(`${url.pathname}${url.search}`, target.api);
  const headers = stripHopByHop(req.headers);
  headers.delete("host");
  for (const h of CLIENT_FORWARDING_HEADERS) headers.delete(h);
  const xff = forwardedFor(req.headers.get("x-forwarded-for"), clientAddress);
  if (xff) headers.set("x-forwarded-for", xff);
  else headers.delete("x-forwarded-for");
  // From config, not from the request: the Host header is client-controlled.
  const pub = new URL(target.publicUrl);
  headers.set("x-forwarded-host", pub.host);
  headers.set("x-forwarded-proto", pub.protocol.replace(":", ""));
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(upstream, {
    method: req.method,
    headers,
    body: hasBody ? req.body : null,
    redirect: "manual",
    // Required by fetch for streaming request bodies.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

export function downstreamResponse(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: stripHopByHop(res.headers),
  });
}

export type Fetcher = (req: Request) => Promise<Response>;

/** Bun-specific `decompress: false` keeps encoded bodies and their content-encoding consistent. */
const bunFetch: Fetcher = (req) => fetch(req, { redirect: "manual", decompress: false } as RequestInit);

/** Where an upstream failure is reported; the path only, since a query can carry a token. */
export type ProxyFailureLog = (fields: { path: string; error: string }) => void;

/** The path to report for a proxied request: `/rpc/...` in full, `/api/...` cut to three segments. */
export function reportablePath(pathname: string): string {
  if (pathname === "/rpc" || pathname.startsWith("/rpc/")) return pathname;
  // `/api/auth/<flow>/<token>`: anything past the flow name may be a secret.
  return pathname.split("/").slice(0, 4).join("/");
}

export async function proxy(
  req: Request,
  target: UpstreamTarget,
  clientAddress: string | null,
  doFetch: Fetcher = bunFetch,
  onFailure?: ProxyFailureLog,
): Promise<Response> {
  try {
    return downstreamResponse(await doFetch(upstreamRequest(req, target, clientAddress)));
  } catch (err) {
    // A silent 502 left the browser's "could not load" state as the only trace; say what failed.
    onFailure?.({
      path: reportablePath(new URL(req.url).pathname),
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return Response.json(
      { code: "BAD_GATEWAY", message: "API unavailable" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

// ------------------------------------------------------------------ the render's own API calls

/**
 * The forwarding chain of the request being rendered. Server rendering and server functions call
 * the API themselves (`serverApi`, in the SSR bundle); without the chain every anonymous visitor's
 * render would share the web server's own address as one rate-limit subject.
 */
const renderChain = new AsyncLocalStorage<string | null>();

/** Run `fn` (an SSR render) with the visitor's `x-forwarded-for` chain, for `forwardingFetch`. */
export function withForwardedFor<T>(chain: string | null, fn: () => T): T {
  return renderChain.run(chain, fn);
}

/**
 * `base`, plus the rendering request's chain on requests to the API that set no
 * `x-forwarded-for` of their own. Any other request, and every request outside a render, passes
 * through untouched. The chain is what `forwardedFor` built from the request this server accepted,
 * exactly as for proxied calls, so the API still believes only the hops it trusts. Bun's own fetch
 * options (`decompress`, `proxy`, …) are not carried over on the requests it changes.
 */
export function forwardingFetch(base: typeof fetch, apiUrl: string): typeof fetch {
  const apiOrigin = new URL(apiUrl).origin;
  const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const chain = renderChain.getStore();
    const url = input instanceof Request ? input.url : String(input);
    if (!chain || URL.parse(url)?.origin !== apiOrigin) return base(input, init);
    const req = new Request(input, init);
    if (req.headers.has("x-forwarded-for")) return base(req);
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-for", chain);
    return base(new Request(req, { headers }));
  };
  return Object.assign(wrapped, { preconnect: base.preconnect });
}
