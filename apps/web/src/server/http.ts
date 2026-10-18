// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Request routing for the production web server (see `server.ts`). */
import { join, normalize } from "node:path";
import { isProxied, proxy, type Fetcher } from "./proxy.ts";

export interface WebServerOptions {
  port: number;
  hostname?: string;
  apiUrl: string;
  /** Built client assets (dist/client). */
  clientDir: string;
  /** TanStack Start's server entry. */
  ssr: (req: Request) => Response | Promise<Response>;
  fetchUpstream?: Fetcher;
}

const HEALTH = JSON.stringify({ status: "ok" });

/** A file under `root` for this URL path, or null (never escapes `root`). */
export function staticPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = normalize(join(root, decoded));
  const base = normalize(root.endsWith("/") ? root : `${root}/`);
  return full.startsWith(base) && full !== base ? full : null;
}

export function createHandler(opts: Omit<WebServerOptions, "port" | "hostname">) {
  return async (req: Request, clientAddress: string | null): Promise<Response> => {
    const url = new URL(req.url);
    // The web server has no dependencies of its own to be ready for: liveness = readiness.
    if (url.pathname === "/healthz" || url.pathname === "/readyz")
      return new Response(HEALTH, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (isProxied(url.pathname)) return proxy(req, opts.apiUrl, clientAddress, opts.fetchUpstream);
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname !== "/") {
      const path = staticPath(opts.clientDir, url.pathname);
      const file = path ? Bun.file(path) : null;
      if (file && (await file.exists())) {
        // Hashed build assets never change; anything else revalidates.
        const immutable = url.pathname.startsWith("/assets/");
        return new Response(file, {
          headers: {
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
          },
        });
      }
    }
    return opts.ssr(req);
  };
}

export function createWebServer(opts: WebServerOptions) {
  const handle = createHandler(opts);
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    // Streaming proxy responses (e.g. slow API calls) must not hit Bun's default idle timeout.
    idleTimeout: 120,
    fetch: (req, server) => handle(req, server.requestIP(req)?.address ?? null),
  });
}
