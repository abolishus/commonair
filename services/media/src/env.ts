// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import {
  ALL_ENV_SCHEMAS,
  authEnv,
  databaseEnv,
  developerEnv,
  internalEnv,
  mediaEnv,
  servicePorts,
  storageEnv,
  valkeyEnv,
} from "@commonair/config";

/** Everything the media service reads from its environment, validated at boot. */
export const mediaServiceEnv = z.object({
  ...ALL_ENV_SCHEMAS.coreEnv.pick({ NODE_ENV: true, LOG_LEVEL: true, OTEL_EXPORTER_OTLP_ENDPOINT: true }).shape,
  ...mediaEnv.shape,
  ...storageEnv.shape,
  ...databaseEnv.shape,
  ...valkeyEnv.shape,
  ...internalEnv.shape,
  AUTH_SECRET: authEnv.shape.AUTH_SECRET,
  MEDIA_PORT: servicePorts.shape.MEDIA_PORT,
  /** Dev/harness only: simulcast targets on loopback/private networks are allowed. */
  OUTBOUND_ALLOW_PRIVATE_NETWORKS: developerEnv.shape.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
});
export type MediaServiceEnv = z.output<typeof mediaServiceEnv>;
