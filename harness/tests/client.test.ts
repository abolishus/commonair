// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** API client plumbing: cookie jar, forwarding proxy, ALTCHA solving, mail links, usernames, metrics. */
import { Slug } from "@commonair/contracts";
import { createChallenge, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/sha";
import { createChallenge as createChallengeV1, verifySolution as verifySolutionV1 } from "altcha-lib/v1";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { solveAltcha } from "../src/altcha.ts";
import { SIMULATED_IP_HEADER, createApi } from "../src/api/client.ts";
import { CookieJar, jarFetch } from "../src/api/cookies.ts";
import { extractLinks, findTokenLink } from "../src/mailpit.ts";
import {
  CpuSampler,
  formatBytes,
  formatDuration,
  parseDuration,
  parsePodmanStats,
  percentile,
  summarize,
} from "../src/metrics.ts";
import { startForwardingProxy, upstreamRequest } from "../src/proxy.ts";
import { UsernameFactory } from "../src/users.ts";

describe("cookie jar", () => {
  test("stores, scopes by path, expires and deletes", () => {
    let now = 1_000_000;
    const jar = new CookieJar(() => now);
    jar.store("session=abc; Path=/; HttpOnly; SameSite=Lax");
    jar.store("scoped=1; Path=/api/auth");
    jar.store("short=x; Max-Age=10");
    expect(jar.header("/rpc/me")).toBe("session=abc; short=x");
    expect(jar.header("/api/auth/sign-in")).toBe("scoped=1; session=abc; short=x");
    now += 11_000;
    expect(jar.header("/")).toBe("session=abc");
    jar.store("session=; Max-Age=0");
    expect(jar.get("session")).toBeUndefined();
    jar.store(`old=1; Expires=${new Date(now - 1000).toUTCString()}`);
    expect(jar.get("old")).toBeUndefined();
    jar.store("garbage");
    expect(jar.size).toBe(1);
    jar.clear();
    expect(jar.header()).toBeNull();
  });

  test("jarFetch sends cookies and fixed headers and stores Set-Cookie", async () => {
    const jar = new CookieJar();
    jar.store("a=1");
    const seen: Headers[] = [];
    const f = jarFetch(jar, { origin: "http://web", [SIMULATED_IP_HEADER]: "73.1.2.3" }, async (req) => {
      seen.push(req.headers);
      const headers = new Headers();
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("ok", { headers });
    });
    await f(new Request("http://api/rpc/x", { headers: { origin: "http://override" } }));
    expect(seen[0]?.get("cookie")).toBe("a=1");
    expect(seen[0]?.get("origin")).toBe("http://override");
    expect(seen[0]?.get(SIMULATED_IP_HEADER)).toBe("73.1.2.3");
    expect(jar.get("b")).toBe("2");
  });
});

describe("forwarding proxy", () => {
  test("turns the simulated address into x-forwarded-for and strips spoofed ones", () => {
    const req = new Request("http://proxy/rpc/me?x=1", {
      headers: { [SIMULATED_IP_HEADER]: "34.64.1.2", "x-forwarded-for": "1.1.1.1", connection: "keep-alive" },
    });
    const up = upstreamRequest(req, { target: "http://api:3001" });
    expect(up.url).toBe("http://api:3001/rpc/me?x=1");
    expect(up.headers.get("x-forwarded-for")).toBe("34.64.1.2");
    expect(up.headers.has(SIMULATED_IP_HEADER)).toBe(false);
    expect(up.headers.has("connection")).toBe(false);
    const plain = upstreamRequest(new Request("http://proxy/a", { headers: { "x-forwarded-for": "9.9.9.9" } }), {
      target: "http://api",
    });
    expect(plain.headers.has("x-forwarded-for")).toBe(false);
    const bad = upstreamRequest(
      new Request("http://proxy/a", { headers: { [SIMULATED_IP_HEADER]: "evil, 1.2.3.4" } }),
      {
        target: "http://api",
      },
    );
    expect(bad.headers.has("x-forwarded-for")).toBe(false);
    expect(
      upstreamRequest(new Request("http://p/x/rpc/a"), { target: "http://api/base/", stripPrefix: "/x" }).url,
    ).toBe("http://api/base/rpc/a");
  });

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "sid=1; Domain=localhost; Path=/");
      headers.append("set-cookie", "csrf=2; Path=/");
      if (new URL(req.url).pathname === "/redirect")
        return new Response(null, { status: 302, headers: { location: "/x" } });
      return new Response(
        JSON.stringify({
          xff: req.headers.get("x-forwarded-for"),
          body: req.method === "POST" ? await req.text() : null,
        }),
        { headers },
      );
    },
  });
  const proxy = startForwardingProxy({ target: `http://127.0.0.1:${upstream.port}` });
  afterAll(async () => {
    await proxy.stop();
    await upstream.stop(true);
  });

  test("end to end: bodies, cookies (domain stripped), redirects untouched", async () => {
    const res = await fetch(`${proxy.url}/rpc/x`, {
      method: "POST",
      body: "hello",
      headers: { [SIMULATED_IP_HEADER]: "73.9.9.9" },
    });
    expect(await res.json()).toEqual({ xff: "73.9.9.9", body: "hello" });
    expect(res.headers.getSetCookie()).toEqual(["sid=1; Path=/", "csrf=2; Path=/"]);
    const redirect = await fetch(`${proxy.url}/redirect`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/x");
  });

  test("API clients route through it with their own address", async () => {
    const api = createApi({ baseUrl: proxy.url, clientIp: "100.64.3.4", origin: "http://web" });
    const res = await api.fetch(new Request(`${api.baseUrl}/api/thing`));
    expect(((await res.json()) as { xff: string }).xff).toBe("100.64.3.4");
    expect(api.jar.get("csrf")).toBe("2");
  });

  test("an unreachable upstream is a 502, not a crash", async () => {
    const dead = startForwardingProxy({ target: "http://127.0.0.1:9", timeoutMs: 2_000 });
    try {
      expect((await fetch(`${dead.url}/x`)).status).toBe(502);
    } finally {
      await dead.stop();
    }
  });
});

