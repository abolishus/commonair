// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-content: the `vod_ready` inbox row `finalizeVod` writes for the channel owner when a VOD turns
 * ready, against real Postgres as the application role. Object storage is an in-memory double
 * (the recording is one segment without an init section, so no ffmpeg runs; moderation passes):
 * what is under test is the transaction, not the media.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { VodReadyNotificationPayload } from "@commonair/contracts/notify";
import { vodPrefix } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import type { ObjectInfo, ObjectStorage } from "@commonair/storage";
import { finalizeVod } from "../src/vod/finalize.ts";
import { renderPlaylist } from "../src/vod/playlist.ts";
import { payloadTitle, vodReadyKey, vodReadyNoticeTx } from "../src/vod/ready-notice.ts";
import { VOD_PLAYLIST } from "../src/vod/recorder.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const BUCKET = "media";
const logger = createLogger({ service: "media-vod-ready-int", level: "fatal" });
const workDir = mkdtempSync(join(tmpdir(), "media-vod-ready-"));

/** Just enough of `ObjectStorage` for a private (unmoved) finalize. */
function memoryStorage(): ObjectStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const info = (key: string, bytes: Uint8Array): ObjectInfo => ({
    key,
    size: bytes.byteLength,
    etag: String(bytes.byteLength),
    lastModified: new Date(),
  });
  const nope = () => Promise.reject(new Error("not used here"));
  return {
    objects,
    async put(_b, key, body) {
      objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
    },
    async get(_b, key) {
      const v = objects.get(key);
      return v ? new Response(v.slice()) : null;
    },
    async head(_b, key) {
      const v = objects.get(key);
      return v ? info(key, v) : null;
    },
    async delete(_b, key) {
      objects.delete(key);
    },
    copy: nope,
    async deletePrefix(_b, prefix) {
      let n = 0;
      for (const k of objects.keys())
        if (k.startsWith(prefix)) {
          objects.delete(k);
          n += 1;
        }
      return n;
    },
    async *list(_b, prefix) {
      for (const [k, v] of objects) if (k.startsWith(prefix)) yield info(k, v);
    },
    presignPut: nope,
    presignGet: nope,
    async ensureBucket() {},
  };
}

const passingModeration = {
  broadcastTainted: async () => false,
  sampleSeconds: async () => 2,
  scanVideoFile: async () => ({ hit: null, frames: 1 }),
  prepublishFrames: () => {},
  checkImage: async () => ({ frame: null, pdq: null, match: null }),
} as never;

