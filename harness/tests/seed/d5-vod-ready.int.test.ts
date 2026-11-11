// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d5-content: seed-media's check that every recorded VOD's owner has exactly one `vod_ready` row. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { vodNoticeProblems, vodReadyNotices } from "../../src/seed/media/vod-ready.ts";

let t: TestDatabase;
let ownerId: string;
let otherId: string;
let channelId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  const users = await t.db
    .insert(schema.users)
    .values(
      ["vrowner", "vrother"].map((n) => ({
        name: n,
        email: `${n}@example.test`,
        username: `${n}${uuidv7().slice(-6)}`,
      })),
    )
    .returning({ id: schema.users.id, username: schema.users.username });
  ownerId = users[0]?.id ?? "";
  otherId = users[1]?.id ?? "";
  const [c] = await t.db
    .insert(schema.channels)
    .values({ ownerId, slug: users[0]?.username ?? "", displayName: "vr" })
    .returning({ id: schema.channels.id });
  channelId = c?.id ?? "";
}, 60_000);
afterAll(async () => {
  await t?.drop();
});

async function readyVod(): Promise<string> {
  const id = uuidv7();
  const bid = uuidv7();
  await t.db.insert(schema.broadcasts).values({
    id: bid,
    channelId,
    ingestProtocol: "rtmp",
    path: `live/${bid}`,
    startedAt: new Date(Date.now() - 60_000),
    endedAt: new Date(),
  });
  await t.db
    .insert(schema.vods)
    .values({ id, channelId, broadcastId: bid, title: "v", storagePrefix: `vods/${id}/`, status: "ready" });
  return id;
}

const notice = (userId: string, vodId: string, dedupe = true) =>
  t.db.insert(schema.notifications).values({
    userId,
    type: "vod_ready",
    payload: { vodId, broadcastId: uuidv7(), slug: "x", title: "v" },
    dedupeKey: dedupe ? `vod-ready-${vodId}` : null,
  });

describe("vodReadyNotices", () => {
  test("counts only the owner's vod_ready rows naming each VOD", async () => {
    const [one, none, twice, elsewhere] = [await readyVod(), await readyVod(), await readyVod(), await readyVod()];
    await notice(ownerId, one);
    await notice(ownerId, twice);
    await notice(ownerId, twice, false);
    // Someone else's row names it: not the owner's.
    await notice(otherId, elsewhere);
    const rows = await vodReadyNotices(t.app, [one, none, twice, elsewhere]);
    expect(rows).toEqual([
      { vodId: one, notices: 1 },
      { vodId: none, notices: 0 },
      { vodId: twice, notices: 2 },
      { vodId: elsewhere, notices: 0 },
    ]);
    expect(vodNoticeProblems(rows)).toEqual([
      `VOD ${none} is ready but its owner has no vod_ready notification`,
      `VOD ${twice} has 2 vod_ready notifications (want 1)`,
      `VOD ${elsewhere} is ready but its owner has no vod_ready notification`,
    ]);
    expect(await vodReadyNotices(t.app, [])).toEqual([]);
    expect(vodNoticeProblems([{ vodId: one, notices: 1 }])).toEqual([]);
  });
});
