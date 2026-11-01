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
import { endLiveOrRehearsal, hideContent } from "../src/moderation/records.ts";
import { suspendForT0 } from "../src/moderation/t0.ts";
import { makeBroadcast, makeUser } from "./fixtures.ts";
import { mediaStates, suspensions } from "./media-state-helpers.ts";

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
  await t.db.insert(schema.vods).values({
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

  const hidden = await t.db.transaction((tx) =>
    hideContent(tx, { vodIds: [vodId] }, "ncii_deadline", "ncii", new Date()),
  );
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
  // Decision (z): one event per row that stopped being public, with the caller's reason.
  expect(await mediaStates(t.db, "media.vod.state", vodId)).toEqual([[false, "ncii"]]);
  expect(await mediaStates(t.db, "media.clip.state", fromVod)).toEqual([[false, "ncii"]]);
  expect(await mediaStates(t.db, "media.clip.state", fromLive)).toEqual([[false, "ncii"]]);
  expect(await mediaStates(t.db, "media.clip.state", unrelated)).toEqual([]);
  // Hiding again changes nothing and writes nothing.
  await t.db.transaction((tx) => hideContent(tx, { vodIds: [vodId] }, "t0_hash_match", "t0", new Date()));
  expect(await mediaStates(t.db, "media.vod.state", vodId)).toEqual([[false, "ncii"]]);
});

test("hiding a VOD still recording writes public:false, so relays drop its DVR (decision (x))", async () => {
  const { channel } = await makeUser(t.db);
  const b = await makeBroadcast(t.db, channel.id);
  const vodId = uuidv7();
  await t.db.insert(schema.vods).values({
    id: vodId,
    broadcastId: b.id,
    channelId: channel.id,
    title: "v",
    storagePrefix: `recordings/${vodId}/`,
    status: "recording",
  });
  await t.db.transaction((tx) => hideContent(tx, { vodIds: [vodId] }, "ncii_deadline", "ncii", new Date()));
  expect(await mediaStates(t.db, "media.vod.state", vodId)).toEqual([[false, "ncii"]]);
});

test("a T0 broadcast hide writes t0 events; suspendForT0 writes channel.suspension once", async () => {
  const { user, channel } = await makeUser(t.db);
  const b = await makeBroadcast(t.db, channel.id, new Date(Date.now() - 3_600_000));
  const live = await clip(channel.id, b.id, null);
  await t.db.transaction((tx) => hideContent(tx, { broadcastId: b.id }, "t0_hash_match", "t0", new Date()));
  expect(await mediaStates(t.db, "media.clip.state", live)).toEqual([[false, "t0"]]);
  await t.db.transaction((tx) => suspendForT0(tx, user.id, channel.id, new Date()));
  expect(await suspensions(t.db, channel.id)).toEqual([true]);
  // The account's channel is found without a channel id, and is already suspended.
  await t.db.transaction((tx) => suspendForT0(tx, user.id, null, new Date()));
  expect(await suspensions(t.db, channel.id)).toEqual([true]);
});

test("endLiveOrRehearsal ends the live broadcast, else the open rehearsal, quietly", async () => {
  const { channel } = await makeUser(t.db);
  const [r] = await t.db
    .insert(schema.broadcasts)
    .values({
      id: uuidv7(),
      channelId: channel.id,
      ingestProtocol: "rtmp",
      path: `live/${channel.slug}`,
      kind: "rehearsal",
    })
    .returning();
  const ended = await t.db.transaction((tx) => endLiveOrRehearsal(tx, channel, new Date()));
  expect(ended?.broadcastId).toBe(r!.id);
  const [after] = await t.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, r!.id));
  expect(after?.endedAt).not.toBeNull();
  const offline = await t.db.select().from(schema.events).where(eq(schema.events.channelId, channel.id));
  expect(offline.filter((e) => e.type === "stream.offline")).toEqual([]);
  // Nothing open any more.
  expect(await t.db.transaction((tx) => endLiveOrRehearsal(tx, channel, new Date()))).toBeNull();
  // A live broadcast comes first.
  const live = await makeBroadcast(t.db, channel.id);
  await t.db.update(schema.channels).set({ liveBroadcastId: live.id }).where(eq(schema.channels.id, channel.id));
  const [c] = await t.db.select().from(schema.channels).where(eq(schema.channels.id, channel.id));
  expect((await t.db.transaction((tx) => endLiveOrRehearsal(tx, c!, new Date())))?.broadcastId).toBe(live.id);
});
