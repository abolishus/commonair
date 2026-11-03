// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The raw rows B8-server's harness steps write straight into the database (`server.ts`), kept here
 * so an integration test runs the same SQL against a migrated database. Tables have no database
 * default for `id` (Drizzle mints it), so every insert mints one with `uuidv7()`.
 */
import { type createDb, uuidv7 } from "@commonair/db";
import { commit } from "@commonair/draw";
import { tsParam } from "../w2/sql-time.ts";

export type Sql = ReturnType<typeof createDb>["sql"];

/** A `previewed` bundle import naming `archiveKey`, created (and last updated) at `createdAt`. */
export async function insertPreviewedImport(
  sql: Sql,
  row: { userId: string; channelId: string; archiveKey: string; createdAt: Date },
): Promise<string> {
  const id = uuidv7(row.createdAt.getTime());
  await sql`
    insert into portability_imports (id, user_id, channel_id, source, status, archive_key, created_at, updated_at)
    values (${id}::uuid, ${row.userId}::uuid, ${row.channelId}::uuid, 'commonair', 'previewed', ${row.archiveKey},
            ${tsParam(row.createdAt)}::timestamptz, ${tsParam(row.createdAt)}::timestamptz)`;
  return id;
}

export interface DrawnGiveaway {
  channelId: string;
  title: string;
  /** The seed (hex), revealed at the draw; its commitment is written at insert. */
  seed: string;
  salt: string;
  /** Entrants and their pseudonyms; the first one wins rank 1. */
  entries: readonly { userId: string; pseudonym: string }[];
}

/**
 * A giveaway taken through its life as the triggers allow (0046): opened, entered, closed, then the
 * seed revealed, the winner written and `drawn` set in one transaction. Returns its id.
 */
export async function insertDrawnGiveaway(sql: Sql, g: DrawnGiveaway): Promise<string> {
  const winner = g.entries[0];
  if (!winner) throw new Error("insertDrawnGiveaway: at least one entry");
  const id = uuidv7();
  const commitment = await commit(g.seed);
  const eligibility = JSON.stringify({ minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 });
  await sql`
    insert into giveaways (id, channel_id, title, prize, eligibility, winner_count, seed_commitment, sealed_seed, salt)
    values (${id}::uuid, ${g.channelId}::uuid, ${g.title}, 'a mug', ${eligibility}::jsonb,
            1, ${commitment}, 'v1.harness', ${g.salt})`;
  for (const e of g.entries)
    await sql`insert into giveaway_entries (giveaway_id, user_id, pseudonym)
              values (${id}::uuid, ${e.userId}::uuid, ${e.pseudonym})`;
  await sql`update giveaways set status = 'closed', closed_at = now() where id = ${id}::uuid`;
  await sql.begin(async (tx) => {
    await tx`update giveaways set seed = ${g.seed} where id = ${id}::uuid`;
    await tx`insert into giveaway_winners (giveaway_id, user_id, rank, draw_index)
             values (${id}::uuid, ${winner.userId}::uuid, 1, 0)`;
    await tx`update giveaways set status = 'drawn', drawn_at = now() where id = ${id}::uuid`;
  });
  return id;
}
