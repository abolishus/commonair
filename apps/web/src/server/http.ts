// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Request routing for the production web server (see `server.ts`). */
import { join, normalize } from "node:path";
import { isProxied, proxy, type Fetcher } from "./proxy.ts";
import { securityHeaders } from "./security.ts";

export { securityHeaders } from "./security.ts";

export interface WebServerOptions {
  port: number;
  hostname?: string;
  apiUrl: string;
  /** PUBLIC_URL, reported to the API as x-forwarded-host/proto. */
  publicUrl: string;
  /** Built client assets (dist/client). */
  clientDir: string;
  /** TanStack Start's server entry. */
  ssr: (req: Request) => Response | Promise<Response>;
  fetchUpstream?: Fetcher;
}

/** Request bodies are small JSON (auth forms, RPC inputs); uploads go straight to object storage. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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

function withHeaders(res: Response, headers: Record<string, string>): Response {
  // Responses from fetch/handlers may have immutable headers; copy before changing them.
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export function createHandler(opts: Omit<WebServerOptions, "port" | "hostname">) {
  const target = { api: opts.apiUrl, publicUrl: opts.publicUrl };
  return async (req: Request, clientAddress: string | null): Promise<Response> => {
    const url = new URL(req.url);
    // The API sets its own headers on what it answers.
    if (isProxied(url.pathname)) return proxy(req, target, clientAddress, opts.fetchUpstream);
    const security = securityHeaders(url.pathname);
    // The web server has no dependencies of its own to be ready for: liveness = readiness.
    if (url.pathname === "/healthz" || url.pathname === "/readyz")
      return new Response(HEALTH, {
        headers: { "content-type": "application/json", "cache-control": "no-store", ...security },
      });
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname !== "/") {
      const path = staticPath(opts.clientDir, url.pathname);
      const file = path ? Bun.file(path) : null;
      if (file && (await file.exists())) {
        // Hashed build assets never change; anything else revalidates.
        const immutable = url.pathname.startsWith("/assets/");
        return new Response(file, {
          headers: {
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
            ...security,
          },
        });
      }
    }
    // Rendered pages and server-function results carry the visitor's session: never cache them shared.
    return withHeaders(await opts.ssr(req), { "cache-control": "private, no-store", ...security });
  };
}

export function createWebServer(opts: WebServerOptions) {
  const handle = createHandler(opts);
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // Streaming proxy responses (e.g. slow API calls) must not hit Bun's default idle timeout.
    idleTimeout: 120,
    fetch: (req, server) => handle(req, server.requestIP(req)?.address ?? null),
  });
}
