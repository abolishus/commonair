// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public readiness route (`/readyz/api` at Caddy): the service's own answer relayed under a
 * per-address budget that the status probe's rate never reaches.
 */
import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_RATE_LIMITS, memoryRateLimitStore, rateLimitKey } from "../src/lib/ratelimit.ts";
import { publicReadyz, type PublicReadyzDeps } from "../src/readyz.ts";

const quiet = { warn() {} };
const okBody = JSON.stringify({ ok: true, checks: { postgres: "ok", valkey: "ok" } });

function deps(over: Partial<PublicReadyzDeps> = {}, store = memoryRateLimitStore(), t = { ms: 0 }) {
  return {
    hit: () => store.hit(rateLimitKey("readyz", "ip:a"), DEFAULT_RATE_LIMITS.readyz, t.ms, String(Math.random())),
    ready: async () => new Response(okBody, { status: 200, headers: { "x-internal": "1" } }),
    logger: quiet,
    ...over,
  } satisfies PublicReadyzDeps;
}

describe("publicReadyz", () => {
  test("relays the service's own status and body, with no-store and nothing else of its headers", async () => {
    const res = await publicReadyz("GET", deps());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(okBody);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-internal")).toBeNull();

    const failing = { ok: false, checks: { postgres: "fail", valkey: "ok" } };
    const down = await publicReadyz("GET", deps({ ready: async () => Response.json(failing, { status: 503 }) }));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual(failing);
  });

  test("HEAD has no body; other methods are 405", async () => {
    const head = await publicReadyz("HEAD", deps());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await publicReadyz("POST", deps());
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  test("the budget is 60 a minute per address: the 61st is 429 with Retry-After, then it recovers", async () => {
    expect(DEFAULT_RATE_LIMITS.readyz).toEqual({ max: 60, windowMs: 60_000 });
    const store = memoryRateLimitStore();
    const t = { ms: 0 };
    let probed = 0;
    const d = deps(
      {
        ready: async () => {
          probed++;
          return new Response(okBody);
        },
      },
      store,
      t,
    );
    for (let i = 0; i < 60; i++) expect((await publicReadyz("GET", d)).status).toBe(200);
    const limited = await publicReadyz("GET", d);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // A limited request runs no checks.
    expect(probed).toBe(60);
    t.ms = 60_001;
    expect((await publicReadyz("GET", d)).status).toBe(200);
  });

  test("the status probe at its fastest (every 5 s) is never limited", async () => {
    const store = memoryRateLimitStore();
    const t = { ms: 0 };
    const d = deps({}, store, t);
    for (let i = 0; i < 12 * 60; i++, t.ms += 5000) expect((await publicReadyz("GET", d)).status).toBe(200);
  });

  test("a limiter outage fails open, so readiness itself reports what is down", async () => {
    const warned: string[] = [];
    const res = await publicReadyz(
      "GET",
      deps({
        hit: () => Promise.reject(new Error("valkey down")),
        ready: async () => Response.json({ ok: false, checks: { valkey: "fail" } }, { status: 503 }),
        logger: { warn: (m) => warned.push(m) },
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, checks: { valkey: "fail" } });
    expect(warned).toEqual(["readyz rate limiter unavailable"]);
  });

  test("an unreachable listener is a plain 503, with no error text", async () => {
    const res = await publicReadyz("GET", deps({ ready: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1")) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, checks: {} });
  });
});
