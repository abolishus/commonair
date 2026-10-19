// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Entry point: `bun services/tracker/src/main.ts`. */
import { coreEnv, internalEnv, loadEnv, playbackEnv, servicePorts, trackerEnv, valkeyEnv } from "@commonair/config";
import { createLogger, initTelemetry } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import { importSigningKey } from "@commonair/tokens";
import { trustedProxies } from "./env.ts";
import { startTracker } from "./tracker.ts";

const core = loadEnv(coreEnv);
const { VALKEY_URL } = loadEnv(valkeyEnv);
const { INTERNAL_API_SECRET } = loadEnv(internalEnv.pick({ INTERNAL_API_SECRET: true }));
const { PLAYBACK_SIGNING_KEY } = loadEnv(playbackEnv.pick({ PLAYBACK_SIGNING_KEY: true }));
const { TRACKER_PORT } = loadEnv(servicePorts.pick({ TRACKER_PORT: true }));
const tracker = loadEnv(trackerEnv);

const telemetry = await initTelemetry({ serviceName: core.OTEL_SERVICE_NAME ?? "tracker" });
const logger = createLogger({ service: "tracker", level: core.LOG_LEVEL });
const valkey = createValkey(VALKEY_URL, { name: "tracker" });
// The public half of the playback signing key, derived as services/origin does.
const { publicKey } = await importSigningKey(PLAYBACK_SIGNING_KEY);

startTracker({
  port: TRACKER_PORT,
  logger,
  valkey,
  publicKey,
  internalSecret: INTERNAL_API_SECRET,
  trustedProxies: trustedProxies(core.TRUSTED_PROXY_CIDRS),
  limits: {
    maxConnections: tracker.TRACKER_MAX_CONNECTIONS,
    maxConnectionsPerIp: tracker.TRACKER_MAX_CONNECTIONS_PER_IP,
    maxNumwant: tracker.TRACKER_MAX_NUMWANT,
    tokenMaxAgeSeconds: tracker.TRACKER_TOKEN_MAX_AGE_SECONDS,
  },
  onShutdown: async () => {
    valkey.disconnect();
    await telemetry.shutdown();
  },
});
