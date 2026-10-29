// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { createLogger, initTelemetry } from "@commonair/observability";
import { runService, valkeyCheck } from "@commonair/service";
import { buildDeps, createApp, loadApiEnv, VERSION } from "./index.ts";
import { coopHealth } from "./coop/hooks.ts";
import { opsHealth } from "./ops/hooks.ts";
import { moderationHealth, startModeration } from "./moderation/index.ts";
import { startOverlayHub } from "./overlay/stream.ts";

const env = loadApiEnv();
const logger = createLogger({ service: "api", level: env.LOG_LEVEL });
const telemetry = await initTelemetry({ serviceName: env.OTEL_SERVICE_NAME ?? "api", serviceVersion: VERSION });
const built = await buildDeps(env, { logger });
// Fail closed: a missing key, unreadable hash list or unloadable classifier stops the API here,
// not on the first upload.
await startModeration(built.deps);
const app = createApp(built.deps);
const overlay = startOverlayHub(built.deps);

runService({
  name: "api",
  port: env.API_PORT,
  logger,
  checks: {
    postgres: async () => {
      await built.deps.db.execute(sql`select 1`);
    },
    valkey: valkeyCheck(built.deps.valkey),
    overlay: async () => {
      if (!overlay.warm) throw new Error("overlay subscriber connecting");
    },
  },
  health: { ...moderationHealth(built.deps), ...coopHealth(built.deps), ...opsHealth(built.deps) },
  fetch: (req, server) => app.fetch(req, server),
  onShutdown: async () => {
    await built.close();
    await telemetry.shutdown();
  },
});
