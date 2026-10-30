// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from "vite-plus/test";
import { postPinned, postWebhook, type PostOptions } from "../src/webhooks/http.ts";
import type { Resolver } from "../src/webhooks/ssrf.ts";

const seen: { host: string | null; body: string; headers: Headers }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    seen.push({ host: req.headers.get("host"), body, headers: req.headers });
    if (url.pathname === "/ok") return new Response("fine");
    if (url.pathname === "/big") return new Response("x".repeat(200_000));
    if (url.pathname === "/redirect") return Response.redirect("http://127.0.0.1:1/elsewhere", 302);
    if (url.pathname === "/slow") {
      await Bun.sleep(2_000);
      return new Response("late");
    }
    return new Response("nope", { status: 500 });
  },
});
afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;
const opts = (o: Partial<PostOptions> = {}): PostOptions => ({
  allowInsecure: true,
  timeoutMs: 1_000,
  maxResponseBytes: 1024,
  ...o,
});

describe("postWebhook", () => {
  test("posts the body with headers and reports status and latency", async () => {
    const r = await postWebhook(`${base}/ok`, { "x-test": "1" }, '{"a":1}', opts());
    expect(r).toMatchObject({ ok: true, status: 200, body: "fine", truncated: false });
    const last = seen.at(-1);
    expect(last?.body).toBe('{"a":1}');
    expect(last?.headers.get("x-test")).toBe("1");
    expect(last?.headers.get("content-type")).toBe("application/json");
  });

  test("non-2xx is a completed exchange, not an error", async () => {
    expect(await postWebhook(`${base}/fail`, {}, "{}", opts())).toMatchObject({ ok: true, status: 500, body: "nope" });
  });

  test("redirects are not followed", async () => {
    const before = seen.length;
    const r = await postWebhook(`${base}/redirect`, {}, "{}", opts());
    expect(r).toMatchObject({ ok: true, status: 302 });
    expect(seen.length).toBe(before + 1);
  });

  test("response bodies are capped", async () => {
    const r = await postWebhook(`${base}/big`, {}, "{}", opts({ maxResponseBytes: 1000 }));
    expect(r.ok && r.body.length).toBe(1000);
    expect(r.ok && r.truncated).toBe(true);
  });

  test("times out", async () => {
    const r = await postWebhook(`${base}/slow`, {}, "{}", opts({ timeoutMs: 200 }));
    expect(r).toMatchObject({ ok: false, rejected: false });
    expect(!r.ok && r.error).toContain("timeout");
    expect(r.latencyMs).toBeLessThan(1_500);
  });

  test("connection errors are reported, not thrown", async () => {
    const r = await postWebhook("http://127.0.0.1:1/", {}, "{}", opts());
    expect(r.ok).toBe(false);
  });

  test("private targets are refused unless insecure callbacks are allowed", async () => {
    const r = await postWebhook(`${base}/ok`, {}, "{}", opts({ allowInsecure: false }));
    expect(r).toMatchObject({ ok: false, rejected: true });
    expect(!r.ok && r.error).toContain("scheme must be https");
    const https = await postWebhook(`https://127.0.0.1:${server.port}/ok`, {}, "{}", opts({ allowInsecure: false }));
    expect(!https.ok && https.error).toContain("address is loopback");
  });

  test("connects to the pinned address while keeping the hostname (DNS rebinding)", async () => {
    let calls = 0;
    // First answer is the address that passed validation; any later answer would point elsewhere.
    const resolve: Resolver = async () => {
      calls++;
      return [{ address: calls === 1 ? "127.0.0.1" : "10.9.9.9", family: 4 }];
    };
    const r = await postWebhook(`http://receiver.test:${server.port}/ok`, {}, "{}", opts({ resolve }));
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(calls).toBe(1);
    expect(seen.at(-1)?.host).toBe(`receiver.test:${server.port}`);
  });
});

describe("postPinned (N1: web push and Discord)", () => {
  const got: { bytes: Uint8Array; headers: Headers }[] = [];
  const bin = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      got.push({ bytes: new Uint8Array(await req.arrayBuffer()), headers: req.headers });
      return new Response(null, {
        status: 201,
        headers: { location: "https://push.example/m/1", "Retry-After": "7" },
      });
    },
  });
  afterAll(() => bin.stop(true));

  test("a binary body arrives byte for byte, with the given content type and user agent", async () => {
    // Every byte value, including ones that are not valid UTF-8.
    const body = Uint8Array.from({ length: 512 }, (_, i) => (i * 7 + 255) % 256);
    const r = await postPinned(
      `http://127.0.0.1:${bin.port}/push`,
      {
        headers: { "content-encoding": "aes128gcm", ttl: "60" },
        body,
        contentType: "application/octet-stream",
        userAgent: "CommonAir-Push/1",
      },
      opts(),
    );
    expect(r).toMatchObject({ ok: true, status: 201 });
    const last = got.at(-1);
    expect(last?.bytes).toEqual(body);
    expect(last?.headers.get("content-type")).toBe("application/octet-stream");
    expect(last?.headers.get("user-agent")).toBe("CommonAir-Push/1");
    expect(last?.headers.get("content-encoding")).toBe("aes128gcm");
    expect(last?.headers.get("content-length")).toBe("512");
  });

  test("response headers come back with lower-case names", async () => {
    const r = await postPinned(
      `http://127.0.0.1:${bin.port}/push`,
      { headers: {}, body: "{}", contentType: "application/json", userAgent: "CommonAir-Discord/1" },
      opts(),
    );
    expect(r.ok && r.headers["location"]).toBe("https://push.example/m/1");
    expect(r.ok && r.headers["retry-after"]).toBe("7");
  });

  test("postWebhook keeps its JSON content type and EventSub user agent", async () => {
    await postWebhook(`http://127.0.0.1:${bin.port}/hook`, {}, '{"a":1}', opts());
    const last = got.at(-1);
    expect(last?.headers.get("content-type")).toBe("application/json");
    expect(last?.headers.get("user-agent")).toBe("CommonAir-EventSub/1");
  });
});
