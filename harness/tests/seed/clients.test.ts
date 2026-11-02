// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from "vite-plus/test";
import { SIMULATED_IP_HEADER } from "../../src/api/client.ts";
import { SEED_CLIENT_CIDR, seedApiFactory, stopSeedProxy, unitAddressSeed } from "../../src/seed/clients.ts";
import { SEED_UNIT_NAMES } from "../../src/seed/types.ts";
import type { HarnessEnv } from "../../src/env.ts";

afterAll(stopSeedProxy);

describe("seed clients", () => {
  test("every unit draws from its own address stream", () => {
    const seeds = SEED_UNIT_NAMES.map(unitAddressSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  test("each client goes through the proxy with a fresh CGNAT address", async () => {
    const seen: string[] = [];
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        expect(req.headers.get(SIMULATED_IP_HEADER)).toBeNull();
        seen.push(req.headers.get("x-forwarded-for") ?? "");
        return Response.json({});
      },
    });
    try {
      const env = { HARNESS_API_URL: `http://127.0.0.1:${target.port}` } as HarnessEnv;
      const make = seedApiFactory(env, "social");
      for (let i = 0; i < 3; i++) {
        const api = make({ origin: "http://web.test" });
        await api.fetch(new Request(`${api.baseUrl}/healthz`));
      }
    } finally {
      await stopSeedProxy();
      await target.stop(true);
    }
    expect(SEED_CLIENT_CIDR).toBe("100.64.0.0/10");
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    for (const ip of seen) expect(ip).toMatch(/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./);
  });
});
