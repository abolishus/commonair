// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Health HTTP endpoint (IRC_HEALTH_PORT): /healthz, /readyz and /stats with
 * connection counts. Shutdown of the whole process is driven from here
 * (runService owns SIGTERM), which announces RECONNECT to every client.
 */
import type { Logger } from "@commonair/observability";
import { runService, type RunningService } from "@commonair/service";
import type { Gateway } from "./gateway.ts";

export function startHealth(opts: {
  gateway: Gateway;
  port: number;
  hostname?: string;
  logger: Logger;
  onShutdown?: () => Promise<void>;
}): RunningService {
  const { gateway } = opts;
  return runService({
    name: "irc",
    port: opts.port,
    hostname: opts.hostname,
    logger: opts.logger,
    checks: {
      listeners: async () => {
        if (gateway.ports.tcp === null && gateway.ports.tls === null && gateway.ports.ws === null)
          throw new Error("no listener running");
      },
    },
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/stats" && req.method === "GET") return Response.json(gateway.stats());
      return Response.json({ error: "not_found" }, { status: 404 });
    },
    onShutdown: async () => {
      await gateway.shutdown();
      await opts.onShutdown?.();
    },
  });
}