let tdb: TestDatabase;
let ownerId: string;
let channelId: string;
const slug = `vr${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const [u] = await tdb.db
    .insert(schema.users)
    .values({ name: slug, email: `${slug}@example.test`, username: slug })
    .returning({ id: schema.users.id });
  if (!u) throw new Error("no user");
  ownerId = u.id;
  const [c] = await tdb.db
    .insert(schema.channels)
    .values({ ownerId, slug, displayName: slug })
    .returning({ id: schema.channels.id });
  if (!c) throw new Error("no channel");
  channelId = c.id;
});
afterAll(async () => {
  await tdb?.drop();
});

/** A recorded (not yet finalized) private VOD with one segment uploaded under `recordings/`. */
async function recorded(
  storage: ReturnType<typeof memoryStorage>,
  opts: { kind?: "live" | "rehearsal"; title?: string } = {},
) {
  const vodId = uuidv7();
  const broadcastId = uuidv7();
  const at = new Date(Date.now() - 120_000);
  await tdb.db.insert(schema.broadcasts).values({
    id: broadcastId,
    channelId,
    kind: opts.kind ?? "live",
    ingestProtocol: "rtmp",
    path: `live/${slug}`,
    startedAt: at,
    endedAt: new Date(at.getTime() + 60_000),
  });
  const prefix = vodPrefix(vodId, "private");
  await tdb.db.insert(schema.vods).values({
    id: vodId,
    broadcastId,
    channelId,
    title: opts.title ?? "Friday build",
    status: "recording",
    visibility: "private",
    storagePrefix: prefix,
  });
  await storage.put(BUCKET, `${prefix}seg-0.m4s`, new Uint8Array([1, 2, 3, 4]));
  await storage.put(
    BUCKET,
    prefix + VOD_PLAYLIST,
    renderPlaylist([{ uri: "seg-0.m4s", durationSeconds: 4, startedAt: at, map: null }], { ended: false }),
  );
  return { vodId, broadcastId };
}

const deps = (storage: ObjectStorage) => ({
  db: tdb.app.db,
  storage,
  bucket: BUCKET,
  moderation: passingModeration,
  ffmpeg: "ffmpeg",
  imageFormat: "webp" as const,
  workDir,
  logger,
});

const noticesOf = (vodId: string) =>
  tdb.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.type, "vod_ready"), eq(schema.notifications.dedupeKey, vodReadyKey(vodId))));

describe("vod_ready notice", () => {
  test("a broadcast's VOD turning ready leaves one in-app row for the owner, with the contract payload", async () => {
    const storage = memoryStorage();
    const { vodId, broadcastId } = await recorded(storage);
    expect(await finalizeVod(deps(storage), vodId)).toBe("ready");
    const rows = await noticesOf(vodId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ownerId);
    expect(rows[0]?.readAt).toBeNull();
    expect(VodReadyNotificationPayload.parse(rows[0]?.payload)).toEqual({
      vodId,
      broadcastId,
      slug,
      title: "Friday build",
    });
    // A retried job finds the VOD finished and writes nothing.
    expect(await finalizeVod(deps(storage), vodId)).toBe("skipped");
    expect(await noticesOf(vodId)).toHaveLength(1);
  });

  test("two runs racing: only the one that makes the transition writes the row", async () => {
    const storage = memoryStorage();
    const { vodId } = await recorded(storage);
    const results = await Promise.all([finalizeVod(deps(storage), vodId), finalizeVod(deps(storage), vodId)]);
    expect(results.filter((r) => r === "ready")).toHaveLength(1);
    expect(await noticesOf(vodId)).toHaveLength(1);
  });

  test("the helper itself is idempotent on the dedupe key", async () => {
    const storage = memoryStorage();
    const { vodId } = await recorded(storage);
    expect(await finalizeVod(deps(storage), vodId)).toBe("ready");
    expect(await tdb.app.db.transaction((tx) => vodReadyNoticeTx(tx, vodId, new Date()))).toBe(false);
    expect(await noticesOf(vodId)).toHaveLength(1);
  });

  test("a rehearsal's VOD gets none", async () => {
    const storage = memoryStorage();
    const { vodId } = await recorded(storage, { kind: "rehearsal" });
    expect(await finalizeVod(deps(storage), vodId)).toBe("ready");
    expect(await noticesOf(vodId)).toEqual([]);
  });

  test("a VOD that fails (no segments) gets none", async () => {
    const storage = memoryStorage();
    const { vodId } = await recorded(storage);
    await storage.deletePrefix(BUCKET, vodPrefix(vodId, "private"));
    expect(await finalizeVod(deps(storage), vodId)).toBe("failed");
    expect(await noticesOf(vodId)).toEqual([]);
  });

  test("a long title is cut to the payload's limit", async () => {
    const storage = memoryStorage();
    const { vodId } = await recorded(storage, { title: `${"a".repeat(139)}\u{1F600}tail` });
    expect(await finalizeVod(deps(storage), vodId)).toBe("ready");
    const [row] = await noticesOf(vodId);
    expect(VodReadyNotificationPayload.parse(row?.payload).title).toBe("a".repeat(139));
  });
});

describe("payloadTitle", () => {
  test("keeps short titles, never splits a surrogate pair", () => {
    expect(payloadTitle("hi")).toBe("hi");
    expect(payloadTitle("")).toBe("");
    expect(payloadTitle("b".repeat(140))).toHaveLength(140);
    expect(payloadTitle("b".repeat(141))).toHaveLength(140);
    expect(payloadTitle(`${"c".repeat(138)}\u{1F600}x`)).toBe(`${"c".repeat(138)}\u{1F600}`);
  });
});
