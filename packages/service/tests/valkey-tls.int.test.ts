// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * VALKEY_CA_FILE against a TLS-only Valkey (S1-d, ADR 0032 §3): the image compose.yaml pins, run
 * with `--port 0` and a certificate from a CA this test makes, and a password, as a managed
 * Valkey's default user has. Needs podman; CI's integration job has it, so it refuses to skip there.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { testOwnerArgs } from "../../../scripts/test-owner.ts";
import {
  type TestCerts,
  VALKEY_IMAGE,
  hostPort,
  makeTestCerts,
  podman,
  podmanAvailable,
  podmanOk,
} from "../../db/tests/external-owner-tls.ts";
import { type ValkeyClient, createValkey, valkeyCheck } from "../src/valkey.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 600_000 });

const HAVE_PODMAN = podmanAvailable();
if (!HAVE_PODMAN) {
  if (process.env.CI) throw new Error("valkey-tls.int.test.ts needs podman, and CI must run it");
  console.warn("\n*** valkey-tls.int.test.ts SKIPPED: podman is not available here ***\n");
}

const CONTAINER = `commonair-s1d-valkey-${crypto.randomUUID().slice(0, 8)}`;
const PASSWORD = crypto.randomUUID().replaceAll("-", "");
let certs: TestCerts;
let port = 0;
const clients: ValkeyClient[] = [];

const tlsUrl = () => `rediss://:${PASSWORD}@localhost:${port}`;
function client(url: string, caFile: string | null): ValkeyClient {
  const c = createValkey(url, { caFile, name: "s1d-tls" });
  // A refused handshake retries forever by default; the tests want the first error.
  c.options.retryStrategy = () => null;
  clients.push(c);
  return c;
}
/** The TLS error a client reports before it gives up (its commands only say "Connection is closed"). */
function connectError(c: ValkeyClient): Promise<string> {
  return new Promise((resolve) => {
    c.once("error", (e: Error) => resolve(e.message));
    c.ping().then(
      () => resolve("connected"),
      () => {},
    );
  });
}

beforeAll(async () => {
  if (!HAVE_PODMAN) return;
  certs = makeTestCerts();
  // The key file's owner differs per runtime; a copy readable by the server's user avoids that.
  const start = [
    "set -eu",
    "install -d -m 0755 /tmp/tls",
    "install -m 0644 /certs/server.crt /certs/commonair-test-ca.crt /tmp/tls/",
    "install -m 0644 /certs/server.key /tmp/tls/server.key",
    `exec docker-entrypoint.sh valkey-server --port 0 --tls-port 6380 --tls-cert-file /tmp/tls/server.crt` +
      ` --tls-key-file /tmp/tls/server.key --tls-ca-cert-file /tmp/tls/commonair-test-ca.crt --tls-auth-clients no` +
      ` --requirepass "$VALKEY_TEST_PASSWORD" --save '' --appendonly no`,
  ].join("\n");
  podmanOk(
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      ...testOwnerArgs(),
      "-e",
      `VALKEY_TEST_PASSWORD=${PASSWORD}`,
      "-v",
      `${certs.dir}:/certs:ro,Z`,
      "-p",
      "127.0.0.1::6380",
      "--entrypoint",
      "sh",
      VALKEY_IMAGE,
      "-c",
      start,
    ],
    { timeoutMs: 300_000 },
  );
  port = hostPort(CONTAINER, 6380);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = client(tlsUrl(), certs.ca);
    try {
      await valkeyCheck(probe)();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`TLS Valkey never answered: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      probe.disconnect();
    }
  }
});

afterAll(() => {
  for (const c of clients) c.disconnect();
  if (!HAVE_PODMAN) return;
  podman(["rm", "-f", "-t", "0", CONTAINER]);
  certs?.cleanup();
});

describe.runIf(HAVE_PODMAN)("Valkey over TLS with a private CA", () => {
  test("rediss:// with VALKEY_CA_FILE verifies the server and works", async () => {
    const c = client(tlsUrl(), certs.ca);
    await valkeyCheck(c)();
    await c.set("s1d", "ok", "EX", 10);
    expect(await c.get("s1d")).toBe("ok");
  });

  test("without the CA, the system store does not trust the server", async () => {
    expect(await connectError(client(tlsUrl(), null))).toMatch(/certificate|self.signed|verify/i);
  });

  test("a CA that did not sign the server's certificate is refused", async () => {
    expect(await connectError(client(tlsUrl(), certs.otherCa))).toMatch(/certificate|self.signed|verify/i);
  });

  test("with the CA set, a redis:// URL is refused before connecting", () => {
    expect(() => createValkey(`redis://:${PASSWORD}@localhost:${port}`, { caFile: certs.ca })).toThrow(
      /must use rediss:\/\//,
    );
  });
});
