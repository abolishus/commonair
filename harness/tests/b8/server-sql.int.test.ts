// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-server's direct inserts (`harness/src/b8/server-sql.ts`) against a migrated database on the
 * owner connection, as the harness writes them on the stack: the rows land with minted ids (no
 * table has a database default for `id`) and the 0046 giveaway triggers accept the sequence.
 */
import { newSalt, newSeed } from "@commonair/draw";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { insertDrawnGiveaway, insertPreviewedImport } from "../../src/b8/server-sql.ts";

let t: TestDatabase;
const ids = { streamer: uuidv7(), me: uuidv7(), other: uuidv7(), channel: uuidv7() };

beforeAll(async () => {
  t = await createTestDatabase();
  for (const [handle, id] of [
    ["b8sqls", ids.streamer],
    ["b8sqlme", ids.me],
    ["b8sqlot", ids.other],
  ] as const) {
    await t.db.insert(schema.users).values({
      id,
      name: handle,
      email: `${handle}@harness.invalid`,
      emailVerified: true,
      username: handle,
      displayUsername: handle,
    });
  }
  await t.db.insert(schema.channels).values({
    id: ids.channel,
    ownerId: ids.streamer,
    slug: "b8sqls",
    displayName: "b8sqls",
  });
});

afterAll(async () => {
  await t?.drop();
});

describe("insertPreviewedImport", () => {
  test("writes previewed imports with minted ids and the given age", async () => {
    const old = new Date(Date.now() - 25 * 3_600_000);
    const [a, b] = await Promise.all([
      insertPreviewedImport(t.sql, {
        userId: ids.streamer,
        channelId: ids.channel,
        archiveKey: "incoming/a",
        createdAt: old,
      }),
      insertPreviewedImport(t.sql, {
        userId: ids.streamer,
        channelId: ids.channel,
        archiveKey: "incoming/b",
        createdAt: new Date(),
      }),
    ]);
    expect(a).not.toBe(b);
    const rows = await t.sql<{ id: string; status: string; archive_key: string; created_at: string }[]>`
      select id::text as id, status::text as status, archive_key, created_at::text as created_at
        from portability_imports order by created_at`;
    expect(rows.map((r) => [r.id, r.status, r.archive_key])).toEqual([
      [a, "previewed", "incoming/a"],
      [b, "previewed", "incoming/b"],
    ]);
    expect(Math.abs(new Date(rows[0]?.created_at ?? 0).getTime() - old.getTime())).toBeLessThan(1_000);
  });
});

describe("insertDrawnGiveaway", () => {
  test("a drawn giveaway with both entries and the caller as the winner", async () => {
    const seed = newSeed();
    const id = await insertDrawnGiveaway(t.sql, {
      channelId: ids.channel,
      title: "Harness giveaway",
      seed,
      salt: newSalt(),
      entries: [
        { userId: ids.me, pseudonym: "pmine" },
        { userId: ids.other, pseudonym: "ptheirs" },
      ],
    });
    const [g] = await t.sql<{ status: string; seed: string | null }[]>`
      select status::text as status, seed from giveaways where id = ${id}::uuid`;
    expect(g).toEqual({ status: "drawn", seed });
    const entries = await t.sql<{ user_id: string }[]>`
      select user_id::text as user_id from giveaway_entries where giveaway_id = ${id}::uuid order by pseudonym`;
    expect(entries.map((e) => e.user_id)).toEqual([ids.me, ids.other]);
    const winners = await t.sql<{ user_id: string; rank: number }[]>`
      select user_id::text as user_id, rank from giveaway_winners where giveaway_id = ${id}::uuid`;
    expect(winners).toEqual([{ user_id: ids.me, rank: 1 }]);
  });

  test("refuses an empty entry list", async () => {
    await expect(
      insertDrawnGiveaway(t.sql, { channelId: ids.channel, title: "x", seed: newSeed(), salt: newSalt(), entries: [] }),
    ).rejects.toThrow(/at least one entry/);
  });
});
