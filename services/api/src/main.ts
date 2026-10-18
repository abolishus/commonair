// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { createLogger, initTelemetry } from "@commonair/observability";
import { runService, valkeyCheck } from "@commonair/service";
import { buildDeps, createApp, loadApiEnv, VERSION } from "./index.ts";

const env = loadApiEnv();
const logger = createLogger({ service: "api", level: env.LOG_LEVEL });
const telemetry = await initTelemetry({ serviceName: env.OTEL_SERVICE_NAME ?? "api", serviceVersion: VERSION });
const built = await buildDeps(env, { logger });
const app = createApp(built.deps);

runService({
  name: "api",
  port: env.API_PORT,
  logger,
  checks: {
    postgres: async () => {
      await built.deps.db.execute(sql`select 1`);
    },
    valkey: valkeyCheck(built.deps.valkey),
  },
  fetch: (req, server) => app.fetch(req, server),
  onShutdown: async () => {
    await built.close();
    await telemetry.shutdown();
  },
});
