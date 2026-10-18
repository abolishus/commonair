// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";
import { type GovernanceOverrides, seedGovernanceSettings } from "./seed.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Apply all committed migrations, then upsert default governance settings. Idempotent. */
export async function runMigrations(
  url: string,
  opts: { governanceOverrides?: GovernanceOverrides } = {},
): Promise<void> {
  const handle = createDb({ url, max: 1, applicationName: "commonair-migrate" });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
    await seedGovernanceSettings(handle.db, opts.governanceOverrides);
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
  });
  console.warn("migrations applied");
}
