// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `portability-incoming-cleanup` (batch 8 decision (i)) against a real database: the archive of a
 * failed import goes, and of a preview older than 24 h; a fresh preview, a queued and a running
 * import are never touched; an object no import names goes only once it is older than 24 h; a
 * failed storage delete keeps `archive_key` for the next run.
 */
import { B8_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import type { ObjectInfo, ObjectStorage } from "@commonair/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { job } from "../src/jobs/portability-incoming-cleanup.ts";
import {
  ABANDONED_AFTER_MS,
  cleanIncomingArchives,
  INCOMING_PORTABILITY_PREFIX,
} from "../src/portability/incoming-cleanup.ts";
import { makeUser, quietLogger } from "./fixtures.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 120_000);
afterAll(() => t?.drop());

const NOW = new Date("2026-11-03T04:13:00Z");
const H = 3_600_000;

function memoryStorage(failing: Set<string> = new Set()) {
  const objects = new Map<string, Date>();
  const storage = {
    async delete(_bucket: string, key: string) {
      if (failing.has(key)) throw new Error("storage down");
      objects.delete(key);
    },
    async *list(_bucket: string, prefix: string): AsyncIterable<ObjectInfo> {
      for (const [key, lastModified] of objects)
        if (key.startsWith(prefix)) yield { key, size: 1, etag: "", lastModified };
    },
  } as unknown as ObjectStorage;
  return { storage, objects, failing };
}

const ctx = (storage: ObjectStorage | undefined) =>
  ({ db: t.app.db, now: () => NOW, storage, mediaBucket: "media", logger: quietLogger }) as unknown as WorkerContext;

type Status = "previewed" | "queued" | "running" | "done" | "failed";

async function importRow(
  channel: { id: string; ownerId: string },
  status: Status,
  createdAt: Date,
  objects: Map<string, Date>,
): Promise<{ id: string; key: string }> {
  const id = uuidv7();
  const key = `${INCOMING_PORTABILITY_PREFIX}${channel.id}/${uuidv7()}.zip`;
  objects.set(key, createdAt);
  await t.db.insert(schema.portabilityImports).values({
    id,
    userId: channel.ownerId,
    channelId: channel.id,
    source: "commonair",
    status,
    archiveKey: key,
    createdAt,
    finishedAt: status === "failed" || status === "done" ? createdAt : null,
  });
  return { id, key };
}

const keyOf = async (id: string) =>
  (await t.db.select().from(schema.portabilityImports).where(eq(schema.portabilityImports.id, id)))[0]?.archiveKey;

test("is the portability queue's daily job", () => {
  expect(job.queue).toBe(QUEUES.portability);
  expect(job.name).toBe(B8_JOBS.incomingCleanup);
  expect(job.schedule).toEqual({ pattern: "13 4 * * *" });
});

test("each status, the 24 h boundary, and orphans", async () => {
  const { channel } = await makeUser(t.db);
  const { storage, objects } = memoryStorage();
  const old = new Date(NOW.getTime() - ABANDONED_AFTER_MS - 1);
  const edge = new Date(NOW.getTime() - ABANDONED_AFTER_MS);
  const fresh = new Date(NOW.getTime() - H);

  const failed = await importRow(channel, "failed", fresh, objects);
  const abandoned = await importRow(channel, "previewed", old, objects);
  const onTheEdge = await importRow(channel, "previewed", edge, objects);
  const recent = await importRow(channel, "previewed", fresh, objects);
  const queued = await importRow(channel, "queued", old, objects);
  const running = await importRow(channel, "running", old, objects);
  const done = await importRow(channel, "done", old, objects);
  // Uploads with no import row: an old one is an orphan, a fresh one may still be in flight.
  const orphan = `${INCOMING_PORTABILITY_PREFIX}${channel.id}/${uuidv7()}.zip`;
  const inFlight = `${INCOMING_PORTABILITY_PREFIX}${channel.id}/${uuidv7()}.zip`;
  objects.set(orphan, old);
  objects.set(inFlight, fresh);
  // Outside the prefix: never listed.
  objects.set(`incoming/other/${uuidv7()}.png`, old);

  expect(await cleanIncomingArchives(ctx(storage))).toEqual({ deleted: 3, orphans: 1, failed: 0 });

  for (const gone of [failed, abandoned, done]) {
    expect(objects.has(gone.key), gone.key).toBe(false);
    expect(await keyOf(gone.id)).toBeNull();
  }
  for (const kept of [onTheEdge, recent, queued, running]) {
    expect(objects.has(kept.key)).toBe(true);
    expect(await keyOf(kept.id)).toBe(kept.key);
  }
  expect(objects.has(orphan)).toBe(false);
  expect(objects.has(inFlight)).toBe(true);
  expect(objects.size).toBe(6);

  // A second run finds nothing.
  expect(await cleanIncomingArchives(ctx(storage))).toEqual({ deleted: 0, orphans: 0, failed: 0 });
  // Statuses never change.
  const statuses = await t.db
    .select({ id: schema.portabilityImports.id, status: schema.portabilityImports.status })
    .from(schema.portabilityImports)
    .where(eq(schema.portabilityImports.channelId, channel.id));
  expect(new Map(statuses.map((s) => [s.id, s.status])).get(queued.id)).toBe("queued");
});

test("a failed storage delete keeps archive_key, and the next run retries", async () => {
  const { channel } = await makeUser(t.db);
  const { storage, objects, failing } = memoryStorage();
  const row = await importRow(channel, "failed", new Date(NOW.getTime() - H), objects);
  failing.add(row.key);
  expect(await cleanIncomingArchives(ctx(storage))).toMatchObject({ deleted: 0, failed: 1 });
  expect(await keyOf(row.id)).toBe(row.key);
  expect(objects.has(row.key)).toBe(true);

  failing.clear();
  expect(await cleanIncomingArchives(ctx(storage))).toMatchObject({ deleted: 1, failed: 0 });
  expect(await keyOf(row.id)).toBeNull();
  expect(objects.has(row.key)).toBe(false);
});

test("without object storage the job skips", async () => {
  expect(await cleanIncomingArchives(ctx(undefined))).toEqual({ deleted: 0, orphans: 0, failed: 0, skipped: 1 });
});
