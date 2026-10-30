// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Boots the real entry point as a child process against a throwaway database and isolated prefixes. */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { AUTH_SECRET, VALKEY_URL, waitFor } from "./fixtures.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(() => t.drop());

test("main.ts serves /healthz and /readyz and shuts down on SIGTERM", async () => {
  // Ask the OS for a free port, release it, and hand it to the child.
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const child = Bun.spawn(["bun", fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: {
      ...process.env,
      DATABASE_URL: t.url,
      VALKEY_URL,
      AUTH_SECRET,
      // W1: verified-watch jitter (ADR 0015 decision 4).
      INTERNAL_API_SECRET: "test-internal-secret-0123456789-abcdefghij",
      WORKER_PORT: String(port),
      WORKER_BULL_PREFIX: `test-bull-${crypto.randomUUID()}`,
      // These are synthetic local settings: startup composes required storage and sealing clients
      // but the health test performs no object-storage operation or classifier scoring.
      S3_ENDPOINT: "http://127.0.0.1:3900",
      S3_ACCESS_KEY_ID: "synthetic-main-key",
      S3_SECRET_ACCESS_KEY: "synthetic-main-secret",
      S3_EVIDENCE_ACCESS_KEY_ID: "synthetic-evidence-key",
      S3_EVIDENCE_SECRET_ACCESS_KEY: "synthetic-evidence-secret",
      EVIDENCE_PUBLIC_KEY: Buffer.alloc(32, 7).toString("base64"),
      MODERATION_CLASSIFIER: "scripted",
      MODERATION_TEST_HOOKS: "true",
      LOG_LEVEL: "error",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const ready = await waitFor(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/readyz`);
          return r.status === 200 && ((await r.json()) as { checks: Record<string, string> });
        } catch {
          return false;
        }
      },
      { timeoutMs: 15_000, intervalMs: 100, label: "readyz" },
    );
    expect(ready.checks).toEqual({ postgres: "ok", valkey: "ok", queues: "ok" });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ moderation_test_hooks: true });
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
  } finally {
    child.kill("SIGTERM");
  }
  expect(await child.exited).toBe(0);
}, 60_000);
