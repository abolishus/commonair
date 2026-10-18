// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, expect, test } from "vite-plus/test";
import { createLogger } from "@commonair/observability";
import { runService } from "../src/server.ts";

let healthy = true;
const svc = runService({
  name: "test",
  port: 0,
  hostname: "127.0.0.1",
  logger: createLogger({ service: "test", write: () => {} }),
  checks: {
    dep: async () => {
      if (!healthy) throw new Error("dep down");
    },
  },
  fetch: (req) => {
    if (new URL(req.url).pathname === "/boom") throw new Error("boom");
    return new Response("hi");
  },
});
afterAll(() => svc.stop());

test("health, readiness and security headers", async () => {
  expect((await fetch(new URL("/healthz", svc.url))).status).toBe(200);
  expect((await fetch(new URL("/readyz", svc.url))).status).toBe(200);
  healthy = false;
  const r = await fetch(new URL("/readyz", svc.url));
  expect(r.status).toBe(503);
  expect(await r.json()).toMatchObject({ ok: false, checks: { dep: "dep down" } });
  const res = await fetch(new URL("/", svc.url));
  expect(await res.text()).toBe("hi");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("unhandled errors become 500 without leaking details", async () => {
  const res = await fetch(new URL("/boom", svc.url));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "internal_error" });
});
