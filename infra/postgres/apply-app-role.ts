// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Second step of the `migrate` job: create/update the least-privilege role the
 * services connect as (infra/postgres/app-role.sql). Runs as the database owner.
 *
 *   DATABASE_URL=postgres://owner@postgres/commonair POSTGRES_APP_PASSWORD=... bun infra/postgres/apply-app-role.ts
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

export const APP_ROLE_SQL = readFileSync(new URL("./app-role.sql", import.meta.url), "utf8");

export async function applyAppRole(ownerUrl: string, appPassword: string): Promise<void> {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {}, connect_timeout: 30 });
  try {
    await sql.begin(async (tx) => {
      // Transaction-local: the password never outlives this transaction or enters SQL text.
      await tx`select set_config('commonair.app_password', ${appPassword}, true)`;
      // No parameters → simple query protocol, so the multi-statement file runs as is.
      await tx.unsafe(APP_ROLE_SQL);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  const pw = process.env.POSTGRES_APP_PASSWORD;
  if (!url || !pw) {
    console.error("DATABASE_URL (owner) and POSTGRES_APP_PASSWORD are required");
    process.exit(1);
  }
  try {
    await applyAppRole(url, pw);
    console.warn("app role commonair_app configured");
  } catch (e) {
    console.error(`app role: ${(e as Error).message}`);
    process.exit(1);
  }
}
