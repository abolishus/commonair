// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Chat service entry point. */
import { coreEnv, databaseEnv, internalEnv, loadEnv, servicePorts, valkeyEnv } from "@commonair/config";
import { createDb } from "@commonair/db";
import { createLogger, initTelemetry } from "@commonair/observability";
import { startChatService } from "./server.ts";

const env = loadEnv(coreEnv.and(databaseEnv).and(valkeyEnv).and(internalEnv).and(servicePorts));
const telemetry = await initTelemetry({ serviceName: env.OTEL_SERVICE_NAME ?? "chat" });
const logger = createLogger({ service: "chat", level: env.LOG_LEVEL });
const db = createDb({
  url: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  applicationName: "commonair-chat",
  onConnectionClosed: (connectionId) => logger.info("postgres connection closed", { connectionId }),
});

const chat = await startChatService({
  port: env.CHAT_PORT,
  db: db.db,
  valkeyUrl: env.VALKEY_URL,
  internalSecret: env.INTERNAL_API_SECRET,
  logger,
  // Enough for a join's parallel reads, without holding the whole pool open.
  warmConnections: Math.min(4, env.DATABASE_POOL_MAX),
  // SIGTERM/SIGINT close sockets and flush chat first; then the pool and telemetry.
  onShutdown: async () => {
    await Promise.allSettled([db.close(), telemetry.shutdown()]);
  },
});
logger.info("chat ready", { url: chat.wsUrl });
