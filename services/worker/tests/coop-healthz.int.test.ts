// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The real entry point with COOP_TEST_HOOKS on: a warning at start and the flag on /healthz. */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { AUTH_SECRET, VALKEY_URL, waitFor } from "./fixtures.ts";
import { startMainChild } from "./main-child.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(() => t.drop());

test("main.ts warns about co-op test hooks and reports coop_test_hooks on /healthz", async () => {
  const main = await startMainChild({
    DATABASE_URL: t.url,
    VALKEY_URL,
    AUTH_SECRET,
    // W1: verified-watch jitter (ADR 0015 decision 4).
    INTERNAL_API_SECRET: "test-internal-secret-0123456789-abcdefghij",
    WORKER_BULL_PREFIX: `test-bull-${crypto.randomUUID()}`,
    // Synthetic local settings, as in main.int.test.ts: no storage operation or scoring happens.
    S3_ENDPOINT: "http://127.0.0.1:3900",
    S3_ACCESS_KEY_ID: "synthetic-main-key",
    S3_SECRET_ACCESS_KEY: "synthetic-main-secret",
    S3_EVIDENCE_ACCESS_KEY_ID: "synthetic-evidence-key",
    S3_EVIDENCE_SECRET_ACCESS_KEY: "synthetic-evidence-secret",
    EVIDENCE_PUBLIC_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODERATION_CLASSIFIER: "scripted",
    MODERATION_TEST_HOOKS: "true",
    COOP_TEST_HOOKS: "true",
    LOG_LEVEL: "warn",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
  });
  try {
    const health = await waitFor(
      async () => {
        // The child reported its port only once listening, so a failed fetch is a real failure.
        const r = await main.get("/healthz");
        return r.status === 200 && ((await r.json()) as Record<string, unknown>);
      },
      { timeoutMs: 15_000, intervalMs: 100, label: "healthz" },
    );
    expect(health).toMatchObject({ coop_test_hooks: true, moderation_test_hooks: true });
  } finally {
    main.child.kill("SIGTERM");
  }
  expect(await main.child.exited).toBe(0);
  const out = (await new Response(main.child.stdout).text()) + (await new Response(main.child.stderr).text());
  expect(out).toMatch(/co-op test hooks are enabled/);
}, 60_000);
