// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hashRemovedContent` after `ncii.decide` → `removed`. The API sets each resolved item's
 * `removed_at` in the decision transaction (the avatar guard trigger depends on it), so the job
 * must not read `removed_at` as "already hashed": that made it skip every item (trust-safety
 * step 7: no hashes on the local NCII list).
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { schema, uuidv7 } from "@commonair/db";
import type { ObjectInfo, ObjectStorage } from "@commonair/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { hashRemovedContent } from "../src/moderation/ncii-hash.ts";
import { makeBroadcast, makeUser } from "./fixtures.ts";

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

// ---------------------------------------------------------------- broadcast items

/** Run ffmpeg on a synthetic lavfi pattern (never real material) in `cwd`. */
async function ffmpeg(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${await new Response(proc.stderr).text()}`);
}

/** A short HLS VOD (playlist + segments) of ffmpeg's geometric test pattern, keyed under `prefix`. */
async function syntheticVod(prefix: string): Promise<Map<string, Uint8Array>> {
  const dir = await mkdtemp(join(tmpdir(), "ncii-vod-"));
  try {
    await ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=10",
        "-t",
        "3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "10",
        "-f",
        "hls",
        "-hls_time",
        "1",
        "-hls_playlist_type",
        "vod",
        "index.m3u8",
      ],
      dir,
    );
    const out = new Map<string, Uint8Array>();
    for (const name of await readdir(dir)) out.set(`${prefix}${name}`, new Uint8Array(await readFile(join(dir, name))));
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A two-second MP4 of ffmpeg's colour-bars pattern. */
async function syntheticClip(): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "ncii-clip-"));
  try {
    await ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "smptebars=size=320x240:rate=10",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "c.mp4",
      ],
      dir,
    );
    return new Uint8Array(await readFile(join(dir, "c.mp4")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function removedRequest(decidedById: string): Promise<string> {
  const [req] = await t.db
    .insert(schema.nciiRequests)
    .values({
      requesterName: "r",
      requesterEmail: "r@example.test",
      relationship: "self",
      contentUrls: ["https://example.test/live"],
      description: "d",
      goodFaith: true,
      signature: "r",
      deadlineAt: new Date(0),
    })
    .returning();
  await t.db
    .update(schema.nciiRequests)
    .set({ status: "removed", decidedAt: new Date(), decidedById })
    .where(eq(schema.nciiRequests.id, req!.id));
  return req!.id;
}

function workerCtx(storage: ObjectStorage): WorkerContext {
  return {
    db: t.db,
    storage,
    mediaBucket: BUCKET,
    now: () => new Date(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    moderation: { envSampleSeconds: 1, testHooks: false },
  } as unknown as WorkerContext;
}

async function broadcastItem(requestId: string, broadcastId: string) {
  await t.db.insert(schema.nciiRequestItems).values({
    requestId,
    url: "https://example.test/live",
    subjectType: "broadcast",
    subjectId: broadcastId,
    removedAt: new Date(),
  });
}

test("a removed broadcast: its VOD and clip are hashed, then their objects deleted, once", async () => {
  const { user, channel } = await makeUser(t.db);
  const b = await makeBroadcast(t.db, channel.id);
  const vodId = uuidv7();
  const clipId = uuidv7();
  // What the API's NCII decision leaves: the broadcast ended, its recordings deleted, objects kept.
  await t.db.insert(schema.vods).values({
    id: vodId,
    broadcastId: b.id,
    channelId: channel.id,
    title: "v",
    storagePrefix: `vods/${vodId}/`,
    status: "deleted",
    removedReason: "ncii",
  });
  await t.db.insert(schema.clips).values({
    id: clipId,
    channelId: channel.id,
    broadcastId: b.id,
    title: "c",
    startOffset: 0,
    durationSeconds: 2,
    status: "deleted",
    removedReason: "ncii",
    storageKey: `clips/${clipId}.mp4`,
    thumbnailKey: `clips/${clipId}.jpg`,
  });
  const storage = memoryStorage();
  for (const [k, v] of await syntheticVod(`vods/${vodId}/`)) storage.objects.set(k, v);
  storage.objects.set(`clips/${clipId}.mp4`, await syntheticClip());
  storage.objects.set(`clips/${clipId}.jpg`, await testImage());
  const unrelated = `vods/${uuidv7()}/index.m3u8`;
  storage.objects.set(unrelated, new Uint8Array([1]));
  const mediaKeys = [...storage.objects.keys()].filter((k) => k !== unrelated);
  expect(mediaKeys.length).toBeGreaterThan(3);

  const requestId = await removedRequest(user.id);
  await broadcastItem(requestId, b.id);

  // Every delete happens after all of the item's hashes are committed.
  const hashesAtDelete: number[] = [];
  const del = storage.delete.bind(storage);
  storage.delete = async (bucket, key) => {
    const rows = await t.db.select().from(schema.localHashList).where(eq(schema.localHashList.sourceId, requestId));
    hashesAtDelete.push(rows.length);
    await del(bucket, key);
  };

  const ctx = workerCtx(storage);
  const first = await hashRemovedContent(ctx, { requestId });
  expect(first.items).toBe(1);
  expect(first.hashes).toBeGreaterThan(0);
  expect(first.deleted).toBe(mediaKeys.length);
  for (const k of mediaKeys) expect(storage.objects.has(k)).toBe(false);
  expect(storage.objects.has(unrelated)).toBe(true);
  expect(hashesAtDelete).toHaveLength(mediaKeys.length);
  expect(hashesAtDelete.every((n) => n === first.hashes)).toBe(true);

  const hashes = await t.db.select().from(schema.localHashList).where(eq(schema.localHashList.sourceId, requestId));
  expect(hashes.length).toBe(first.hashes);
  expect(hashes.every((h) => h.category === "ncii" && h.sourceType === "ncii_request")).toBe(true);
  const [item] = await t.db
    .select()
    .from(schema.nciiRequestItems)
    .where(eq(schema.nciiRequestItems.requestId, requestId));
  expect(item?.hashedAt).not.toBeNull();
  const audits = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, requestId));
  expect(audits).toHaveLength(1);
  expect(audits[0]?.action).toBe("ncii.hash_removed");
  expect(audits[0]?.details).toMatchObject({ subjectType: "broadcast", vods: 1, clips: 1, hashes: first.hashes });

  // Idempotent: a retry finds nothing left to do.
  expect(await hashRemovedContent(ctx, { requestId })).toEqual({ items: 0, hashes: 0, deleted: 0 });
}, 120_000);

test("a removed broadcast without recordings is marked hashed with 0 hashes", async () => {
  const { user, channel } = await makeUser(t.db);
  const b = await makeBroadcast(t.db, channel.id);
  const requestId = await removedRequest(user.id);
  await broadcastItem(requestId, b.id);
  const ctx = workerCtx(memoryStorage());
  expect(await hashRemovedContent(ctx, { requestId })).toEqual({ items: 1, hashes: 0, deleted: 0 });
  const [item] = await t.db
    .select()
    .from(schema.nciiRequestItems)
    .where(eq(schema.nciiRequestItems.requestId, requestId));
  expect(item?.hashedAt).not.toBeNull();
  const audits = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, requestId));
  expect(audits).toHaveLength(1);
  expect(audits[0]?.details).toMatchObject({
    subjectType: "broadcast",
    hashes: 0,
    objectsDeleted: 0,
    vods: 0,
    clips: 0,
  });
  expect(await hashRemovedContent(ctx, { requestId })).toEqual({ items: 0, hashes: 0, deleted: 0 });
});
