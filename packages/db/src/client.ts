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
  /**
   * Seconds to establish a connection, name lookup included (default 10; the driver's own is 30).
   * A pool connection opened while in-network DNS or the database stalls fails and is retried
   * instead of holding queries for half a minute.
   */
  connectTimeoutSeconds?: number;
  /** Called with the pool connection's id whenever one closes (diagnostics). */
  onConnectionClosed?: (connectionId: number) => void;
}

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDb({
  url,
  max = 10,
  applicationName = "commonair",
  connectTimeoutSeconds = 10,
  onConnectionClosed,
}: DbOptions): DbHandle {
  const sql = postgres(url, {
    max,
    connect_timeout: connectTimeoutSeconds,
    ...(onConnectionClosed ? { onclose: onConnectionClosed } : {}),
    connection: { application_name: applicationName },
    // Drizzle handles bigint mode per column; keep int8 as strings at the driver level.
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
