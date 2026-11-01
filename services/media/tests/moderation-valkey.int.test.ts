// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The media moderation Valkey seam (batch 7 §5.6): the service hands `setupModeration` its command
 * connection, which must provide `set`, `incr` and `expire` (rehearsal sample counts). Checked
 * against real Valkey with the service's key prefix, and against the service's wiring.
 */
import { afterAll, expect, test } from "vite-plus/test";
import { createValkey } from "@commonair/service";
import type { ModerationValkey } from "../src/moderation/moderation.ts";
import type { setupModeration } from "../src/moderation/setup.ts";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const keyPrefix = `test:moderation-valkey:${crypto.randomUUID()}:`;
const client = createValkey(VALKEY_URL, { keyPrefix, name: "media" });
afterAll(async () => {
  await client.quit();
});

test("the service's Valkey connection satisfies the seam: incr counts, expire sets the TTL", async () => {
  // Compile-time: what `createValkey` returns is what `setupModeration` and `ModerationDeps` take.
  const seam: ModerationValkey = client;
  const setupArg: Parameters<typeof setupModeration>[0]["valkey"] = client;
  expect(setupArg).toBe(seam);

  expect(await seam.incr("samples")).toBe(1);
  expect(await seam.incr("samples")).toBe(2);
  expect(await seam.expire("samples", 60)).toBe(1);
  const ttl = await client.ttl("samples");
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(60);
  // A missing key is not created by expire.
  expect(await seam.expire("absent", 60)).toBe(0);
  await seam.set("frame", Buffer.from([1, 2, 3]), "EX", 5);
  expect(await client.ttl("frame")).toBeGreaterThan(0);
  await client.del("samples", "frame");
});

test("the media service passes its command connection to moderation", async () => {
  const src = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();
  const call = src.slice(src.indexOf("await setupModeration({"));
  const args = call.slice(0, call.indexOf("});"));
  expect(src).toContain('const valkey = createValkey(env.VALKEY_URL, { keyPrefix: opts.keyPrefix, name: "media" });');
  expect(args).toMatch(/\n\s*valkey,\n/);
});
