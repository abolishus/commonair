// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `seed-coverage` decides from the database what it can do: seed it (empty, DEMO_SEED_FULL on),
 * walk a separate `seed full`'s store (users, a store file with the fixed logins, the password),
 * or skip every route with the reason. These run it through the real runner on a throwaway
 * database, up to the point where it would seed or open a browser.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import seedCoverage from "../../scenarios/seed-coverage.ts";
import { loadHarnessEnv } from "../../src/env.ts";
import type { Platform } from "../../src/platform.ts";
import { runOne } from "../../src/runner.ts";
import { SEED_ROUTES } from "../../src/seed/routes.ts";
import { SEED_STORE_FILE, type SeedStoreFile } from "../../src/seed/run.ts";

const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });
const platform = { probe: async () => null } as unknown as Platform;
const ROUTES = Object.keys(SEED_ROUTES).length;

let t: TestDatabase;
let reports: string;
const saved = { full: process.env.DEMO_SEED_FULL, password: process.env.DEMO_SEED_PASSWORD };

beforeAll(async () => {
  t = await createTestDatabase();
  reports = mkdtempSync(join(tmpdir(), "seed-coverage-"));
});

afterAll(async () => {
  await t?.drop();
  rmSync(reports, { recursive: true, force: true });
});

afterEach(() => {
  for (const [k, v] of [
    ["DEMO_SEED_FULL", saved.full],
    ["DEMO_SEED_PASSWORD", saved.password],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const run = (params: Record<string, string> = {}) => {
  const env = loadHarnessEnv({ DATABASE_URL: t.url, HARNESS_REPORT_DIR: reports });
  return runOne(seedCoverage, platform, {
    command: "run",
    profile: "default",
    env,
    log,
    platform,
    runId: "r1",
    params,
  });
};

describe("seed-coverage on an empty database", () => {
  test("without DEMO_SEED_FULL it cannot seed: every route skipped with the reason", async () => {
    delete process.env.DEMO_SEED_FULL;
    const r = await run();
    expect(r.status).toBe("passed");
    expect(r.skippedSteps).toHaveLength(ROUTES);
    expect(r.skippedSteps?.[0]?.reason).toBe(
      "the database is empty but DEMO_SEED_FULL is not true, so it cannot be seeded",
    );
  });

  test("an unknown --set scale fails before anything is seeded", async () => {
    process.env.DEMO_SEED_FULL = "true";
    const r = await run({ scale: "huge" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("--set scale=huge: small, medium or large");
  });
});

describe("seed-coverage on a database with users", () => {
  beforeAll(async () => {
    const id = uuidv7();
    await t.app.db.insert(schema.users).values({
      id,
      name: "someone",
      email: "someone@demo-seed.invalid",
      emailVerified: true,
      username: "someone",
      displayUsername: "someone",
    });
  });

  test("no store file: a separate `seed full` never ran here, so every route is skipped", async () => {
    const r = await run();
    expect(r.status).toBe("passed");
    expect(r.skippedSteps).toHaveLength(ROUTES);
    expect(r.skippedSteps?.[0]?.reason).toContain("seed-coverage needs a fresh database (the seed shard)");
  });

  test("a store file without the fixed logins counts as none", async () => {
    const file: SeedStoreFile = {
      scale: "small",
      seed: 1,
      seededAt: new Date().toISOString(),
      store: { users: [], channels: [], extra: {} },
    };
    writeFileSync(join(reports, SEED_STORE_FILE), JSON.stringify(file));
    const r = await run();
    expect(r.skippedSteps?.[0]?.reason).toContain(`${join(reports, SEED_STORE_FILE)} missing`);
  });

  test("a separate seed's store but no DEMO_SEED_PASSWORD: it cannot sign in, so it skips", async () => {
    delete process.env.DEMO_SEED_PASSWORD;
    const file: SeedStoreFile = {
      scale: "small",
      seed: 1,
      seededAt: new Date().toISOString(),
      store: {
        users: [
          {
            id: uuidv7(),
            handle: "admin",
            username: "demo_admin",
            email: "a@demo-seed.invalid",
            kind: "fixed",
            platformRole: "admin",
          },
        ],
        channels: [],
        extra: {},
      },
    };
    writeFileSync(join(reports, SEED_STORE_FILE), JSON.stringify(file));
    const r = await run();
    expect(r.status).toBe("passed");
    expect(r.skippedSteps?.[0]?.reason).toBe(
      "a separate `seed full` filled the database: set DEMO_SEED_PASSWORD to its password",
    );
  });
});
