// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Entry point: `bun src/main.ts`. */
import { loadEnv } from "@commonair/config";
import { createLogger, initTelemetry } from "@commonair/observability";
import { runService } from "@commonair/service";
import { mediaServiceEnv } from "./env.ts";
import { createMediaService } from "./service.ts";

const env = loadEnv(mediaServiceEnv);
const logger = createLogger({ service: "media", level: env.LOG_LEVEL });
const telemetry = await initTelemetry({ serviceName: "media", endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT });
const media = await createMediaService({ env, logger });

runService({
  name: "media",
  port: env.MEDIA_PORT,
  logger,
  checks: media.checks,
  // Only /healthz and /readyz are served; media has no public HTTP surface.
  fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
  onShutdown: async () => {
    await media.stop();
    await telemetry.shutdown();
  },
  // ffmpeg gets 10 s to flush the last VOD segment on SIGINT.
  shutdownTimeoutMs: 20_000,
});
await media.start();
