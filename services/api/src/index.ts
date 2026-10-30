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
import { createApiMailer, recipientLimitedMailer } from "./mail.ts";
import { DEFAULT_RATE_LIMITS, valkeyRateLimitStore } from "./lib/ratelimit.ts";
import { pinnedGet, resolveHost } from "./lib/outbound.ts";
import { closeCoopTickRunner } from "./coop/hooks.ts";
import { closeOpsTickRunner } from "./ops/hooks.ts";
import { closeInteractTickRunner } from "./interact/hooks.ts";
import { closeOverlayHub } from "./overlay/stream.ts";
import { closeExportQueue } from "./privacy/export-queue.ts";
import { closeClipQueue } from "./media/clip-queue.ts";
import { closeVodPlacementQueue } from "./media/vod-placement-queue.ts";
import { closeModeration } from "./moderation/runtime.ts";
import { closeWebhookQueue } from "./developer/webhook-queue.ts";
import { closeNotifyQueue } from "./notifications/queue.ts";
import { closeEventSub } from "./eventsub/index.ts";

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
  const basic = `Basic ${Buffer.from(`internal:${env.MEDIA_INTERNAL_PASSWORD}`).toString("base64")}`;
  return {
    mediamtx: () =>
      ok(`${env.MEDIAMTX_API_URL.replace(/\/+$/, "")}/v3/paths/list`, { headers: { authorization: basic } }),
    chat: () => ok(httpOf(env.CHAT_INTERNAL_URL)),
    origin: () => ok(`${env.ORIGIN_INTERNAL_URL.replace(/\/+$/, "")}/readyz`),
  };
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
  const mailer = createApiMailer(env, site, logger);
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
    pinnedGet,
    resolveHost,
    rateLimits: DEFAULT_RATE_LIMITS,
    rateLimitStore: valkeyRateLimitStore(valkey),
    probes: statusProbes(env),
    classifier: classifierFromEnv(process.env).classifier,
    now: () => new Date(),
    ...opts.overrides,
  };
  if (!opts.overrides?.mailer)
    deps.mailer = recipientLimitedMailer(mailer, {
      secret: env.AUTH_SECRET,
      store: () => deps.rateLimitStore,
      rule: () => deps.rateLimits.mail,
      now: () => deps.now(),
      logger,
    });
  return {
    deps,
    db,
    async close() {
      // A queue that cannot close (Valkey gone) must not keep the mailer and pools open.
      await closeModeration(deps).catch((err: unknown) =>
        logger.warn("moderation close failed", { err: (err as Error).name }),
      );
      await closeClipQueue(deps).catch((err: unknown) =>
        logger.warn("clip queue close failed", { err: (err as Error).name }),
      );
      await closeVodPlacementQueue(deps).catch((err: unknown) =>
        logger.warn("vod placement queue close failed", { err: (err as Error).name }),
      );
      await closeCoopTickRunner(deps).catch((err: unknown) =>
        logger.warn("coop queue close failed", { err: (err as Error).name }),
      );
      for (const [what, close] of [
        ["ops queue", closeOpsTickRunner],
        ["interact queue", closeInteractTickRunner],
        ["overlay hub", closeOverlayHub],
        ["export queue", closeExportQueue],
        ["webhook queue", closeWebhookQueue],
        ["notify queue", closeNotifyQueue],
        ["eventsub", closeEventSub],
      ] as const)
        await close(deps).catch((err: unknown) => logger.warn(`${what} close failed`, { err: (err as Error).name }));
      await mailer.close();
      valkey.disconnect();
      await db.close();
    },
  };
}
