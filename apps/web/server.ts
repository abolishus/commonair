// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Production server for the built app (`vp build` → dist/): `/healthz`, the same-origin API
 * proxy, static client assets, and TanStack Start's SSR handler for everything else.
 *
 *   bun server.ts            (the container's `bun run start`; listens on WEB_PORT, default 3000)
 */
import { createLogger } from "@commonair/observability";
import { loadWebEnv } from "./src/server/env.ts";
import { createWebServer } from "./src/server/http.ts";

const env = loadWebEnv();
const logger = createLogger({ service: "web", level: env.LOG_LEVEL });
const distDir = new URL("./dist/", import.meta.url);
const ssr = (await import(new URL("server/server.js", distDir).href)) as {
  default: { fetch: (req: Request) => Response | Promise<Response> };
};

const server = createWebServer({
  port: env.WEB_PORT,
  apiUrl: env.API_INTERNAL_URL,
  clientDir: new URL("client/", distDir).pathname,
  ssr: (req) => ssr.default.fetch(req),
});

logger.info("web listening", { port: server.port });

const shutdown = () => {
  void server.stop().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
