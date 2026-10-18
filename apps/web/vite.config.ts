// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite-plus";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** `/healthz` and `/readyz` in dev, matching what `server.ts` answers in production. */
function healthz(): Plugin {
  return {
    name: "commonair-healthz",
    configureServer(server) {
      for (const path of ["/healthz", "/readyz"])
        server.middlewares.use(path, (_req, res) => {
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify({ status: "ok" }));
        });
    },
  };
}

/**
 * The repo-root `.env` is the instance config in development (services read the same file).
 * Vite's `loadEnv` also records a NODE_ENV it finds as VITE_USER_NODE_ENV, which would turn a
 * production build into a development one (dev JSX runtime); drop that side effect.
 */
function rootEnv(mode: string): Record<string, string> {
  const had = "VITE_USER_NODE_ENV" in process.env;
  const env = loadEnv(mode, repoRoot, "");
  if (!had) delete process.env.VITE_USER_NODE_ENV;
  delete env.NODE_ENV;
  return env;
}

export default defineConfig(({ mode, command }) => {
  const fileEnv = rootEnv(mode);
  // Dev only: server functions read the instance env from process.env, as in production.
  if (command === "serve") for (const [k, v] of Object.entries(fileEnv)) process.env[k] ??= v;
  const env = { ...fileEnv, ...process.env };
  const api = env.API_INTERNAL_URL || "http://localhost:3001";
  const proxied = { target: api, changeOrigin: false, xfwd: true };
  return {
    server: {
      port: Number(env.WEB_PORT || 3000),
      strictPort: true,
      // Same-origin API in dev too, so better-auth cookies are first-party (production: server.ts).
      proxy: { "/api": proxied, "/rpc": proxied },
    },
    plugins: [healthz(), tailwindcss(), tanstackStart(), react()],
    test: {
      include: ["tests/**/*.test.{ts,tsx}"],
      environment: "node",
    },
  };
});
