// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hashRemovedContent` after `ncii.decide` → `removed`. The API sets each resolved item's
 * `removed_at` in the decision transaction (the avatar guard trigger depends on it), so the job
 * must not read `removed_at` as "already hashed": that made it skip every item (trust-safety
 * step 7: no hashes on the local NCII list).
 */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { schema } from "@commonair/db";
import type { ObjectInfo, ObjectStorage } from "@commonair/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { hashRemovedContent } from "../src/moderation/ncii-hash.ts";
import { makeUser } from "./fixtures.ts";

const BUCKET = "media";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(() => t?.drop());

function memoryStorage(): ObjectStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async get(_bucket, key) {
      const b = objects.get(key);
      return b ? new Response(new Uint8Array(b)) : null;
    },
    async delete(_bucket, key) {
      objects.delete(key);
    },
    async *list(_bucket, prefix): AsyncIterable<ObjectInfo> {
      for (const [key, b] of objects)
        if (key.startsWith(prefix)) yield { key, size: b.byteLength, etag: "", lastModified: new Date(0) };
    },
  } as ObjectStorage & { objects: Map<string, Uint8Array> };
}

async function testImage(): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  expect(await proc.exited).toBe(0);
  return bytes;
}

test("hashes the items the API already marked removed, then deletes their objects, once", async () => {
  const { user, channel } = await makeUser(t.db);
  const key = `channels/${channel.id}/panels/abc.png`;
  const storage = memoryStorage();
  storage.objects.set(key, await testImage());

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
    .returning();
  const requestId = req!.id;
  const now = new Date();
  // What `ncii.decide` → removed leaves behind.
  await t.db
    .update(schema.nciiRequests)
    .set({ status: "removed", decidedAt: now, decidedById: user.id })
    .where(eq(schema.nciiRequests.id, requestId));
  await t.db.insert(schema.nciiRequestItems).values({
    requestId,
    url: "https://example.test/x",
    subjectType: "upload",
    subjectId: channel.id,
    uploadKey: key,
    removedAt: now,
  });

  const ctx = {
    db: t.db,
    storage,
    mediaBucket: BUCKET,
    now: () => new Date(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    moderation: { envSampleSeconds: 1, testHooks: false },
  } as unknown as WorkerContext;

  const first = await hashRemovedContent(ctx, { requestId });
  expect(first).toMatchObject({ items: 1, deleted: 1 });
  expect(first.hashes).toBeGreaterThan(0);
  expect(storage.objects.has(key)).toBe(false);
  const hashes = await t.db.select().from(schema.localHashList).where(eq(schema.localHashList.sourceId, requestId));
  expect(hashes.length).toBe(first.hashes);
  expect(hashes.every((h) => h.category === "ncii")).toBe(true);
  const [item] = await t.db
    .select()
    .from(schema.nciiRequestItems)
    .where(eq(schema.nciiRequestItems.requestId, requestId));
  expect(item?.hashedAt).not.toBeNull();
  expect(item?.removedAt?.getTime()).toBe(now.getTime());

  // Idempotent: a retry finds nothing left to do.
  expect(await hashRemovedContent(ctx, { requestId })).toEqual({ items: 0, hashes: 0, deleted: 0 });
}, 60_000);
