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
import { z } from "zod";
import { MAX_BLOCKING_MS } from "./llhls.ts";
import { createMetrics } from "./metrics.ts";
import { createOrigin } from "./origin.ts";

const env = loadEnv(
  coreEnv.and(databaseEnv).and(valkeyEnv).and(internalEnv).and(mediaEnv).and(playbackEnv).and(servicePorts),
);
// CONTRACT-REQUEST: add ORIGIN_ISSUANCE_ENABLED (bool, default true) to playbackEnv and .env.example;
// read locally until then. With it on, replicas elect one issuance leader per tick through Valkey.
const issuanceEnabled = z
  .enum(["true", "false", "1", "0", ""])
  .default("true")
  .transform((v) => v !== "false" && v !== "0")
  .parse(process.env.ORIGIN_ISSUANCE_ENABLED);

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
  cacheMb: env.ORIGIN_CACHE_MB,
  cdn: { provider: env.CDN_PROVIDER, baseUrl: env.CDN_BASE_URL },
  trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS,
  issuance: { enabled: issuanceEnabled },
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
