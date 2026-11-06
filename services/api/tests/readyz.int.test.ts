// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/readyz/public` through the app with the real Valkey limiter: per client address (one
 * address's 429 leaves another's budget alone), Caddy's `X-Forwarded-For` believed only from a
 * trusted proxy, and 404 when no readiness source is wired.
 */
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createApp } from "../src/http.ts";
import { PUBLIC_READYZ_PATH } from "../src/readyz.ts";
import { startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi({ env: { TRUSTED_PROXY_CIDRS: "10.89.42.0/24" } });
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

const body = { ok: true, checks: { postgres: "ok" } };

function get(app: ReturnType<typeof createApp>, peer: string, xff?: string) {
  const req = new Request(`${api.url}${PUBLIC_READYZ_PATH}`, { headers: xff ? { "x-forwarded-for": xff } : {} });
  return app.fetch(req, { requestIP: () => ({ address: peer, family: "IPv4", port: 1 }) });
}

test("not wired: 404", async () => {
  expect((await get(api.app, "192.0.2.1")).status).toBe(404);
});

test("60 a minute per client address behind Caddy; other addresses keep their budget", async () => {
  const app = createApp(api.deps, { readyz: async () => Response.json(body) });
  const caddy = "10.89.42.7";
  // Distinct per run: the limiter's keys live in the shared Valkey.
  const client = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  for (let i = 0; i < 60; i++) expect((await get(app, caddy, client)).status).toBe(200);
  const limited = await get(app, caddy, client);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);

  const other = await get(app, caddy, "203.0.113.9");
  expect(other.status).toBe(200);
  expect(await other.json()).toEqual(body);
  // An untrusted peer's X-Forwarded-For is ignored: it cannot borrow the limited address's key,
  // nor dodge its own by naming another.
  expect((await get(app, "192.0.2.50", client)).status).toBe(200);
});
