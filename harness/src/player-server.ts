// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Serves the harness player page with its scripts bundled from node_modules (hls.js, the oRPC
 * client; nothing from a CDN) and proxies `/rpc` and `/api` to the API. Being same-origin with the
 * API proxy keeps the page free of CORS concerns, and the proxy turns each page's simulated
 * client address into `x-forwarded-for` (see proxy.ts).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { forward } from "./proxy.ts";

const PLAYER_DIR = fileURLToPath(new URL("../player", import.meta.url));

export interface PlayerServer {
  url: string;
  /** The probe as a classic script, for Playwright `addInitScript`. */
  probeScript: string;
  stop(): Promise<void>;
}

async function bundle(entry: string, format: "esm" | "iife"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(PLAYER_DIR, entry)],
    target: "browser",
    format,
    minify: true,
    sourcemap: "none",
  });
  if (!result.success || !result.outputs[0]) {
    throw new Error(`bundling ${entry} failed: ${result.logs.map((l) => l.message).join("; ")}`);
  }
  return result.outputs[0].text();
}

let cachedBundles: Promise<{ player: string; probe: string }> | undefined;

/** Build the player and probe bundles once per process. */
export function playerBundles(): Promise<{ player: string; probe: string }> {
  cachedBundles ??= Promise.all([bundle("player.ts", "esm"), bundle("probe.ts", "iife")]).then(([player, probe]) => ({
    player,
    probe,
  }));
  return cachedBundles;
}

export interface PlayerServerOptions {
  /** API (or forwarding proxy) base URL for `/rpc` and `/api`. */
  apiUrl: string;
}

export async function startPlayerServer(opts: PlayerServerOptions): Promise<PlayerServer> {
  const { player, probe } = await playerBundles();
  const html = await Bun.file(join(PLAYER_DIR, "index.html")).text();
  const headers = {
    // The page only talks to itself (and the HLS origin for media).
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/player.js") {
        return new Response(player, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
      }
      if (pathname === "/probe.js") {
        return new Response(probe, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
      }
      if (pathname === "/healthz") return new Response("ok");
      if (pathname.startsWith("/rpc/") || pathname.startsWith("/api/")) return forward(req, { target: opts.apiUrl });
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    probeScript: probe,
    stop: async () => {
      await server.stop(true);
    },
  };
}
