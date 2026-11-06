// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The origin's public readiness route (`/readyz/origin` at Caddy): its own `/readyz` answer relayed
 * under a per-address budget the status probe never reaches.
 */
import { describe, expect, test } from "vite-plus/test";
import { createPublicReadyz, READYZ_PER_MINUTE } from "../src/readyz.ts";

const okBody = JSON.stringify({ ok: true, checks: { postgres: "ok", valkey: "ok", mediamtx: "ok" } });
const caddy = "10.89.42.7";
const req = (client?: string, method = "GET") =>
  new Request("http://origin/readyz/public", { method, headers: client ? { "x-forwarded-for": client } : {} });

function make(ready: () => Promise<Response> = async () => new Response(okBody, { headers: { "x-internal": "1" } })) {
  const t = { ms: 0 };
  const handler = createPublicReadyz({ trustedProxyCidrs: ["10.89.42.0/24"], ready, now: () => t.ms });
  return { handler, t };
}

describe("createPublicReadyz", () => {
  test("relays status and body, no-store, none of the internal headers", async () => {
    const { handler } = make();
    const res = await handler(req("198.51.100.1"), caddy);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(okBody);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-internal")).toBeNull();

    const down = make(async () => Response.json({ ok: false, checks: { mediamtx: "fail" } }, { status: 503 }));
    expect((await down.handler(req("198.51.100.1"), caddy)).status).toBe(503);
  });

  test("HEAD has no body; other methods are 405", async () => {
    const { handler } = make();
    const head = await handler(req("198.51.100.1", "HEAD"), caddy);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await handler(req("198.51.100.1", "POST"), caddy)).status).toBe(405);
  });

  test("60 a minute per client address; others keep theirs; the window resets", async () => {
    expect(READYZ_PER_MINUTE).toBe(60);
    let probed = 0;
    const { handler, t } = make(async () => {
      probed++;
      return new Response(okBody);
    });
    for (let i = 0; i < 60; i++) expect((await handler(req("198.51.100.1"), caddy)).status).toBe(200);
    const limited = await handler(req("198.51.100.1"), caddy);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(probed).toBe(60);
    expect((await handler(req("203.0.113.9"), caddy)).status).toBe(200);
    // An untrusted peer's X-Forwarded-For is ignored: the peer itself is the key.
    expect((await handler(req("198.51.100.1"), "192.0.2.50")).status).toBe(200);
    t.ms = 60_000;
    expect((await handler(req("198.51.100.1"), caddy)).status).toBe(200);
  });

  test("the status probe at its fastest (every 5 s) is never limited", async () => {
    const { handler, t } = make();
    for (let i = 0; i < 12 * 60; i++, t.ms += 5000)
      expect((await handler(req("198.51.100.77"), caddy)).status).toBe(200);
  });

  test("an invalid TRUSTED_PROXY_CIDRS entry is ignored, not trusted; the valid ones still are", async () => {
    let t = 0;
    const handler = createPublicReadyz({
      trustedProxyCidrs: ["not-a-cidr", "10.89.42.0/33", "10.89.42.0/24"],
      ready: async () => new Response(okBody),
      perMinute: 1,
      now: () => t,
    });
    // Caddy's forwarded clients each get their own budget...
    expect((await handler(req("198.51.100.1"), caddy)).status).toBe(200);
    expect((await handler(req("198.51.100.2"), caddy)).status).toBe(200);
    expect((await handler(req("198.51.100.1"), caddy)).status).toBe(429);
    // ...but nothing makes an untrusted peer's header count.
    expect((await handler(req("198.51.100.3"), "192.0.2.9")).status).toBe(200);
    expect((await handler(req("198.51.100.4"), "192.0.2.9")).status).toBe(429);
    t = 60_000;
    expect((await handler(req("198.51.100.4"), "192.0.2.9")).status).toBe(200);
  });

  test("without a peer address every such request shares one budget", async () => {
    const handler = createPublicReadyz({
      trustedProxyCidrs: [],
      ready: async () => new Response(okBody),
      perMinute: 2,
    });
    expect((await handler(req(), undefined)).status).toBe(200);
    expect((await handler(req("198.51.100.1"), undefined)).status).toBe(200);
    expect((await handler(req("198.51.100.2"), undefined)).status).toBe(429);
  });

  test("a failed self-probe logs the error's name only", async () => {
    const warnings: unknown[][] = [];
    const handler = createPublicReadyz({
      trustedProxyCidrs: [],
      ready: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      logger: { warn: (...args: unknown[]) => void warnings.push(args) },
    });
    expect((await handler(req(), "192.0.2.1")).status).toBe(503);
    expect(warnings).toEqual([["readyz self-probe failed", { errorName: "TimeoutError" }]]);
  });

  test("an unreachable listener is a plain 503, with no error text", async () => {
    const { handler } = make(() => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:3003")));
    const res = await handler(req("198.51.100.1"), caddy);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, checks: {} });
  });
});
