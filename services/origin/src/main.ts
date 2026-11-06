// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Origin HLS edge entry point. `bun src/main.ts` loads the env and serves; tests import
 * `serveOrigin` and run the same wiring on a port of their own.
 */
import {
  coreEnv,
  databaseEnv,
  dvrEnv,
  internalEnv,
  loadEnv,
  mediaEnv,
  playbackEnv,
  servicePorts,
  storageEnv,
  valkeyEnv,
} from "@commonair/config";
import { createDb } from "@commonair/db";
import { createLogger, initTelemetry } from "@commonair/observability";
import { createValkey, runService, valkeyCheck, type RunningService } from "@commonair/service";
import { storageFromEnv } from "@commonair/storage";
import { MAX_BLOCKING_MS } from "./llhls.ts";
import { createMetrics } from "./metrics.ts";
import { createOrigin, type Origin } from "./origin.ts";
import { createPublicReadyz, PUBLIC_READYZ_PATH } from "./readyz.ts";

/** The origin's env (the schemas `scripts/selfhost/unit-env.ts` mirrors from this call). */
export const loadOriginEnv = (source: Record<string, string | undefined> = process.env) =>
  loadEnv(
    coreEnv
      .and(databaseEnv)
      .and(valkeyEnv)
      .and(internalEnv)
      .and(mediaEnv)
      .and(playbackEnv)
      .and(storageEnv)
      .and(servicePorts)
      .and(dvrEnv),
    source,
  );

export type OriginEnv = ReturnType<typeof loadOriginEnv>;

export interface ServedOrigin {
  service: RunningService;
  origin: Origin;
}

/** Connect, wire and serve the origin on `ORIGIN_PORT` (0 picks a free port). */
export async function serveOrigin(env: OriginEnv, opts: { hostname?: string } = {}): Promise<ServedOrigin> {
  if (env.CDN_PROVIDER === "origin-pull" && !env.CDN_BASE_URL)
    throw new Error("CDN_PROVIDER=origin-pull requires CDN_BASE_URL");
  const telemetry = await initTelemetry({ serviceName: env.OTEL_SERVICE_NAME ?? "origin" });
  const logger = createLogger({ service: "origin", level: env.LOG_LEVEL });

  const db = createDb({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, applicationName: "commonair-origin" });
  const valkey = createValkey(env.VALKEY_URL, { name: "origin" });

  const origin = await createOrigin({
    db: db.db,
    valkey,
    playbackSigningKey: env.PLAYBACK_SIGNING_KEY,
    mediamtxHlsUrl: env.MEDIAMTX_HLS_URL,
    internalSecret: env.INTERNAL_API_SECRET,
    mediaPassword: env.MEDIA_INTERNAL_PASSWORD,
    cacheMb: env.ORIGIN_CACHE_MB,
    cdn: { provider: env.CDN_PROVIDER, baseUrl: env.CDN_BASE_URL },
    trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS,
    dvrMaxWindowSeconds: env.DVR_MAX_WINDOW_SECONDS,
    issuance: { enabled: env.ORIGIN_ISSUANCE_ENABLED },
    media: { storage: storageFromEnv(env), bucket: env.S3_BUCKET_MEDIA },
    logger,
    metrics: createMetrics(),
  });
  origin.start();
  // The public readiness route relays the listener's own `/readyz`, so it answers exactly as
  // compose's health check does (including 503 while shutting down). It asks the port the
  // listener got, which is ORIGIN_PORT unless that is 0.
  let port = env.ORIGIN_PORT;
  const publicReadyz = createPublicReadyz({
    trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS,
    ready: () => fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(5000) }),
    logger,
  });

  const service = runService({
    name: "origin",
    port: env.ORIGIN_PORT,
    hostname: opts.hostname,
    logger,
    // Connections must outlive the longest LL-HLS blocking reload the origin holds open.
    idleTimeoutSeconds: Math.ceil(MAX_BLOCKING_MS / 1000) + 15,
    checks: {
      postgres: async () => {
        await db.sql`select 1`;
      },
      valkey: valkeyCheck(valkey),
      mediamtx: async () => {
        // Any HTTP answer means the HLS listener is up; only network errors fail readiness.
        const res = await fetch(env.MEDIAMTX_HLS_URL, { signal: AbortSignal.timeout(1500) });
        await res.body?.cancel();
      },
    },
    fetch: (req, server) => {
      const peer = server.requestIP(req)?.address;
      return new URL(req.url).pathname === PUBLIC_READYZ_PATH ? publicReadyz(req, peer) : origin.fetch(req, peer);
    },
    async onShutdown() {
      await origin.stop();
      await Promise.allSettled([db.close(), valkey.quit(), telemetry.shutdown()]);
    },
  });
  port = service.server.port ?? port;
  return { service, origin };
}

if (import.meta.main) await serveOrigin(loadOriginEnv());
