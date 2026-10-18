// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration-test databases. Each test file gets its own throwaway database,
 * cloned from a template that is migrated once per migration-set (keyed by a hash
 * of the migrations, the seed and governance overrides, so stale templates are never reused).
 *
 *   const t = await createTestDatabase();
 *   afterAll(() => t.drop());
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createDb, type DbHandle } from "./client.ts";
import { MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import type { GovernanceOverrides } from "./seed.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://commonair:commonair@localhost:5432/commonair";

/** Short review/voting periods for tests that exercise the governance lifecycle in seconds. */
export const FAST_GOVERNANCE: GovernanceOverrides = {
  "governance.protections": { councilReviewSeconds: 1, minVotingSeconds: 1 },
  "governance.ordinary": { discussionSeconds: 0, minVotingSeconds: 1, votingSeconds: 2 },
};

function templateHash(overrides: GovernanceOverrides): string {
  const h = createHash("sha256");
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    h.update(f).update(readFileSync(join(MIGRATIONS_DIR, f)));
  }
  // The seed runs inside template creation, so it is part of the template's identity.
  h.update(readFileSync(fileURLToPath(new URL("./seed.ts", import.meta.url))));
  h.update(JSON.stringify(overrides));
  return h.digest("hex").slice(0, 12);
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface TestDatabase extends DbHandle {
  url: string;
  name: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(
  opts: { adminUrl?: string; governance?: GovernanceOverrides } = {},
): Promise<TestDatabase> {
  const adminUrl = opts.adminUrl ?? TEST_DATABASE_URL;
  const overrides = opts.governance ?? {};
  const template = `commonair_tpl_${templateHash(overrides)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin`select pg_advisory_lock(hashtext(${template}))`;
    const exists = await admin`select 1 from pg_database where datname = ${template}`;
    if (exists.length === 0) {
      // Build under a temporary name so a failed migration never leaves a broken template behind.
      const building = `${template}_building`;
      await admin.unsafe(`drop database if exists "${building}" with (force)`);
      await admin.unsafe(`create database "${building}"`);
      await runMigrations(withDatabase(adminUrl, building), { governanceOverrides: overrides });
      await admin.unsafe(`alter database "${building}" rename to "${template}"`);
    }
    await admin`select pg_advisory_unlock(hashtext(${template}))`;
    const name = `commonair_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await admin.unsafe(`create database "${name}" template "${template}"`);
    const url = withDatabase(adminUrl, name);
    const handle = createDb({ url, max: 5, applicationName: "commonair-test" });
    return {
      ...handle,
      url,
      name,
      async drop() {
        await handle.close();
        const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
        try {
          await a.unsafe(`drop database if exists "${name}" with (force)`);
        } finally {
          await a.end();
        }
      },
    };
  } finally {
    await admin.end();
  }
}
