// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Common HTTP service runtime: health endpoints, security headers, graceful
 * shutdown on SIGTERM/SIGINT. Every Bun service starts through `runService`.
 *
 *   GET /healthz  liveness: the process is up
 *   GET /readyz   readiness: every `checks` entry passes (used by compose and the status page)
 */
import type { Server, WebSocketHandler } from "bun";
import { createLogger, type Logger } from "@commonair/observability";

export type ReadinessCheck = () => Promise<void>;

export interface ServiceOptions<WS = undefined> {
  name: string;
  port: number;
  hostname?: string;
  logger?: Logger;
  /** Named dependency checks for /readyz; each throws when unhealthy. */
  checks?: Record<string, ReadinessCheck>;
  /** Non-sensitive runtime switches reported by /healthz for operator visibility. */
  health?: Record<string, boolean>;
  fetch: (req: Request, server: Server<WS>) => Response | Promise<Response> | undefined | Promise<Response | undefined>;
  websocket?: WebSocketHandler<WS>;
  /** Called on shutdown after the listener stops accepting connections. */
  onShutdown?: () => Promise<void>;
  /** Max time to wait for onShutdown before exiting. */
  shutdownTimeoutMs?: number;
  /** Seconds an idle connection stays open (Bun default 10). Raise above any long-poll timeout. */
  idleTimeoutSeconds?: number;
  /** Include failing checks' error text in /readyz (internal-only services). Default false. */
  exposeReadinessDetails?: boolean;
}

export interface RunningService<WS = undefined> {
  server: Server<WS>;
  url: URL;
  logger: Logger;
  stop(): Promise<void>;
}

/** Baseline security headers for every response; services may add CSP etc. */
export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

export function withSecurityHeaders(res: Response, extra: Record<string, string> = {}): Response {
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra }))
    if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}

export async function readiness(
  checks: Record<string, ReadinessCheck>,
): Promise<{ ok: boolean; checks: Record<string, string> }> {
  const results = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        await Promise.race([check(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))]);
        return [name, "ok"] as const;
      } catch (e) {
        return [name, e instanceof Error ? e.message : String(e)] as const;
      }
    }),
  );
  return { ok: results.every(([, r]) => r === "ok"), checks: Object.fromEntries(results) };
}

export function runService<WS = undefined>(opts: ServiceOptions<WS>): RunningService<WS> {
  const logger = opts.logger ?? createLogger({ service: opts.name });
  const checks = opts.checks ?? {};
  let stopping = false;

  const server = Bun.serve<WS>({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    idleTimeout: opts.idleTimeoutSeconds ?? 30,
    websocket: opts.websocket as WebSocketHandler<WS>,
    async fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === "/healthz")
        return withSecurityHeaders(
          Response.json({ ok: !stopping, service: opts.name, ...opts.health }, { status: stopping ? 503 : 200 }),
        );
      if (pathname === "/readyz") {
        const r = await readiness(checks);
        if (!r.ok) logger.warn("readiness check failed", { checks: r.checks });
        // Public responses carry pass/fail only: error text can reveal internal hosts and queries.
        const body = opts.exposeReadinessDetails
          ? r
          : {
              ok: r.ok,
              checks: Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v === "ok" ? "ok" : "fail"])),
            };
        return withSecurityHeaders(Response.json(body, { status: r.ok && !stopping ? 200 : 503 }));
      }
      try {
        const res = await opts.fetch(req, srv);
        return res === undefined ? undefined : withSecurityHeaders(res);
      } catch (err) {
        logger.error("unhandled request error", { err, path: pathname, method: req.method });
        return withSecurityHeaders(Response.json({ error: "internal_error" }, { status: 500 }));
      }
    },
  } as Parameters<typeof Bun.serve<WS>>[0]);

  const url = new URL(`http://${server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname}:${server.port}`);
  logger.info("listening", { url: url.toString() });

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down");
    await server.stop();
    await Promise.race([opts.onShutdown?.(), new Promise((r) => setTimeout(r, opts.shutdownTimeoutMs ?? 10_000))]);
  };
  const onSignal = () => {
    void stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  return { server, url, logger, stop };
}
