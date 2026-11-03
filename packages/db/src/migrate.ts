// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";
import { type GovernanceOverrides, seedGovernanceSettings, seedLegalDocuments } from "./seed.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Apply all committed migrations, then upsert default governance settings. Idempotent.
 * `seedLegal` inserts the draft legal documents; only the migrate job sets it, because test
 * databases sign users up without accepting documents. `caFile` is the server's CA, as for
 * `createDb` (omitted: `DATABASE_CA_FILE`); with one, the URL must say `sslmode=verify-full`.
 * Needs only the database owner's rights, never a superuser (ADR 0032 §3; external-owner test).
 */
export async function runMigrations(
  url: string,
  opts: { governanceOverrides?: GovernanceOverrides; seedLegal?: boolean; caFile?: string | null } = {},
): Promise<void> {
  const handle = createDb({ url, max: 1, applicationName: "commonair-migrate", caFile: opts.caFile });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
    await seedGovernanceSettings(handle.db, opts.governanceOverrides);
    if (opts.seedLegal) await seedLegalDocuments(handle.db);
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const raw = process.env.GOVERNANCE_BOOTSTRAP_JSON;
  await runMigrations(url, {
    governanceOverrides: raw ? (JSON.parse(raw) as GovernanceOverrides) : {},
    seedLegal: true,
    // An external database's CA (ADR 0032 §3); unset keeps the URL's own sslmode.
    caFile: process.env.DATABASE_CA_FILE || null,
  });
  console.warn("migrations applied");
}
