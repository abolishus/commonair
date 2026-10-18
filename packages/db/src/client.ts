// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
/** A database handle or an open transaction; repository functions accept either. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbOptions {
  url: string;
  max?: number;
  /** Application name reported to Postgres (shows up in pg_stat_activity). */
  applicationName?: string;
}

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDb({ url, max = 10, applicationName = "commonair" }: DbOptions): DbHandle {
  const sql = postgres(url, {
    max,
    connection: { application_name: applicationName },
    // Drizzle handles bigint mode per column; keep int8 as strings at the driver level.
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
