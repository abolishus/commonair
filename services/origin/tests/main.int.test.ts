// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The origin as `bun src/main.ts` runs it, against real Postgres, Valkey and object storage, with
 * a stand-in for MediaMTX's HLS listener (readiness only asks whether it answers).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { generateSigningKey } from "@commonair/tokens";
import { loadOriginEnv, serveOrigin, type ServedOrigin } from "../src/main.ts";
import { PUBLIC_READYZ_PATH, READYZ_PER_MINUTE } from "../src/readyz.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let served: ServedOrigin;
let mediamtx: ReturnType<typeof Bun.serve> | undefined;
let mediamtxUrl = "";
let base = "";

/**
 * MediaMTX's HLS listener answers 404 at its root; any answer is "up". While `mediamtxDown` it
 * never answers, so the readiness check times out: the same "fail" as a refused connection,
 * without giving the port up and racing other test files to bind it again.
 */
let mediamtxDown = false;
const startMediamtx = () =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => (mediamtxDown ? new Promise<Response>(() => {}) : new Response("not found", { status: 404 })),
  });

beforeAll(async () => {
  const [db, generated] = await Promise.all([createTestDatabase(), generateSigningKey()]);
  t = db;
  mediamtx = startMediamtx();
  mediamtxUrl = `http://127.0.0.1:${mediamtx.port}`;
  const env = loadOriginEnv({
    ...process.env,
    DATABASE_URL: t.url,
    VALKEY_URL: process.env.VALKEY_URL ?? "redis://localhost:6379",
    MEDIAMTX_HLS_URL: mediamtxUrl,
    PLAYBACK_SIGNING_KEY: generated.pkcs8B64,
    INTERNAL_API_SECRET: "i".repeat(32),
    MEDIA_INTERNAL_PASSWORD: "m".repeat(32),
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    CDN_PROVIDER: "none",
    // No timer: this replica must not take the shared issuance lock from other tests.
    ORIGIN_ISSUANCE_ENABLED: "false",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
  });
  // A port of its own (the schema refuses 0, which only tests use).
  served = await serveOrigin({ ...env, ORIGIN_PORT: 0 }, { hostname: "127.0.0.1" });
  base = served.service.url.toString().replace(/\/$/, "");
});

afterAll(async () => {
  // Already stopped by the last test unless it failed first (stop is idempotent).
  await served?.service.stop();
  await mediamtx?.stop(true);
  await t?.drop();
});

const fromClient = (path: string, client: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { "x-forwarded-for": client } });

describe("serveOrigin", () => {
  test("liveness and readiness of every dependency, pass/fail only", async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "origin" });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true, checks: { postgres: "ok", valkey: "ok", mediamtx: "ok" } });
  });

  test("the public readiness route relays the listener's own answer, on the port it got", async () => {
    const res = await fromClient(PUBLIC_READYZ_PATH, "198.51.100.10");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ ok: true, checks: { postgres: "ok", valkey: "ok", mediamtx: "ok" } });
    const head = await fromClient(PUBLIC_READYZ_PATH, "198.51.100.10", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("the public route's budget is per client, read from X-Forwarded-For behind a trusted proxy", async () => {
    const client = "198.51.100.20";
    for (let i = 0; i < READYZ_PER_MINUTE; i++) expect((await fromClient(PUBLIC_READYZ_PATH, client)).status).toBe(200);
    const limited = await fromClient(PUBLIC_READYZ_PATH, client);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await fromClient(PUBLIC_READYZ_PATH, "198.51.100.21")).status).toBe(200);
    // The internal route is never limited (compose health checks, the API's status probe).
    expect((await fetch(`${base}/readyz`, { headers: { "x-forwarded-for": client } })).status).toBe(200);
  });

  test("everything else is the origin's: HLS, media and DVR routes", async () => {
    const hls = await fetch(`${base}/hls/live/nobody/index.m3u8`);
    expect(hls.status).toBe(403);
    await hls.body?.cancel();
    const dvr = await fetch(`${base}/dvr/0192f3a4-5b6c-7d8e-9f01-00000000aa01/index.m3u8`);
    expect(dvr.status).toBe(401);
    await dvr.body?.cancel();
    // `/media/` serves only public prefixes; the storage it reads is the env's.
    const media = await fetch(`${base}/media/avatars/none.webp`);
    expect([403, 404]).toContain(media.status);
    await media.body?.cancel();
    expect(served.origin.routes.names).toEqual(["dvr", "captions:hls", "captions:relayPull", "captions:cdn"]);
  });

  test("MediaMTX not answering fails readiness, on both routes", async () => {
    mediamtxDown = true;
    try {
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ok: false, checks: { postgres: "ok", valkey: "ok", mediamtx: "fail" } });
      const pub = await fromClient(PUBLIC_READYZ_PATH, "198.51.100.30");
      expect(pub.status).toBe(503);
      expect((await pub.json()).checks.mediamtx).toBe("fail");
    } finally {
      mediamtxDown = false;
    }
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  test("shutdown closes the listener (the pools close behind it)", async () => {
    await served.service.stop();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow(/connect|refused|closed/i);
  });
});
