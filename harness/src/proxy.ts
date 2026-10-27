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
import { type Cidr, intToIp } from "./cidrs.ts";

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

// ------------------------------------------------------------------ tracker WebSocket mode

/**
 * The playback session id (`sid` claim) of a playback token (`<base64url json>.<signature>`, as
 * apps/web/src/player/source.ts reads it), or null. Not verified: the tracker verifies tokens.
 */
export function sessionIdFromToken(token: string | null | undefined): string | null {
  const body = token?.split(".")[0];
  if (!body) return null;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    const sid: unknown = (JSON.parse(json) as { sid?: unknown }).sid;
    return typeof sid === "string" && /^[0-9a-f-]{36}$/i.test(sid) ? sid.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * A residential address for a playback session, the same on every call: one /24 per session
 * (a /24 inside a /24-or-larger range of `cidrs`, chosen by a hash of the session id), so the
 * tracker sees each viewer on its own network and P2P evidence can link them (ADR 0005
 * decision 4). Two sessions share a /24 only on a hash collision.
 */
export function sessionAddress(sessionId: string, cidrs: readonly Cidr[]): string {
  const usable = cidrs.filter((c) => c.prefix <= 24);
  if (usable.length === 0) throw new Error("no residential range of /24 or larger");
  const h = new Bun.CryptoHasher("sha256").update(sessionId).digest();
  const word = (i: number) => h.readUInt32BE(i);
  const cidr = usable[word(0) % usable.length] as Cidr;
  const nets = 2 ** (24 - cidr.prefix);
  const net = word(4) % nets;
  const host = 1 + (word(8) % 254);
  return intToIp(cidr.base + net * 256 + host);
}

export interface TrackerProxyOptions {
  /** The tracker's WebSocket URL, e.g. `ws://localhost:8000`. */
  target: string;
  /** Fixed loopback port (the harness compose override points P2P_TRACKER_URL at it). */
  port: number;
  /** Residential ranges to draw session addresses from. */
  cidrs: readonly Cidr[];
}

interface TrackerSocketData {
  query: string;
  forwardedFor: string;
  upstream?: WebSocket;
  pending: (string | Uint8Array<ArrayBuffer>)[];
}

/**
 * WebSocket proxy in front of the tracker: each socket is forwarded with `x-forwarded-for` set to
 * its session's address (`sessionAddress` of the `t` token's `sid`), through the same trust path
 * as the API proxy (the tracker trusts the header from the compose network, TRUSTED_PROXY_CIDRS).
 * A socket without a readable token is refused, as the tracker would refuse it.
 */
export function startTrackerProxy(opts: TrackerProxyOptions): ForwardingProxy {
  const target = new URL(opts.target);
  const server = Bun.serve<TrackerSocketData>({
    hostname: "127.0.0.1",
    port: opts.port,
    idleTimeout: 120,
    fetch(req, srv) {
      const url = new URL(req.url);
      const sid = sessionIdFromToken(url.searchParams.get("t"));
      if (!sid) return new Response("no playback token", { status: 401 });
      const data: TrackerSocketData = {
        query: url.search,
        forwardedFor: sessionAddress(sid, opts.cidrs),
        pending: [],
      };
      return srv.upgrade(req, { data }) ? undefined : new Response("expected a WebSocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(`${target.origin}${target.pathname.replace(/\/+$/, "")}/${ws.data.query}`, {
          // Bun's WebSocket client takes request headers.
          headers: { "x-forwarded-for": ws.data.forwardedFor },
        } as unknown as string[]);
        up.binaryType = "nodebuffer" as BinaryType;
        ws.data.upstream = up;
        up.addEventListener("open", () => {
          for (const m of ws.data.pending) up.send(m);
          ws.data.pending = [];
        });
        up.addEventListener("message", (e) => ws.send(e.data as string | Buffer));
        up.addEventListener("close", (e) => ws.close(e.code === 1005 ? 1000 : e.code, e.reason));
        up.addEventListener("error", () => ws.close(1011, "tracker unreachable"));
      },
      message(ws, message) {
        const m = typeof message === "string" ? message : new Uint8Array(message);
        const up = ws.data.upstream;
        if (up?.readyState === WebSocket.OPEN) up.send(m);
        else ws.data.pending.push(m);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
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
