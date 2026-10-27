// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * NCII auto-hide moves a hidden VOD's objects from both of its own prefixes (ADR 0009 amendment 1):
 * the row's `storage_prefix` and the other one, where a placement move in flight has copies.
 * Against the stack's Postgres and Garage.
 */
import { vodPrefix } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import type { ObjectStorage } from "@commonair/storage";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { moveHiddenObjects } from "../src/moderation/ncii-clock.ts";
import { nciiHiddenKey } from "../src/moderation/objects.ts";
import { MEDIA_BUCKET, stackStorage } from "./e6-fixtures.ts";
import { makeBroadcast, makeUser } from "./fixtures.ts";

const storage = stackStorage();

describe.skipIf(!storage)("NCII auto-hide object move", () => {
  const S3 = storage as ObjectStorage;
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(() => t?.drop());

  async function list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const o of S3.list(MEDIA_BUCKET, prefix)) keys.push(o.key);
    return keys.sort();
  }

  test("moves the VOD's objects from its storage_prefix and its other own prefix, nothing else", async () => {
    const { channel } = await makeUser(t.db);
    const broadcast = await makeBroadcast(t.db, channel.id);
    const id = uuidv7();
    const bystander = uuidv7();
    const priv = vodPrefix(id, "private");
    const pub = vodPrefix(id, "public");
    // The row says `recordings/`; a placement move to `vods/` has copied part of it already.
    const keys = [`${priv}index.m3u8`, `${priv}init.mp4`, `${priv}seg_000.m4s`, `${pub}index.m3u8`, `${pub}init.mp4`];
    for (const k of keys) await S3.put(MEDIA_BUCKET, k, `bytes of ${k}`, { contentType: "video/mp4" });
    const untouched = `${vodPrefix(bystander, "public")}index.m3u8`;
    await S3.put(MEDIA_BUCKET, untouched, "other VOD", { contentType: "video/mp4" });
    await t.db
      .insert(schema.vods)
      .values({ id, broadcastId: broadcast.id, channelId: channel.id, title: "v", status: "ready", storagePrefix: priv });

    const [req] = await t.db
      .insert(schema.nciiRequests)
      .values({
        requesterName: "r",
        requesterEmail: "r@example.test",
        relationship: "self",
        contentUrls: ["https://example.test/x"],
        description: "d",
        goodFaith: true,
        signature: "r",
        deadlineAt: new Date(0),
      })
      .returning({ id: schema.nciiRequests.id });
    if (!req) throw new Error("no NCII request");
    await t.db.insert(schema.nciiRequestItems).values({
      requestId: req.id,
      url: "https://example.test/x",
      subjectType: "vod",
      subjectId: id,
      hiddenAt: new Date(),
    });

    const ctx = { db: t.db, storage: S3, mediaBucket: MEDIA_BUCKET } as unknown as WorkerContext;
    try {
      expect(await moveHiddenObjects(ctx, req.id)).toBe(keys.length);
      expect(await list(priv)).toEqual([]);
      expect(await list(pub)).toEqual([]);
      for (const k of keys)
        expect(await (await S3.get(MEDIA_BUCKET, nciiHiddenKey(k)))?.text()).toBe(`bytes of ${k}`);
      expect(await S3.head(MEDIA_BUCKET, untouched)).not.toBeNull();
      // Safe to repeat: nothing is left to move.
      expect(await moveHiddenObjects(ctx, req.id)).toBe(0);
    } finally {
      for (const k of keys) await S3.delete(MEDIA_BUCKET, nciiHiddenKey(k));
      await S3.delete(MEDIA_BUCKET, untouched);
    }
  });
});
