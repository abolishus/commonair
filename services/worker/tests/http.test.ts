// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from "vite-plus/test";
import { postWebhook, type PostOptions } from "../src/webhooks/http.ts";
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
