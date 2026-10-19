// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Origin HLS edge entry point. */
import {
  coreEnv,
  databaseEnv,
  internalEnv,
  loadEnv,
  mediaEnv,
  playbackEnv,
  servicePorts,
  valkeyEnv,
} from "@commonair/config";
import { createDb } from "@commonair/db";
import { createLogger, initTelemetry } from "@commonair/observability";
import { createValkey, runService, valkeyCheck } from "@commonair/service";
import { MAX_BLOCKING_MS } from "./llhls.ts";
import { createMetrics } from "./metrics.ts";
import { createOrigin } from "./origin.ts";

const env = loadEnv(
  coreEnv.and(databaseEnv).and(valkeyEnv).and(internalEnv).and(mediaEnv).and(playbackEnv).and(servicePorts),
);

const telemetry = await initTelemetry({ serviceName: env.OTEL_SERVICE_NAME ?? "origin" });
const logger = createLogger({ service: "origin", level: env.LOG_LEVEL });
if (env.CDN_PROVIDER === "origin-pull" && !env.CDN_BASE_URL)
  throw new Error("CDN_PROVIDER=origin-pull requires CDN_BASE_URL");

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
  issuance: { enabled: env.ORIGIN_ISSUANCE_ENABLED },
  logger,
  metrics: createMetrics(),
});
origin.start();

runService({
  name: "origin",
  port: env.ORIGIN_PORT,
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
  fetch: (req, server) => origin.fetch(req, server.requestIP(req)?.address),
  async onShutdown() {
    await origin.stop();
    await Promise.allSettled([db.close(), valkey.quit(), telemetry.shutdown()]);
  },
});
