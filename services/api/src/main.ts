// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { createLogger, initTelemetry } from "@commonair/observability";
import { runService, valkeyCheck } from "@commonair/service";
import { buildDeps, createApp, loadApiEnv, VERSION } from "./index.ts";
import { coopHealth } from "./coop/hooks.ts";
import { opsHealth } from "./ops/hooks.ts";
import { interactHealth } from "./interact/hooks.ts";
import { moderationHealth, startModeration } from "./moderation/index.ts";
import { startOverlayHub } from "./overlay/stream.ts";
import { EVENTSUB_WS_PATH } from "@commonair/contracts/eventsub";
import { startEventSub, type EventSubSocketData } from "./eventsub/index.ts";

const env = loadApiEnv();
const logger = createLogger({ service: "api", level: env.LOG_LEVEL });
const telemetry = await initTelemetry({ serviceName: env.OTEL_SERVICE_NAME ?? "api", serviceVersion: VERSION });
const built = await buildDeps(env, { logger });
// Fail closed: a missing key, unreadable hash list or unloadable classifier stops the API here,
// not on the first upload.
await startModeration(built.deps);
const app = createApp(built.deps);
const overlay = startOverlayHub(built.deps);
// Before runService: E9-ws registers its SIGTERM drain here, so it runs before the server stops.
const eventsub = startEventSub(built.deps);

runService<EventSubSocketData>({
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
    eventsub: async () => {
      if (!eventsub.warm) throw new Error("eventsub subscriber connecting");
    },
  },
  health: {
    ...moderationHealth(built.deps),
    ...coopHealth(built.deps),
    ...opsHealth(built.deps),
    ...interactHealth(built.deps),
  },
  fetch: (req, server) =>
    new URL(req.url).pathname === EVENTSUB_WS_PATH ? eventsub.upgrade(req, server) : app.fetch(req, server),
  websocket: eventsub.websocket,
  // runService bounds onShutdown by this; the reconnect grace plus room to close pools.
  shutdownTimeoutMs: (built.deps.env.EVENTSUB_WS_RECONNECT_GRACE_SECONDS + 10) * 1000,
  onShutdown: async () => {
    await built.close();
    await telemetry.shutdown();
  },
});
