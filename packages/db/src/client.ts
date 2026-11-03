// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { databaseEnv, loadEnv } from "@commonair/config";
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
  /**
   * PEM file of the server's CA (see {@link postgresTls}). Omitted: `DATABASE_CA_FILE` from the
   * environment, so every service verifies an external database without passing it through.
   * `null`: no CA file, whatever the environment says.
   */
  caFile?: string | null;
}

/** What `postgres()` needs to verify the server: the URL to connect to and the `ssl` option. */
export interface PostgresTls {
  url: string;
  ssl?: { ca: string; rejectUnauthorized: true };
}

/** `DATABASE_CA_FILE`, read through the config schema. */
export function databaseCaFileFromEnv(source?: Record<string, string | undefined>): string | undefined {
  return loadEnv(databaseEnv.pick({ DATABASE_CA_FILE: true }), source).DATABASE_CA_FILE;
}

/**
 * Client TLS for a private CA (ADR 0032 §3, S1-d). postgres.js reads `sslmode` from the URL but
 * not `sslrootcert`, which it would send the server as an unknown startup parameter. So
 * `sslrootcert` is taken out of the URL, and a path there is the CA unless `caFile` names one
 * (libpq's meaning, so one URL serves us and `psql`/`pg_dump`). `system` means the system store,
 * as in libpq. With a CA, or `system`, the URL must say `sslmode=verify-full`: anything weaker
 * skips the hostname check or TLS itself. Otherwise the URL is returned unchanged. Errors never
 * quote the URL, which holds a password.
 */
export function postgresTls(url: string, caFile?: string): PostgresTls {
  // Before parsing: WHATWG URL refuses multi-host URLs (h1:5432,h2:5432), which postgres.js takes.
  if (!caFile && !/[?&]sslrootcert=/.test(url)) return { url };
  const parsed = new URL(url);
  const rootCert = parsed.searchParams.get("sslrootcert");
  const ca = caFile ?? (rootCert && rootCert !== "system" ? rootCert : undefined);
  if (!ca && rootCert === null) return { url };
  parsed.searchParams.delete("sslrootcert");
  const mode = parsed.searchParams.get("sslmode");
  if (mode === null && rootCert === "system" && !ca) parsed.searchParams.set("sslmode", "verify-full");
  else if (mode !== "verify-full") {
    throw new Error(
      `the database CA is set, so the database URL must say sslmode=verify-full (it says ${mode === null ? "no sslmode" : `sslmode=${mode}`})`,
    );
  }
  return {
    url: parsed.toString(),
    ...(ca ? { ssl: { ca: readFileSync(ca, "utf8"), rejectUnauthorized: true as const } } : {}),
  };
}

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close(): Promise<void>;
}

/**
 * Seconds before a pool connection that failed to connect tries again, by pool-wide failure
 * count. The driver's default grows to 20 s and resets only on a successful connect, so after a
 * short outage (a DNS stall) every new connection waited up to 20 s although the database was
 * back. Capped at 2 s, with jitter.
 */
export function reconnectBackoff(retries: number, random: () => number = Math.random): number {
  return Math.min(0.05 * 2 ** retries, 2) * (0.5 + random() / 2);
}

export function createDb({
  url,
  max = 10,
  applicationName = "commonair",
  connectTimeoutSeconds = 10,
  onConnectionClosed,
  caFile,
}: DbOptions): DbHandle {
  const tls = postgresTls(url, caFile === null ? undefined : (caFile ?? databaseCaFileFromEnv()));
  const sql = postgres(tls.url, {
    max,
    ...(tls.ssl ? { ssl: tls.ssl } : {}),
    connect_timeout: connectTimeoutSeconds,
    backoff: (retries: number) => reconnectBackoff(retries),
    ...(onConnectionClosed ? { onclose: onConnectionClosed } : {}),
    connection: { application_name: applicationName },
    // Drizzle handles bigint mode per column; keep int8 as strings at the driver level.
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
