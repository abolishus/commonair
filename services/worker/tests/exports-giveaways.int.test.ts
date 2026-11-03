// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact-giveaways.json` in the account export (batch 8): the member's own entries (title,
 * channel, time, their own pseudonym) and wins (rank, drawn at). Never another member's pseudonym,
 * never the salt or the seed. A deleted giveaway's rows are gone; a banned entrant keeps theirs.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { commit, newSalt, newSeed } from "@commonair/draw";
import { collect } from "../src/exports/collectors.ts";
import { makeUser } from "./fixtures.ts";

let t: TestDatabase;
let owner: Database;
beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
}, 120_000);
afterAll(() => t?.drop());

interface Made {
  id: string;
  salt: string;
  seed: string;
}

async function giveaway(channelId: string, title: string): Promise<Made> {
  const id = uuidv7();
  const seed = newSeed();
  const salt = newSalt();
  await owner.insert(schema.giveaways).values({
    id,
    channelId,
    title,
    prize: "a mug",
    eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
    winnerCount: 2,
    seedCommitment: await commit(seed),
    sealedSeed: "v1.sealed",
    salt,
  });
  return { id, salt, seed };
}

const enter = (giveawayId: string, userId: string, pseudonym: string) =>
  owner.insert(schema.giveawayEntries).values({ giveawayId, userId, pseudonym });

async function draw(g: Made, winners: string[]) {
  await owner
    .update(schema.giveaways)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(schema.giveaways.id, g.id));
  await owner.transaction(async (tx) => {
    await tx.update(schema.giveaways).set({ seed: g.seed }).where(eq(schema.giveaways.id, g.id));
    for (const [i, userId] of winners.entries())
      await tx.insert(schema.giveawayWinners).values({ giveawayId: g.id, userId, rank: i + 1, drawIndex: i });
    await tx
      .update(schema.giveaways)
      .set({ status: "drawn", drawnAt: new Date() })
      .where(eq(schema.giveaways.id, g.id));
  });
}

const exported = async (userId: string) =>
  owner.transaction(
    async (tx) =>
      (await collect(tx, "account", { userId, channelId: null })).get("interact-giveaways.json") as {
        entries: Record<string, unknown>[];
        wins: Record<string, unknown>[];
      },
  );

test("the caller's own entries and wins only: no other pseudonym, no salt, no seed", async () => {
  const streamer = await makeUser(owner);
  const me = await makeUser(owner);
  const other = await makeUser(owner);
  const drawn = await giveaway(streamer.channel.id, "Launch day");
  await enter(drawn.id, me.user.id, "p-mine-1");
  await enter(drawn.id, other.user.id, "p-other-1");
  await draw(drawn, [other.user.id, me.user.id]);
  const open = await giveaway(streamer.channel.id, "Still open");
  await enter(open.id, me.user.id, "p-mine-2");
  await enter(open.id, other.user.id, "p-other-2");

  const file = await exported(me.user.id);
  expect(file.entries).toEqual([
    {
      giveawayId: drawn.id,
      giveawayTitle: "Launch day",
      channelSlug: streamer.channel.slug,
      enteredAt: expect.anything(),
      pseudonym: "p-mine-1",
    },
    {
      giveawayId: open.id,
      giveawayTitle: "Still open",
      channelSlug: streamer.channel.slug,
      enteredAt: expect.anything(),
      pseudonym: "p-mine-2",
    },
  ]);
  expect(file.wins).toEqual([
    {
      giveawayId: drawn.id,
      giveawayTitle: "Launch day",
      channelSlug: streamer.channel.slug,
      rank: 2,
      drawnAt: expect.anything(),
    },
  ]);
  const text = JSON.stringify(file);
  for (const secret of [drawn.salt, drawn.seed, open.salt, "p-other-1", "p-other-2", other.user.id])
    expect(text).not.toContain(secret);

  // Someone who never entered exports two empty lists.
  expect(await exported(streamer.user.id)).toEqual({ entries: [], wins: [] });
});

test("an entrant banned afterwards keeps the entry; a deleted giveaway is not exported", async () => {
  const streamer = await makeUser(owner);
  const me = await makeUser(owner);
  const kept = await giveaway(streamer.channel.id, "Kept");
  const gone = await giveaway((await makeUser(owner)).channel.id, "Gone");
  await enter(kept.id, me.user.id, "p-kept");
  await enter(gone.id, me.user.id, "p-gone");
  await owner
    .update(schema.users)
    .set({ banned: true, banReason: "moderation" })
    .where(eq(schema.users.id, me.user.id));
  await owner
    .update(schema.giveaways)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(eq(schema.giveaways.id, gone.id));
  await owner.delete(schema.giveaways).where(eq(schema.giveaways.id, gone.id));

  const file = await exported(me.user.id);
  expect(file.entries.map((e) => e.giveawayTitle)).toEqual(["Kept"]);
  expect(JSON.stringify(file)).not.toContain("p-gone");
});
