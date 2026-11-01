// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The W2 raw-SQL helpers on `createDb`'s client, whose timestamp serializers and parsers Drizzle
 * replaces with pass-throughs: a Date parameter must not reach postgres.js as-is, and timestamptz
 * columns read back must be real Dates (CI run 41285945456: rehearsal step 2, trust-safety w2
 * enforcement `before`).
 */
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { rawCell, T1_CELL } from "../../src/w2/enforcement.ts";
import { broadcastEndedAt, downstreamOf, rehearsalAudit, storedChat, vodOf } from "../../src/w2/rehearsal/db.ts";

let t: TestDatabase;
let h: DbHandle;
const owner = uuidv7();
const channelId = uuidv7();
const broadcastId = uuidv7();
const endedAt = new Date("2026-10-31T12:34:56.789Z");
const expiresAt = new Date("2026-11-01T12:34:56.789Z");

beforeAll(async () => {
  t = await createTestDatabase();
  h = createDb({ url: t.url, max: 1 });
  await h.db
    .insert(schema.users)
    .values({ id: owner, name: "w2 time", email: "w2time@example.test", username: "w2time" });
  await h.db.insert(schema.channels).values({ id: channelId, ownerId: owner, slug: "w2time", displayName: "w2time" });
  await h.db.insert(schema.broadcasts).values({
    id: broadcastId,
    channelId,
    ingestProtocol: "rtmp",
    path: `live/${uuidv7()}`,
    startedAt: new Date(endedAt.getTime() - 600_000),
    endedAt,
  });
  await h.db.insert(schema.vods).values({
    channelId,
    broadcastId,
    title: "v",
    storagePrefix: `vods/${uuidv7()}/`,
    status: "ready",
    durationSeconds: 60,
    expiresAt,
  });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await t?.drop();
});

describe("W2 raw SQL with timestamps", () => {
  const since = new Date(Date.now() - 3_600_000);

  test("rehearsal reads take a Date `since`", async () => {
    expect(await downstreamOf(t.url, channelId, owner, since)).toEqual({
      streamEvents: 0,
      deliveries: 0,
      goLiveNotifications: 0,
    });
    expect(await storedChat(t.url, channelId, broadcastId, since)).toEqual({ channel: 0, broadcast: 0 });
    expect(await rehearsalAudit(t.url, channelId, since)).toEqual([]);
  });

  test("rehearsal reads hand timestamptz columns back as Dates", async () => {
    const ended = await broadcastEndedAt(t.url, broadcastId);
    expect(ended).toBeInstanceOf(Date);
    expect(ended?.getTime()).toBe(endedAt.getTime());
    expect(await broadcastEndedAt(t.url, uuidv7())).toBeNull();
    const vod = await vodOf(t.url, broadcastId);
    expect(vod?.expiresAt).toBeInstanceOf(Date);
    expect(vod?.expiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(vod?.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(vod?.createdAt.getTime())).toBe(false);
  });

  test("the enforcement cell count takes a Date `since`", async () => {
    expect(await rawCell(h, T1_CELL, since)).toEqual({ count: 0, fully: 0, overturned: 0 });
  });
});
