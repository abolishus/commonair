// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `replay-panel` step's database helpers on a real database, on the same `createDb` client the
 * step uses (whose raw `sql` neither takes nor returns Dates): marker lines written through Drizzle
 * read back at the instants asked for (a catching-up line has no media time), the VOD's broadcast
 * span reads as Dates, the aged-out VOD lands `daysAgo` back with its rows, and `existingLines`
 * binds its id array.
 */
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { broadcastSpan, existingLines, seedAgedOutVod, seedLines } from "../../src/w2/replay.ts";
import { toDate } from "../../src/w2/sql-time.ts";

let t: TestDatabase;
let h: DbHandle;
const owner = uuidv7();
const channelId = uuidv7();
const broadcastId = uuidv7();
const vodId = uuidv7();
const startedAt = new Date("2026-10-31T12:00:00.250Z");
const endedAt = new Date(startedAt.getTime() + 40_000);

beforeAll(async () => {
  t = await createTestDatabase();
  h = createDb({ url: t.url, max: 1 });
  await h.db
    .insert(schema.users)
    .values({ id: owner, name: "w2 replay", email: "w2replay@example.test", username: "w2replay" });
  await h.db
    .insert(schema.channels)
    .values({ id: channelId, ownerId: owner, slug: "w2replay", displayName: "w2replay" });
  await h.db.insert(schema.broadcasts).values({
    id: broadcastId,
    channelId,
    ingestProtocol: "rtmp",
    path: `live/${uuidv7()}`,
    startedAt,
    endedAt,
  });
  await h.db.insert(schema.vods).values({
    id: vodId,
    channelId,
    broadcastId,
    title: "w2 replay",
    status: "ready",
    visibility: "public",
    storagePrefix: `vods/${vodId}/`,
    durationSeconds: 40,
  });
});

afterAll(async () => {
  await h?.close();
  await t?.drop();
});

describe("replay-panel database helpers", () => {
  test("broadcastSpan reads the VOD's broadcast as Dates", async () => {
    const span = await broadcastSpan(h.sql, vodId);
    expect(span?.broadcastId).toBe(broadcastId);
    expect(span?.startedAt.toISOString()).toBe(startedAt.toISOString());
    expect(span?.endedAt?.toISOString()).toBe(endedAt.toISOString());
    expect(await broadcastSpan(h.sql, uuidv7())).toBeNull();
  });

  test("seedLines writes media time, or none for a catching-up line", async () => {
    const at1 = new Date(startedAt.getTime() + 3_000);
    const at2 = new Date(startedAt.getTime() + 9_500);
    const ids = await seedLines(h.db, [
      { channelId, broadcastId, userId: owner, body: "one", at: at1, catchingUp: false },
      { channelId, broadcastId, userId: owner, body: "two", at: at2, catchingUp: true },
    ]);
    expect(ids).toHaveLength(2);
    const rows = await h.sql<{ id: string; created_at: string; media_ts: string | null }[]>`
      select id, created_at, media_ts from chat_messages where id = any(${ids}::uuid[]) order by created_at`;
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(toDate(rows[0]?.created_at)?.toISOString()).toBe(at1.toISOString());
    expect(toDate(rows[0]?.media_ts)?.toISOString()).toBe(at1.toISOString());
    expect(toDate(rows[1]?.created_at)?.toISOString()).toBe(at2.toISOString());
    expect(rows[1]?.media_ts).toBeNull();
    expect(await seedLines(h.db, [])).toEqual([]);
  });

  test("seedAgedOutVod backdates the broadcast and its lines; existingLines binds the ids", async () => {
    const now = new Date("2026-11-01T00:00:00.000Z");
    const aged = await seedAgedOutVod(h.db, {
      channelId,
      channel: "w2replay",
      userId: owner,
      daysAgo: 65,
      lines: 3,
      now,
    });
    const span = await broadcastSpan(h.sql, aged.vodId);
    expect(span?.broadcastId).toBe(aged.broadcastId);
    expect(span?.startedAt.toISOString()).toBe(new Date(now.getTime() - 65 * 86_400_000).toISOString());
    const [vod] = await h.sql<{ status: string; visibility: string; expires_at: string }[]>`
      select status, visibility, expires_at from vods where id = ${aged.vodId}`;
    expect(vod?.status).toBe("ready");
    expect(vod?.visibility).toBe("public");
    expect(toDate(vod?.expires_at)?.getTime()).toBeGreaterThan(now.getTime());
    expect((await existingLines(h.sql, aged.lineIds)).sort()).toEqual([...aged.lineIds].sort());
    const ages = await h.sql<{ created_at: string }[]>`
      select created_at from chat_messages where id = any(${aged.lineIds}::uuid[])`;
    for (const a of ages)
      expect(now.getTime() - (toDate(a.created_at)?.getTime() ?? 0)).toBeGreaterThan(60 * 86_400_000);
    await h.sql`delete from chat_messages where id = ${aged.lineIds[0] ?? ""}`;
    expect(await existingLines(h.sql, aged.lineIds)).toHaveLength(2);
    expect(await existingLines(h.sql, [])).toEqual([]);
  });
});
