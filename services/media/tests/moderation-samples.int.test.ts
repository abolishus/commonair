// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearsal moderation sample count against real Postgres and Valkey: the frame scan reads the
 * broadcast's kind and counts `KEYS.rehearsalModerationSamples` for a rehearsal (with the report's
 * TTL), never for a live broadcast.
 */
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { KEYS, REHEARSAL_REPORT_TTL_SECONDS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import { fakeFrame, makeModeration } from "./helpers/moderation.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const keyPrefix = `test:moderation-samples:${crypto.randomUUID()}:`;
const valkey = createValkey(VALKEY_URL, { keyPrefix, name: "media" });
let t: TestDatabase;
let live: { broadcastId: string; channelId: string; path: string };
let rehearsal: { broadcastId: string; channelId: string; path: string };

beforeAll(async () => {
  t = await createTestDatabase();
  const [u] = await t.db
    .insert(schema.users)
    .values({ name: "ms", email: "ms@example.test", username: "ms" })
    .returning({ id: schema.users.id });
  const [c] = await t.db
    .insert(schema.channels)
    .values({ ownerId: u!.id, slug: "ms", displayName: "MS" })
    .returning({ id: schema.channels.id });
  const broadcast = async (kind: "live" | "rehearsal") => {
    const [b] = await t.db
      .insert(schema.broadcasts)
      .values({ channelId: c!.id, ingestProtocol: "rtmp", path: "live/ms", kind })
      .returning({ id: schema.broadcasts.id });
    return { broadcastId: b!.id, channelId: c!.id, path: "live/ms" };
  };
  live = await broadcast("live");
  rehearsal = await broadcast("rehearsal");
});
afterAll(async () => {
  await valkey.quit();
  await t?.drop();
});

test("the counter rises for a rehearsal's frames and never for a live broadcast's", async () => {
  const { moderation } = await makeModeration({ db: t.app.db, valkey });
  for (let i = 0; i < 3; i++) {
    await moderation.scanLiveFrame(rehearsal, fakeFrame("1", 90), new Date());
    await moderation.scanLiveFrame(live, fakeFrame("2", 90), new Date());
  }
  expect(await valkey.get(KEYS.rehearsalModerationSamples(rehearsal.broadcastId))).toBe("3");
  const ttl = await valkey.ttl(KEYS.rehearsalModerationSamples(rehearsal.broadcastId));
  expect(ttl).toBeGreaterThan(REHEARSAL_REPORT_TTL_SECONDS - 60);
  expect(ttl).toBeLessThanOrEqual(REHEARSAL_REPORT_TTL_SECONDS);
  expect(await valkey.exists(KEYS.rehearsalModerationSamples(live.broadcastId))).toBe(0);
});
