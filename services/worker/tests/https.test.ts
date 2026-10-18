// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HTTPS with a pinned address: the connection goes to the validated IP while SNI
 * and certificate verification still use the callback's hostname. Uses a
 * throwaway CA generated with openssl.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { postWebhook, type PostOptions } from "../src/webhooks/http.ts";
import type { Resolver } from "../src/webhooks/ssrf.ts";

const dir = mkdtempSync(join(tmpdir(), "worker-tls-"));
const openssl = (...args: string[]) => {
  const r = Bun.spawnSync(["openssl", ...args], { cwd: dir, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr.toString()}`);
};

let server: ReturnType<typeof Bun.serve>;
let ca: string;
const sni: (string | null)[] = [];

beforeAll(() => {
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=worker-test-ca",
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=receiver.test",
  );
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:receiver.test\n");
  openssl(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.pem",
    "-days",
    "1",
    "-extfile",
    "ext.cnf",
  );
  ca = readFileSync(join(dir, "ca.pem"), "utf8");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: readFileSync(join(dir, "leaf.pem"), "utf8"), key: readFileSync(join(dir, "leaf.key"), "utf8") },
    fetch(req) {
      sni.push(req.headers.get("host"));
      return new Response("tls-ok");
    },
  });
});
afterAll(async () => {
  await server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

let resolverCalls = 0;
const pinnedToLoopback: Resolver = async () => {
  resolverCalls++;
  return [{ address: "127.0.0.1", family: 4 }];
};
const opts = (o: Partial<PostOptions> = {}): PostOptions => ({
  // Loopback is only reachable with insecure callbacks on; pinning applies all the same.
  allowInsecure: true,
  timeoutMs: 3_000,
  maxResponseBytes: 1024,
  resolve: pinnedToLoopback,
  ca,
  ...o,
});

describe("https callbacks with a pinned address", () => {
  test("connect to the pinned IP and verify the certificate for the hostname", async () => {
    resolverCalls = 0;
    const r = await postWebhook(`https://receiver.test:${server.port}/cb`, {}, "{}", opts());
    expect(r).toMatchObject({ ok: true, status: 200, body: "tls-ok" });
    expect(resolverCalls).toBe(1);
    expect(sni.at(-1)).toBe(`receiver.test:${server.port}`);
  });

  test("a certificate for a different name is refused even though the IP matches", async () => {
    const r = await postWebhook(`https://other.test:${server.port}/cb`, {}, "{}", opts());
    expect(r).toMatchObject({ ok: false, rejected: false });
    expect(!r.ok && r.error).toMatch(/altname|hostname|cert/i);
  });

  test("an untrusted certificate is refused", async () => {
    const r = await postWebhook(`https://receiver.test:${server.port}/cb`, {}, "{}", opts({ ca: undefined }));
    expect(r).toMatchObject({ ok: false, rejected: false });
    expect(!r.ok && r.error).toMatch(/cert|self.signed|issuer/i);
  });

  test("with insecure callbacks off, a hostname resolving to loopback never connects", async () => {
    const before = sni.length;
    const r = await postWebhook(`https://receiver.test:${server.port}/cb`, {}, "{}", opts({ allowInsecure: false }));
    expect(r).toMatchObject({ ok: false, rejected: true });
    expect(sni.length).toBe(before);
  });
});
