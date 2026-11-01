// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Twitch import's image fetch (ADR 0031 decision 5): only `TWITCH_IMAGE_HOSTS`, the SSRF guard,
 * no redirects, the size cap; and the job's env, read through `loadEnv`.
 */
import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { fetchTwitchImage, onAllowedHost } from "../src/twitch-import/fetch-image.ts";
import { twitchJobConfig } from "../src/twitch-import/run.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
let server: Server<undefined>;
let base: string;
let hits = 0;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits++;
      const path = new URL(req.url).pathname;
      if (path === "/ok.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      if (path === "/big.png") return new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } });
      if (path === "/stream.png")
        return new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000));
              c.close();
            },
          }),
        );
      if (path === "/redirect.png") return new Response(null, { status: 302, headers: { location: "/ok.png" } });
      return new Response("no", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.stop(true);
});

const opts = { allowedHosts: ["127.0.0.1"], allowInsecure: true, maxBytes: 4096 };

describe("onAllowedHost", () => {
  test("exact host names, case-insensitive; ports ignored; anything else refused", () => {
    expect(
      onAllowedHost("https://static-cdn.jtvnw.net/emoticons/v2/1/static/light/3.0", ["static-cdn.jtvnw.net"]),
    ).toBe(true);
    expect(onAllowedHost("https://STATIC-CDN.jtvnw.net./x", ["static-cdn.jtvnw.net"])).toBe(true);
    expect(onAllowedHost("http://host.containers.internal:4791/cdn/x", ["host.containers.internal"])).toBe(true);
    expect(onAllowedHost("https://evil.static-cdn.jtvnw.net/x", ["static-cdn.jtvnw.net"])).toBe(false);
    expect(onAllowedHost("https://static-cdn.jtvnw.net.evil.test/x", ["static-cdn.jtvnw.net"])).toBe(false);
    expect(onAllowedHost("https://static-cdn.jtvnw.net@evil.test/x", ["static-cdn.jtvnw.net"])).toBe(false);
    expect(onAllowedHost("not a url", ["static-cdn.jtvnw.net"])).toBe(false);
    expect(onAllowedHost("https://x.test/", [])).toBe(false);
    expect(onAllowedHost("https://x.test/", [""])).toBe(false);
  });
});

describe("fetchTwitchImage", () => {
  test("a host outside the list is refused before any lookup or connection", async () => {
    const before = hits;
    let resolved = false;
    const r = await fetchTwitchImage(`${base}/ok.png`, {
      ...opts,
      allowedHosts: ["static-cdn.jtvnw.net"],
      resolve: async () => {
        resolved = true;
        return [];
      },
    });
    expect(r).toEqual({ ok: false, reason: "host_not_allowed" });
    expect(resolved).toBe(false);
    expect(hits).toBe(before);
  });

  test("private addresses and plain http are refused unless OUTBOUND_ALLOW_PRIVATE_NETWORKS", async () => {
    const before = hits;
    expect(await fetchTwitchImage(`${base}/ok.png`, { ...opts, allowInsecure: false })).toEqual({
      ok: false,
      reason: "rejected_address",
    });
    // An allowed name that resolves to a private address is refused too (rebinding).
    const r = await fetchTwitchImage("https://static-cdn.jtvnw.net/x.png", {
      ...opts,
      allowedHosts: ["static-cdn.jtvnw.net"],
      allowInsecure: false,
      resolve: async () => [{ address: "10.0.0.5", family: 4 }],
    });
    expect(r).toEqual({ ok: false, reason: "rejected_address" });
    expect(hits).toBe(before);
  });

  test("fetches the bytes from an allowed host", async () => {
    const r = await fetchTwitchImage(`${base}/ok.png`, opts);
    expect(r).toMatchObject({ ok: true, contentType: "image/png" });
    expect([...(r as { bytes: Uint8Array }).bytes]).toEqual([...PNG]);
  });

  test("redirects are not followed; non-200 is refused", async () => {
    expect(await fetchTwitchImage(`${base}/redirect.png`, opts)).toEqual({ ok: false, reason: "http_error" });
    expect(await fetchTwitchImage(`${base}/missing.png`, opts)).toEqual({ ok: false, reason: "http_error" });
  });

  test("the size cap holds, declared or streamed", async () => {
    expect(await fetchTwitchImage(`${base}/big.png`, opts)).toEqual({ ok: false, reason: "too_large" });
    expect(await fetchTwitchImage(`${base}/stream.png`, opts)).toEqual({ ok: false, reason: "too_large" });
  });

  test("a dead host is a network failure, not an exception", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = dead.port;
    await dead.stop(true);
    expect(await fetchTwitchImage(`http://127.0.0.1:${port}/x.png`, { ...opts, timeoutMs: 2_000 })).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("twitchJobConfig", () => {
  test("defaults: off, Twitch's CDN, no private networks", () => {
    expect(twitchJobConfig({})).toEqual({ enabled: false, imageHosts: ["static-cdn.jtvnw.net"], allowInsecure: false });
  });

  test("the harness overlay's values", () => {
    expect(
      twitchJobConfig({
        TWITCH_IMPORT_ENABLED: "true",
        TWITCH_IMAGE_HOSTS: "host.containers.internal",
        OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true",
      }),
    ).toEqual({ enabled: true, imageHosts: ["host.containers.internal"], allowInsecure: true });
  });

  test("a blank optional value takes the default", () => {
    expect(twitchJobConfig({ TWITCH_IMPORT_ENABLED: "", TWITCH_IMAGE_HOSTS: "" }).enabled).toBe(false);
  });
});
