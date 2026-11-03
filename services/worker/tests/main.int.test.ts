// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Boots the real entry point as a child process against a throwaway database and isolated prefixes. */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { AUTH_SECRET, VALKEY_URL, waitFor } from "./fixtures.ts";
import { startMainChild } from "./main-child.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(() => t.drop());

test("main.ts serves /healthz and /readyz and shuts down on SIGTERM", async () => {
  const main = await startMainChild({
    DATABASE_URL: t.url,
    VALKEY_URL,
    AUTH_SECRET,
    // W1: verified-watch jitter (ADR 0015 decision 4).
    INTERNAL_API_SECRET: "test-internal-secret-0123456789-abcdefghij",
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
  });
  try {
    const ready = await waitFor(
      async () => {
        // The child reported its port only once listening, so a failed fetch is a real failure.
        const r = await main.get("/readyz");
        return r.status === 200 && ((await r.json()) as { checks: Record<string, string> });
      },
      { timeoutMs: 15_000, intervalMs: 100, label: "readyz" },
    );
    expect(ready.checks).toEqual({ postgres: "ok", valkey: "ok", queues: "ok" });
    const health = await main.get("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ moderation_test_hooks: true });
    expect((await main.get("/other")).status).toBe(404);
  } finally {
    main.child.kill("SIGTERM");
  }
  expect(await main.child.exited).toBe(0);
}, 60_000);
