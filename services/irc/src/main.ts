// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Entry point: `bun services/irc/src/main.ts`. */
import { coreEnv, instanceSite, internalEnv, loadEnv, servicePorts } from "@commonair/config";
import { createLogger, initTelemetry } from "@commonair/observability";
import { connectionLimits, ircEnv, trustedProxies } from "./env.ts";
import { startGateway } from "./gateway.ts";
import { startHealth } from "./health.ts";
import { loadTls } from "./tls.ts";
import { websocketUpstream } from "./upstream.ts";

const core = loadEnv(coreEnv);
// Only the upstream URL: the gateway authenticates with each client's own token, never a shared secret.
const { CHAT_INTERNAL_URL } = loadEnv(internalEnv.pick({ CHAT_INTERNAL_URL: true }));
const ports = loadEnv(servicePorts);
const irc = loadEnv(ircEnv);

const telemetry = await initTelemetry({ serviceName: core.OTEL_SERVICE_NAME ?? "irc" });
const logger = createLogger({ service: "irc", level: core.LOG_LEVEL });

const tls = await loadTls({
  certFile: ports.IRC_TLS_CERT_FILE,
  keyFile: ports.IRC_TLS_KEY_FILE,
  production: core.NODE_ENV === "production",
});
if (tls.ephemeral)
  logger.warn("IRC TLS uses an ephemeral self-signed certificate; set IRC_TLS_CERT_FILE and IRC_TLS_KEY_FILE");

const site = instanceSite(core);
const gateway = startGateway({
  tcpPort: ports.IRC_PORT,
  tlsPort: ports.IRC_TLS_PORT,
  wsPort: ports.IRC_WS_PORT,
  tls,
  upstream: websocketUpstream(CHAT_INTERNAL_URL, logger),
  logger,
  motd: `Welcome to ${site.name} chat. Source: ${site.sourceUrl}`,
  connectionLimits: connectionLimits(irc),
  trustedProxies: trustedProxies(core.TRUSTED_PROXY_CIDRS),
});

startHealth({
  gateway,
  port: ports.IRC_HEALTH_PORT,
  logger,
  onShutdown: () => telemetry.shutdown(),
});
