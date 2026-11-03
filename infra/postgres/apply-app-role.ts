// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Second step of the `migrate` job: create/update the least-privilege role the services connect
 * as (infra/postgres/app-role.sql) and, when its password is set, the read-only metrics role
 * (infra/postgres/monitor-role.sql). Runs as the database owner; no superuser needed (ADR 0032 §3).
 *
 *   DATABASE_URL=postgres://owner@postgres/commonair POSTGRES_APP_PASSWORD=... \
 *     [POSTGRES_MONITOR_PASSWORD=...] [DATABASE_CA_FILE=/run/secrets/pg-ca] bun infra/postgres/apply-app-role.ts
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { postgresTls } from "../../packages/db/src/client.ts";

export const APP_ROLE_SQL = readFileSync(new URL("./app-role.sql", import.meta.url), "utf8");
export const MONITOR_ROLE_SQL = readFileSync(new URL("./monitor-role.sql", import.meta.url), "utf8");

export interface ApplyRolesOptions {
  /** Creates or updates `commonair_monitor` too (at least 12 characters). Omitted: skipped. */
  monitorPassword?: string;
  /** PEM file of the server's CA; the URL must then say `sslmode=verify-full`. */
  caFile?: string;
}

export interface ApplyRolesResult {
  /** `granted`: commonair_monitor is in pg_monitor; `not-grantable`: the owner could not grant it. */
  monitor: "skipped" | "granted" | "not-grantable";
}

export async function applyAppRole(
  ownerUrl: string,
  appPassword: string,
  opts: ApplyRolesOptions = {},
): Promise<ApplyRolesResult> {
  const tls = postgresTls(ownerUrl, opts.caFile);
  const sql = postgres(tls.url, {
    max: 1,
    onnotice: () => {},
    connect_timeout: 30,
    ...(tls.ssl ? { ssl: tls.ssl } : {}),
  });
  try {
    return await sql.begin(async (tx): Promise<ApplyRolesResult> => {
      // Transaction-local: the passwords never outlive this transaction or enter SQL text.
      await tx`select set_config('commonair.app_password', ${appPassword}, true)`;
      // No parameters → simple query protocol, so the multi-statement file runs as is.
      await tx.unsafe(APP_ROLE_SQL);
      if (opts.monitorPassword === undefined) return { monitor: "skipped" };
      await tx`select set_config('commonair.monitor_password', ${opts.monitorPassword}, true)`;
      await tx.unsafe(MONITOR_ROLE_SQL);
      const [row] = await tx<{ member: boolean }[]>`
        select pg_has_role('commonair_monitor', 'pg_monitor', 'MEMBER') as member`;
      return { monitor: row?.member ? "granted" : "not-grantable" };
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
    const result = await applyAppRole(url, pw, {
      monitorPassword: process.env.POSTGRES_MONITOR_PASSWORD || undefined,
      caFile: process.env.DATABASE_CA_FILE || undefined,
    });
    console.warn("app role commonair_app configured");
    if (result.monitor === "granted") console.warn("monitor role commonair_monitor configured (pg_monitor)");
    if (result.monitor === "not-grantable") {
      console.warn("monitor role commonair_monitor configured without pg_monitor: the owner cannot grant it");
    }
  } catch (e) {
    console.error(`app role: ${(e as Error).message}`);
    process.exit(1);
  }
}
