// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Programmatic entry points: build dependencies and the app (main.ts and tests use these). */
import { instanceSite } from "@commonair/config/env";
import { createDb, type DbHandle } from "@commonair/db";
import { classifierFromEnv } from "@commonair/integrity";
import { createLogger, type Logger } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import { storageFromEnv } from "@commonair/storage";
import { importSigningKey } from "@commonair/tokens";
import pkg from "../package.json" with { type: "json" };
import type { Deps, StatusProbe } from "./deps.ts";
import type { ApiEnv } from "./env.ts";
import { createApiMailer } from "./mail.ts";
import { DEFAULT_RATE_LIMITS, valkeyRateLimitStore } from "./lib/ratelimit.ts";

export { createApp, type ApiApp } from "./http.ts";
export { loadApiEnv, type ApiEnv } from "./env.ts";
export type { Deps } from "./deps.ts";
export type { Router } from "./router.ts";
export { findLeakedKeys, revokeLeakedKey, scanAndRevoke } from "./lib/leaks.ts";

export const VERSION: string = pkg.version;

const probeTimeout = () => AbortSignal.timeout(2000);

/** Readiness probes for components the status page reports on. */
export function statusProbes(env: ApiEnv, doFetch: typeof fetch = fetch): Record<string, StatusProbe> {
  const ok = async (url: string, init: RequestInit = {}) => {
    const res = await doFetch(url, { ...init, signal: probeTimeout() });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
  const httpOf = (ws: string) => {
    const u = new URL(ws.replace(/^ws/, "http"));
    u.pathname = "/readyz";
    return u.toString();
  };
  const basic = `Basic ${Buffer.from(`internal:${env.INTERNAL_API_SECRET}`).toString("base64")}`;
  return {
    mediamtx: () =>
      ok(`${env.MEDIAMTX_API_URL.replace(/\/+$/, "")}/v3/paths/list`, { headers: { authorization: basic } }),
    chat: () => ok(httpOf(env.CHAT_INTERNAL_URL)),
    origin: () => ok(`${env.ORIGIN_INTERNAL_URL.replace(/\/+$/, "")}/readyz`),
  };
}

/**
 * CONTRACT-REQUEST: two_factors needs `verified boolean default true`,
 * `failed_verification_count integer default 0` and `locked_until timestamptz` (better-auth
 * 1.7 two-factor plugin). Two-factor auth turns itself on once the migration adds them.
 */
export async function detectAuthFeatures(db: DbHandle): Promise<{ twoFactor: boolean }> {
  const rows = await db.sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'two_factors'
      and column_name in ('verified', 'failed_verification_count', 'locked_until')`;
  return { twoFactor: rows.length === 3 };
}

export interface BuiltDeps {
  deps: Deps;
  db: DbHandle;
  close(): Promise<void>;
}

export async function buildDeps(
  env: ApiEnv,
  opts: { logger?: Logger; valkeyKeyPrefix?: string; overrides?: Partial<Deps> } = {},
): Promise<BuiltDeps> {
  const logger = opts.logger ?? createLogger({ service: "api", level: env.LOG_LEVEL });
  const db = createDb({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, applicationName: "commonair-api" });
  const valkey = createValkey(env.VALKEY_URL, { keyPrefix: opts.valkeyKeyPrefix, name: "api" });
  const site = instanceSite(env);
  const mailer = createApiMailer(env, site);
  const deps: Deps = {
    env,
    site,
    version: VERSION,
    db: db.db,
    valkey,
    storage: storageFromEnv(env),
    mailer,
    logger,
    signingKey: await importSigningKey(env.PLAYBACK_SIGNING_KEY),
    fetch,
    rateLimits: DEFAULT_RATE_LIMITS,
    rateLimitStore: valkeyRateLimitStore(valkey),
    probes: statusProbes(env),
    authFeatures: await detectAuthFeatures(db),
    classifier: classifierFromEnv(process.env).classifier,
    now: () => new Date(),
    ...opts.overrides,
  };
  if (!deps.authFeatures.twoFactor)
    logger.warn("two-factor authentication disabled: two_factors table lacks the plugin's columns");
  return {
    deps,
    db,
    async close() {
      await mailer.close();
      valkey.disconnect();
      await db.close();
    },
  };
}
