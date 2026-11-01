// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Daily: drop `relay_purges` rows older than `RELAY_PURGE_RULES.retentionDays` (ADR 0016
 * Amendment 1 A1.1; the 0046 trigger refuses anything younger) and record the highest `seq`
 * deleted as the **watermark** (A1.2): the feed answers a relay whose cursor is below it with a
 * signed reset, because rows it never saw are gone.
 *
 * The watermark lives in Valkey (`RELAY_PURGE_WATERMARK_KEY`). It only ever grows (a Lua max),
 * and it is written *before* the delete, so a failed delete leaves it early rather than late:
 * an early watermark resets a few relays for nothing, which only empties their caches, while a
 * late one would let a relay skip rows. If Valkey loses it, relays more than 7 days behind are
 * not reset until the next cleanup writes it again; their DVR objects are kept no longer than
 * the DVR window and the 5 s playlist rule still applies.
 */
import { RELAY_PURGE_RULES } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import { sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";

/**
 * The watermark's Valkey key (STRING, decimal seq). The API reads the same name
 * (`services/api/src/relay/purges.ts`). Contract request: `KEYS.relayPurgeWatermark` in
 * `@commonair/contracts/internal`.
 */
export const RELAY_PURGE_WATERMARK_KEY = "relay-purge:watermark";

/** SET key to max(current, ARGV[1]); returns the stored string (seqs are below 2^53, exact as Lua numbers). */
const RAISE = `local cur = redis.call('GET', KEYS[1]) or '0'
if tonumber(ARGV[1]) > (tonumber(cur) or 0) then redis.call('SET', KEYS[1], ARGV[1]) return ARGV[1] end
return cur`;

export interface CleanupResult {
  deleted: number;
  watermark: number;
}

export async function cleanupPurges(ctx: Pick<WorkerContext, "db" | "valkey">): Promise<CleanupResult> {
  const days = RELAY_PURGE_RULES.retentionDays;
  const old = sql`${schema.relayPurges.createdAt} < now() - make_interval(days => ${days})`;
  const [top] = await ctx.db
    .select({ seq: sql<string | null>`max(${schema.relayPurges.seq})` })
    .from(schema.relayPurges)
    .where(old);
  const highest = top?.seq === null || top?.seq === undefined ? 0 : Number(top.seq);
  let watermark = Number((await ctx.valkey.get(RELAY_PURGE_WATERMARK_KEY)) ?? 0) || 0;
  if (highest === 0) return { deleted: 0, watermark };
  watermark = Number(await ctx.valkey.eval(RAISE, 1, RELAY_PURGE_WATERMARK_KEY, String(highest)));
  // Only rows at or below the recorded seq: a row aging past the cutoff meanwhile waits a day.
  const deleted = await ctx.db
    .delete(schema.relayPurges)
    .where(sql`${old} and ${schema.relayPurges.seq} <= ${highest}`)
    .returning({ seq: schema.relayPurges.seq });
  return { deleted: deleted.length, watermark };
}
