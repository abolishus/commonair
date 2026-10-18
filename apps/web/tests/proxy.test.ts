// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { createHandler, securityHeaders, staticPath } from "../src/server/http.ts";
import {
  HOP_BY_HOP,
  downstreamResponse,
  forwardedFor,
  isProxied,
  proxy,
  stripHopByHop,
  upstreamRequest,
} from "../src/server/proxy.ts";

const API = "http://api.internal:3001";
const TARGET = { api: API, publicUrl: "https://stream.example.org" };

describe("isProxied", () => {
  it("matches /api/* and /rpc only", () => {
    expect(isProxied("/api/auth/sign-in/email")).toBe(true);
    expect(isProxied("/rpc/me/get")).toBe(true);
    expect(isProxied("/rpc")).toBe(true);
    expect(isProxied("/api")).toBe(false);
    expect(isProxied("/apix/foo")).toBe(false);
    expect(isProxied("/rpcx")).toBe(false);
    expect(isProxied("/dashboard")).toBe(false);
    expect(isProxied("/internal/media/auth")).toBe(false);
  });
});

describe("stripHopByHop", () => {
  it("drops every hop-by-hop header and those named in Connection", () => {
    const h = new Headers({ "x-keep": "1", "x-secret-hop": "2", connection: "keep-alive, X-Secret-Hop" });
    for (const name of HOP_BY_HOP) if (name !== "connection") h.set(name, "v");
    const out = stripHopByHop(h);
    expect([...out.keys()]).toEqual(["x-keep"]);
  });

  it("keeps each set-cookie separately", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/; HttpOnly");
    h.append("set-cookie", "b=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    const out = stripHopByHop(h);
    expect(out.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]);
  });
});