describe("ALTCHA", () => {
  const hmac = "harness-test-hmac-key-0123456789abcdef";

  test("solves a v2 challenge the server verifies", async () => {
    const challenge = await createChallenge({
      algorithm: "SHA-256",
      cost: 1,
      deriveKey,
      hmacSignatureSecret: hmac,
      keyPrefix: "00",
    });
    const payload = await solveAltcha(JSON.parse(JSON.stringify(challenge)));
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    const result = await verifySolution({
      challenge: decoded.challenge,
      solution: decoded.solution,
      deriveKey,
      hmacSignatureSecret: hmac,
    });
    expect(result.verified).toBe(true);
  }, 30_000);

  test("solves a v1 challenge the server verifies", async () => {
    const challenge = await createChallengeV1({ hmacKey: hmac, maxnumber: 20_000 });
    const payload = await solveAltcha(challenge);
    expect(await verifySolutionV1(payload, hmac)).toBe(true);
  }, 30_000);

  test("rejects unknown formats", async () => {
    await expect(solveAltcha({ foo: 1 })).rejects.toThrow(/unrecognized/);
  });
});

describe("mail links", () => {
  test("extracts verification links from HTML and text", () => {
    const message = {
      html: '<a href="http://localhost:3001/api/auth/verify-email?token=abc&amp;callbackURL=%2F">Verify</a> <a href="http://localhost:3000/help">help</a>',
      text: "Verify: http://localhost:3001/api/auth/verify-email?token=abc&callbackURL=%2F.\nOther http://x.test/y)",
    };
    expect(extractLinks(message)).toEqual([
      "http://localhost:3001/api/auth/verify-email?token=abc&callbackURL=%2F",
      "http://localhost:3000/help",
      "http://x.test/y",
    ]);
    expect(findTokenLink(message)).toBe("http://localhost:3001/api/auth/verify-email?token=abc&callbackURL=%2F");
    expect(findTokenLink({ html: "", text: "no links" })).toBeNull();
  });
});

describe("usernames", () => {
  test("unique, contract-valid, prefix truncated", () => {
    const f = new UsernameFactory("Run#42");
    const names = Array.from({ length: 200 }, (_, i) => f.next(i % 2 ? "a-very-long-prefix-for-users" : "x"));
    expect(new Set(names).size).toBe(200);
    for (const n of names) expect(Slug.safeParse(n).success).toBe(true);
    expect(f.runTag).toBe("run42");
    expect(new UsernameFactory("!!!").next("")).toMatch(/^user_run0$/);
  });
});

describe("metrics", () => {
  test("percentiles (nearest rank) and summaries", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([], 50)).toBeNull();
    expect(() => percentile(v, 101)).toThrow(/within/);
    expect(summarize([3, 1, 2, Number.NaN])).toMatchObject({ count: 3, min: 1, max: 3, mean: 2, p50: 2 });
    expect(summarize([]).p95).toBeNull();
  });

  test("durations and bytes", () => {
    expect(parseDuration("120s")).toBe(120_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("45")).toBe(45_000);
    expect(() => parseDuration("2 minutes")).toThrow(/invalid duration/);
    expect(() => parseDuration("")).toThrow(/invalid duration/);
    expect(formatDuration(900)).toBe("900ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(125_000)).toBe("2m05s");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });

  test("podman stats JSON (current and older field names)", () => {
    const rows = parsePodmanStats(
      JSON.stringify([
        { id: "1", name: "commonair_api_1", cpu_percent: "12.50%", mem_usage: "148.6MB / 12.49GB" },
        { Name: "commonair_origin_1", CPU: 3.25, MemUsage: "1.5GiB / 8GiB" },
      ]),
    );
    expect(rows).toEqual([
      { name: "commonair_api_1", cpuPercent: 12.5, memBytes: 148.6e6 },
      { name: "commonair_origin_1", cpuPercent: 3.25, memBytes: 1.5 * 1024 ** 3 },
    ]);
  });

  test("CPU sampler aggregates per container and notices podman is missing", async () => {
    let calls = 0;
    const sampler = new CpuSampler("x", 10, async () => {
      calls++;
      return [{ name: "x_api", cpuPercent: calls * 10, memBytes: 0 }];
    });
    sampler.start();
    await Bun.sleep(60);
    await sampler.stop();
    const s = sampler.summary().x_api;
    expect(s?.samples).toBeGreaterThanOrEqual(2);
    expect(s?.peakCpuPercent).toBeGreaterThan(s?.meanCpuPercent ?? Infinity);
    const missing = new CpuSampler("x", 10, async () => null);
    missing.start();
    await Bun.sleep(20);
    await missing.stop();
    expect(missing.available).toBe(false);
    expect(missing.summary()).toEqual({});
  });
});
