// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hideContent`: hiding a VOD hides every clip of the same content, including clips cut from the
 * live buffer (they have no `vod_id`), so an NCII auto-hide or T0 on a VOD leaves nothing playable.
 */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { schema, uuidv7 } from "@commonair/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { hideContent } from "../src/moderation/records.ts";
import { makeBroadcast, makeUser } from "./fixtures.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(() => t?.drop());

async function clip(channelId: string, broadcastId: string, vodId: string | null) {
  const id = uuidv7();
  await t.db.insert(schema.clips).values({
    id,
    channelId,
    broadcastId,
    vodId,
    title: "c",
    startOffset: 0,
    durationSeconds: 5,
    status: "ready",
  });
  return id;
}

test("hiding a VOD hides its clips and the live-buffer clips of its broadcast, nothing else", async () => {
  const { channel } = await makeUser(t.db);
  const b = await makeBroadcast(t.db, channel.id, new Date(Date.now() - 3_600_000));
  const other = await makeBroadcast(t.db, channel.id, new Date(Date.now() - 7_200_000));
  const vodId = uuidv7();
  await t.db
    .insert(schema.vods)
    .values({
      id: vodId,
      broadcastId: b.id,
      channelId: channel.id,
      title: "v",
      storagePrefix: `vods/${vodId}/`,
      status: "ready",
    });
  const fromVod = await clip(channel.id, b.id, vodId);
  const fromLive = await clip(channel.id, b.id, null);
  const unrelated = await clip(channel.id, other.id, null);

  const hidden = await t.db.transaction((tx) => hideContent(tx, { vodIds: [vodId] }, "ncii_deadline"));
  expect(hidden.vodIds).toEqual([vodId]);
  expect(hidden.clipIds.sort()).toEqual([fromVod, fromLive].sort());

  const rows = await t.db
    .select({ id: schema.clips.id, status: schema.clips.status, reason: schema.clips.removedReason })
    .from(schema.clips)
    .where(inArray(schema.clips.id, [fromVod, fromLive, unrelated]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(fromLive)).toMatchObject({ status: "deleted", reason: "ncii_deadline" });
  expect(byId.get(fromVod)).toMatchObject({ status: "deleted", reason: "ncii_deadline" });
  expect(byId.get(unrelated)?.status).toBe("ready");
  const [v] = await t.db.select().from(schema.vods).where(eq(schema.vods.id, vodId));
  expect(v?.status).toBe("deleted");
});