describe("forwardedFor", () => {
  it("appends the client address to an existing chain", () => {
    expect(forwardedFor("203.0.113.9, 10.0.0.2", "10.0.0.3")).toBe("203.0.113.9, 10.0.0.2, 10.0.0.3");
  });
  it("starts a chain", () => {
    expect(forwardedFor(null, "2001:db8::1")).toBe("2001:db8::1");
  });
  it("unwraps IPv4-mapped IPv6 socket addresses", () => {
    expect(forwardedFor(null, "::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(forwardedFor(null, "::ffff:abcd")).toBe("::ffff:abcd");
  });
  it("keeps the incoming chain when the socket address is unknown", () => {
    expect(forwardedFor("203.0.113.9", null)).toBe("203.0.113.9");
    expect(forwardedFor(null, null)).toBeNull();
    expect(forwardedFor(" , ", null)).toBeNull();
  });
});

describe("upstreamRequest", () => {
  it("targets the API with the same path and query, without hop-by-hop headers or host", () => {
    const req = new Request("http://localhost:3000/rpc/me/get?x=1", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        cookie: "commonair.session_token=abc",
        origin: "http://localhost:3000",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        te: "trailers",
        upgrade: "websocket",
        "x-forwarded-for": "198.51.100.7",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const up = upstreamRequest(req, TARGET, "10.1.2.3");
    expect(up.url).toBe(`${API}/rpc/me/get?x=1`);
    expect(up.method).toBe("POST");
    expect(up.redirect).toBe("manual");
    for (const h of ["connection", "keep-alive", "te", "upgrade"]) expect(up.headers.has(h)).toBe(false);
    expect(up.headers.get("host")).not.toBe("localhost:3000");
    expect(up.headers.get("cookie")).toBe("commonair.session_token=abc");
    expect(up.headers.get("origin")).toBe("http://localhost:3000");
    expect(up.headers.get("x-forwarded-for")).toBe("198.51.100.7, 10.1.2.3");
    expect(up.headers.get("x-forwarded-host")).toBe("stream.example.org");
    expect(up.headers.get("x-forwarded-proto")).toBe("https");
  });

  it("drops client-sent forwarding headers and reports the configured public origin", () => {
    const req = new Request("http://evil.example:3000/rpc/me/get", {
      headers: {
        forwarded: "for=1.2.3.4;host=evil.example",
        "x-real-ip": "1.2.3.4",
        "x-forwarded-host": "evil.example",
        "x-forwarded-port": "8443",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/admin",
      },
    });
    const up = upstreamRequest(req, TARGET, "10.0.0.9");
    for (const h of ["forwarded", "x-real-ip", "x-forwarded-port", "x-forwarded-prefix"])
      expect(up.headers.has(h)).toBe(false);
    expect(up.headers.get("x-forwarded-host")).toBe("stream.example.org");
    expect(up.headers.get("x-forwarded-proto")).toBe("https");
    expect(up.headers.get("x-forwarded-for")).toBe("10.0.0.9");
  });

  it("sends no x-forwarded-for when there is no address at all", () => {
    const up = upstreamRequest(new Request("http://localhost/rpc/x"), TARGET, null);
    expect(up.headers.has("x-forwarded-for")).toBe(false);
  });

  it("sends no body for GET", () => {
    const up = upstreamRequest(new Request("http://localhost:3000/api/auth/altcha-challenge"), TARGET, "127.0.0.1");
    expect(up.body).toBeNull();
  });
});

describe("downstreamResponse", () => {
  it("passes status, redirects, cookies and body through", async () => {
    const headers = new Headers({ location: "/dashboard", "transfer-encoding": "chunked", "x-api": "1" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const res = downstreamResponse(new Response("moved", { status: 302, headers }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(res.headers.get("x-api")).toBe("1");
    expect(res.headers.has("transfer-encoding")).toBe(false);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await res.text()).toBe("moved");
  });
});

describe("proxy", () => {
  it("streams the request body upstream and the response back", async () => {
    let seen: { url: string; body: string; xff: string | null } | null = null;
    const fetcher = async (req: Request) => {
      seen = { url: req.url, body: await req.text(), xff: req.headers.get("x-forwarded-for") };
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("part1,"));
          c.enqueue(new TextEncoder().encode("part2"));
          c.close();
        },
      });
      return new Response(stream, { status: 201, headers: { "set-cookie": "s=1; HttpOnly" } });
    };
    const req = new Request("http://localhost:3000/api/auth/sign-up/email", { method: "POST", body: '{"a":1}' });
    const res = await proxy(req, TARGET, "192.0.2.4", fetcher);
    expect(seen).toEqual({ url: `${API}/api/auth/sign-up/email`, body: '{"a":1}', xff: "192.0.2.4" });
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toEqual(["s=1; HttpOnly"]);
    expect(await res.text()).toBe("part1,part2");
  });

  it("answers 502 when the API is unreachable", async () => {
    const res = await proxy(new Request("http://localhost:3000/rpc/x"), TARGET, null, () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("BAD_GATEWAY");
  });
});

describe("staticPath", () => {
  it("resolves files inside the root", () => {
    expect(staticPath("/app/dist/client/", "/assets/a.js")).toBe("/app/dist/client/assets/a.js");
  });
  it("refuses traversal, NUL and the root itself", () => {
    expect(staticPath("/app/dist/client", "/../server/server.js")).toBeNull();
    expect(staticPath("/app/dist/client", "/assets/%2e%2e/%2e%2e/server/server.js")).toBeNull();
    expect(staticPath("/app/dist/client", "/a%00b")).toBeNull();
    expect(staticPath("/app/dist/client", "/%E0%A4%A")).toBeNull();
    expect(staticPath("/app/dist/client", "/")).toBeNull();
  });
});

describe("createHandler", () => {
  const handler = createHandler({
    apiUrl: API,
    publicUrl: "https://stream.example.org",
    clientDir: "/nonexistent-dir-for-tests/",
    ssr: () => new Response("ssr"),
    fetchUpstream: async (req) => new Response(`api:${new URL(req.url).pathname}`),
  });

  it("answers /healthz and /readyz without SSR", async () => {
    for (const path of ["/healthz", "/readyz"]) {
      const res = await handler(new Request(`http://localhost${path}`), null);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    }
  });

  it("proxies API paths and renders everything else", async () => {
    expect(await (await handler(new Request("http://localhost/rpc/instance/info"), "127.0.0.1")).text()).toBe(
      "api:/rpc/instance/info",
    );
    expect(await (await handler(new Request("http://localhost/some_channel"), null)).text()).toBe("ssr");
    expect(await (await handler(new Request("http://localhost/assets/missing.js"), null)).text()).toBe("ssr");
  });

  it("protects pages from framing, except embeds", async () => {
    const page = await handler(new Request("http://localhost/some_channel"), null);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const embed = await handler(new Request("http://localhost/embed/some_channel"), null);
    expect(embed.headers.get("content-security-policy")).toBe("frame-ancestors *");
    const health = await handler(new Request("http://localhost/healthz"), null);
    expect(health.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });

  it("never lets shared caches store rendered pages", async () => {
    const page = await handler(new Request("http://localhost/dashboard"), null);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
  });

  it("leaves API responses' headers to the API", async () => {
    const res = await handler(new Request("http://localhost/rpc/instance/info"), null);
    expect(res.headers.has("content-security-policy")).toBe(false);
  });
});

describe("securityHeaders", () => {
  it("only treats /embed/ paths as embeddable", () => {
    expect(securityHeaders("/embed/x")["content-security-policy"]).toBe("frame-ancestors *");
    expect(securityHeaders("/embedded")["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(securityHeaders("/embed")["content-security-policy"]).toBe("frame-ancestors 'self'");
  });
});
