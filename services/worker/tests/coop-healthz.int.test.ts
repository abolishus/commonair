// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The real entry point with COOP_TEST_HOOKS on: a warning at start and the flag on /healthz. */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { AUTH_SECRET, VALKEY_URL, waitFor } from "./fixtures.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(() => t.drop());

test("main.ts warns about co-op test hooks and reports coop_test_hooks on /healthz", async () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const child = Bun.spawn(["bun", fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: {
      ...process.env,
      DATABASE_URL: t.url,
      VALKEY_URL,
      AUTH_SECRET,
      WORKER_PORT: String(port),
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const health = await waitFor(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/healthz`);
          return r.status === 200 && ((await r.json()) as Record<string, unknown>);
        } catch {
          return false;
        }
      },
      { timeoutMs: 15_000, intervalMs: 100, label: "healthz" },
    );
    expect(health).toMatchObject({ coop_test_hooks: true, moderation_test_hooks: true });
  } finally {
    child.kill("SIGTERM");
  }
  expect(await child.exited).toBe(0);
  const out = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
  expect(out).toMatch(/co-op test hooks are enabled/);
}, 60_000);
