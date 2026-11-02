// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-media's direct-insert writers against a migrated database, as the app role: the backdated
 * broadcasts, stream hours, health and egress samples land and satisfy the constraints and
 * triggers, and `linkChat` sets `broadcast_id` on exactly the chat lines inside each broadcast.
 * The fixture (two streamers and a viewer with chat) is written here, not with seed-social's code.
 * The recordings (vods, clips, rooms, rollups, relays, captions) are exercised by `seed full` live.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { API_TABLES } from "../../src/seed/media.ts";
import { type HistoryPlan, DAY_MS, MINUTE_MS, historyCounts, planHistory } from "../../src/seed/media/plan.ts";
import { linkChat, writeHistory } from "../../src/seed/media/write.ts";
import { createRng } from "../../src/seed/prng.ts";
import type { SeededChannel } from "../../src/seed/types.ts";

const NOW = new Date();
let t: TestDatabase;
let plan: HistoryPlan;
let rows: Record<string, number>;
let ids: string[];
let linked = 0;
/** Lines planted inside windows (to link) and outside them (to leave alone). */
const inside: string[] = [];
const outside: string[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  const { db } = t.app;
  const created = new Date(NOW.getTime() - 60 * DAY_MS);
  const people = ["streamer1", "s0001", "v00001"].map((h) => ({
    id: uuidv7(created.getTime()),
    handle: h,
  }));
  await db.insert(schema.users).values(
    people.map((p) => ({
      id: p.id,
      name: p.handle,
      email: `demo_${p.handle}@demo-seed.invalid`,
      emailVerified: true,
      username: `demo_${p.handle}`,
      createdAt: created,
    })),
  );
  const channels: SeededChannel[] = people.slice(0, 2).map((p) => ({
    id: uuidv7(created.getTime() + DAY_MS),
    ownerId: p.id,
    ownerHandle: p.handle,
    slug: `demo_${p.handle}`,
  }));
  await db.insert(schema.channels).values(
    channels.map((c) => ({
      id: c.id,
      ownerId: c.ownerId,
      slug: c.slug,
      displayName: c.ownerHandle,
      createdAt: created,
    })),
  );
  const windows = channels.flatMap((c, ci) =>
    [3, 9, 20, 40].map((d) => {
      const end = NOW.getTime() - d * DAY_MS - ci * 90 * MINUTE_MS;
      return { channelId: c.id, start: new Date(end - 150 * MINUTE_MS), end: new Date(end) };
    }),
  );
  const viewer = people[2]?.id ?? "";
  const chat = windows.flatMap((w, i) => {
    const inId = uuidv7(w.start.getTime() + 10 * MINUTE_MS);
    const outId = uuidv7(w.end.getTime() + 30 * MINUTE_MS);
    inside.push(inId);
    outside.push(outId);
    return [
      {
        id: inId,
        channelId: w.channelId,
        userId: viewer,
        body: `line ${i}`,
        createdAt: new Date(w.start.getTime() + 10 * MINUTE_MS),
      },
      {
        id: outId,
        channelId: w.channelId,
        userId: viewer,
        body: `after ${i}`,
        createdAt: new Date(w.end.getTime() + 30 * MINUTE_MS),
      },
    ];
  });
  await db.insert(schema.chatMessages).values(chat);
  const categories = [{ id: uuidv7(), slug: "art", name: "Art" }];
  await t.db.insert(schema.categories).values(categories);
  plan = planHistory(
    createRng(5).fork("history"),
    { channels, windows, categoryIds: categories.map((c) => c.id) },
    NOW,
  );
  const written = await writeHistory(t.app, plan);
  rows = written.rows;
  ids = written.broadcastIds;
  linked = await linkChat(t.app, plan, ids);
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

const count = async (table: string) =>
  Number((await t.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`))[0]?.n ?? 0);

describe("writeHistory", () => {
  test("every planned row lands, and the reported counts are the table counts", async () => {
    const want = historyCounts(plan);
    expect(want.broadcasts).toBe(8);
    expect(want.broadcast_health_samples).toBeGreaterThan(0);
    expect(want.egress_samples).toBeGreaterThan(0);
    for (const [table, n] of Object.entries(want)) {
      expect(await count(table), table).toBe(n);
      expect(rows[table], table).toBe(n);
    }
  });

  test("broadcasts are ended live broadcasts on their channels' paths; none is open", async () => {
    const got = await t.sql<{ kind: string; open: number; paths: number }[]>`
      select min(kind::text) as kind,
             count(*) filter (where ended_at is null)::int as open,
             count(*) filter (where b.path <> 'live/' || c.slug)::int as paths
        from broadcasts b join channels c on c.id = b.channel_id`;
    expect(got[0]).toEqual({ kind: "live", open: 0, paths: 0 });
    const live = await t.sql<
      { n: number }[]
    >`select count(*)::int as n from channels where live_broadcast_id is not null`;
    expect(live[0]?.n).toBe(0);
  });

  test("stream hours satisfy the trigger and stay inside their broadcasts", async () => {
    const bad = await t.sql<{ n: number }[]>`
      select count(*)::int as n from stream_hours s join broadcasts b on b.id = s.broadcast_id
       where s.channel_id <> b.channel_id
          or s.hour_start + interval '1 hour' <= b.started_at
          or s.hour_start >= b.ended_at`;
    expect(bad[0]?.n).toBe(0);
  });

  test("health samples and egress samples reference their broadcasts' windows", async () => {
    const bad = await t.sql<{ n: number }[]>`
      select count(*)::int as n from broadcast_health_samples h join broadcasts b on b.id = h.broadcast_id
       where h.at < b.started_at or h.at >= b.ended_at`;
    expect(bad[0]?.n).toBe(0);
    const egress = await t.sql<{ n: number }[]>`
      select count(*)::int as n from egress_samples where bucket_start < now() - interval '31 days'`;
    expect(egress[0]?.n).toBe(0);
  });

  test("no personal data: titles carry no email or address", async () => {
    const titles = await t.sql<{ title: string }[]>`select title from broadcasts`;
    for (const r of titles) expect(r.title).not.toMatch(/@|https?:/);
  });
});

describe("linkChat", () => {
  test("links exactly the lines inside each broadcast", async () => {
    expect(linked).toBe(inside.length);
    const rowsIn = await t.sql<{ id: string; broadcast_id: string | null }[]>`
      select id, broadcast_id from chat_messages where id = any(${inside}::uuid[])`;
    expect(rowsIn.every((r) => r.broadcast_id !== null && ids.includes(r.broadcast_id))).toBe(true);
    const rowsOut = await t.sql<{ n: number }[]>`
      select count(*)::int as n from chat_messages where id = any(${outside}::uuid[]) and broadcast_id is not null`;
    expect(rowsOut[0]?.n).toBe(0);
  });

  test("a second pass links nothing new", async () => {
    expect(await linkChat(t.app, plan, ids)).toBe(0);
  });
});

describe("row counts", () => {
  test("the app role can count every table the recordings write", async () => {
    for (const table of API_TABLES) {
      const r = await t.app.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
      expect(Number(r[0]?.n ?? -1), table).toBeGreaterThanOrEqual(0);
    }
  });
});
