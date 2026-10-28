// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { createDb } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { warmPool } from "../src/pool.ts";
import { quietLogger } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

test("warm-up opens the requested connections and keeps them", async () => {
  const applicationName = `chat-warm-${crypto.randomUUID().slice(0, 8)}`;
  const handle = createDb({ url: t.url, max: 10, applicationName });
  try {
    const pool = warmPool(handle.db, 3, quietLogger);
    await pool.done;
    expect(pool.warm).toBe(true);
    const [row] = await t.sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where application_name = ${applicationName}`;
    expect(row?.n).toBe(3);
  } finally {
    await handle.close();
  }
});

test("warm-up retries while the database is unreachable, and stops on request", async () => {
  const handle = createDb({ url: "postgres://nobody@127.0.0.1:1/none", max: 2 });
  try {
    const pool = warmPool(handle.db, 2, quietLogger, { retryMs: 20 });
    await Bun.sleep(200);
    expect(pool.warm).toBe(false);
    pool.stop();
    await pool.done;
    expect(pool.warm).toBe(false);
  } finally {
    await handle.close();
  }
});

test("zero connections is warm at once", async () => {
  const pool = warmPool(t.db, 0, quietLogger);
  await pool.done;
  expect(pool.warm).toBe(true);
});
