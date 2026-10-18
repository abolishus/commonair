// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, expect, test } from "vite-plus/test";
import { createValkey, valkeyCheck } from "../src/valkey.ts";

const url = process.env.VALKEY_URL ?? "redis://localhost:6379";
const client = createValkey(url, { keyPrefix: `test:${crypto.randomUUID()}:` });
afterAll(() => client.quit());

test("connects, isolates keys by prefix, passes readiness", async () => {
  await valkeyCheck(client)();
  await client.set("k", "v", "EX", 10);
  expect(await client.get("k")).toBe("v");
});
