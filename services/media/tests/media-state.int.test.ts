// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decision (z) in media: `withMediaState` around the `ready` transitions of a VOD and a clip writes
 * one public event for a row that becomes public, and nothing for one that stays private (a
 * rehearsal or subscriber VOD, a clip of one). The end-to-end checks are in `media.int.test.ts`.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { withMediaState } from "../src/media-state.ts";
import { mediaStates } from "./media-state-helpers.ts";

let tdb: TestDatabase;
let db: Database;
beforeAll(async () => {
  tdb = await createTestDatabase();
  db = tdb.app.db;
}, 60_000);
afterAll(() => tdb?.drop());

async function fixture(visibility: "public" | "private" | "subscribers") {
  const name = `ms${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const [u] = await db
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning();
  const [c] = await db.insert(schema.channels).values({ ownerId: u!.id, slug: name, displayName: name }).returning();
  const [b] = await db
    .insert(schema.broadcasts)
    .values({ channelId: c!.id, ingestProtocol: "rtmp", path: `live/${name}` })
    .returning();
  const vodId = uuidv7();
  await db.insert(schema.vods).values({
    id: vodId,
    channelId: c!.id,
    broadcastId: b!.id,
    title: "v",
    storagePrefix: `recordings/${vodId}/`,
    status: "processing",
    visibility,
  });
  const clipId = uuidv7();
  await db.insert(schema.clips).values({
    id: clipId,
    channelId: c!.id,
    broadcastId: b!.id,
    vodId,
    title: "c",
    startOffset: 0,
    durationSeconds: 5,
    status: "processing",
  });
  return { vodId, clipId };
}

const ready = (f: { vodId: string; clipId: string }) =>
  db.transaction(async (tx) => {
    await withMediaState(tx, { vods: eq(schema.vods.id, f.vodId) }, "ready", new Date(), () =>
      tx
        .update(schema.vods)
        .set({ status: "ready" })
        .where(and(eq(schema.vods.id, f.vodId), eq(schema.vods.status, "processing"))),
    );
    await withMediaState(tx, { clips: eq(schema.clips.id, f.clipId) }, "ready", new Date(), () =>
      tx
        .update(schema.clips)
        .set({ status: "ready" })
        .where(and(eq(schema.clips.id, f.clipId), eq(schema.clips.status, "processing"))),
    );
  });

test("a public VOD and its clip become public once: one event each", async () => {
  const f = await fixture("public");
  await ready(f);
  await ready(f);
  expect(await mediaStates(db, "media.vod.state", f.vodId)).toEqual([[true, "ready"]]);
  expect(await mediaStates(db, "media.clip.state", f.clipId)).toEqual([[true, "ready"]]);
});

test("a private or subscriber VOD and its clip stay non-public: no event", async () => {
  for (const visibility of ["private", "subscribers"] as const) {
    const f = await fixture(visibility);
    await ready(f);
    expect(await mediaStates(db, "media.vod.state", f.vodId)).toEqual([]);
    expect(await mediaStates(db, "media.clip.state", f.clipId)).toEqual([]);
  }
});

test("a failed write rolls the events back with it", async () => {
  const f = await fixture("public");
  await expect(
    db.transaction((tx) =>
      withMediaState(tx, { vods: eq(schema.vods.id, f.vodId) }, "ready", new Date(), async () => {
        await tx.update(schema.vods).set({ status: "ready" }).where(eq(schema.vods.id, f.vodId));
        throw new Error("boom");
      }),
    ),
  ).rejects.toThrow("boom");
  expect(await mediaStates(db, "media.vod.state", f.vodId)).toEqual([]);
});
