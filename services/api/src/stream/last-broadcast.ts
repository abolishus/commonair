// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `stream.lastBroadcast` (overhaul wave 5, D5.3): the channel's most recent ended live broadcast
 * with exact recap counts read from the rows, so the web recap no longer pages follower and clip
 * lists (which stopped after 1000 items).
 *
 * - The broadcast: the newest `kind = 'live'` row with `ended_at` set (`broadcasts_channel_idx`,
 *   newest start first; a channel has at most one open broadcast). Rehearsals are not streams.
 * - Follows: made in [started_at, ended_at], edges included, excluded follows left out
 *   (`follows_channel_idx`). A follow made then and since removed is gone from the table: the
 *   count is of follows that still stand, like every other follower number.
 * - Clips: carry their broadcast id (`clips_broadcast_idx`); deleted clips are left out.
 * - Chat messages: every row the channel received in the window (`chat_messages_channel_idx`),
 *   deleted and held ones included: they were sent.
 * - Peak so far: `broadcasts.peak_verified_viewers`, provisional until the analytics settle.
 * - Video: the broadcast's newest non-deleted VOD (`vods_broadcast_idx`).
 *
 * One round trip: the counts are scalar subqueries of the broadcast's select.
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { LastBroadcast } from "@commonair/contracts/dto";
import { type Database, schema } from "@commonair/db";

const { broadcasts, chatMessages, clips, follows, vods } = schema;

const count = (q: ReturnType<typeof sql>) => sql<number>`(${q})`.mapWith(Number);
/**
 * The outer row's columns, qualified by hand: Drizzle prints columns unqualified in a one-table
 * select, and inside a subquery an unqualified `id` would mean the subquery's own table.
 */
const outer = {
  id: sql.raw(`"broadcasts"."id"`),
  channelId: sql.raw(`"broadcasts"."channel_id"`),
  startedAt: sql.raw(`"broadcasts"."started_at"`),
  endedAt: sql.raw(`"broadcasts"."ended_at"`),
};

export async function readLastBroadcast(db: Database, channelId: string): Promise<LastBroadcast | null> {
  const [row] = await db
    .select({
      broadcastId: broadcasts.id,
      title: broadcasts.title,
      startedAt: broadcasts.startedAt,
      endedAt: broadcasts.endedAt,
      peakSoFar: broadcasts.peakVerifiedViewers,
      newFollowers: count(
        sql`select count(*) from ${follows} where ${follows.channelId} = ${outer.channelId}
            and ${follows.createdAt} >= ${outer.startedAt} and ${follows.createdAt} <= ${outer.endedAt}
            and ${follows.excludedAt} is null`,
      ),
      clips: count(
        sql`select count(*) from ${clips} where ${clips.broadcastId} = ${outer.id}
            and ${clips.status} <> 'deleted'`,
      ),
      chatMessages: count(
        sql`select count(*) from ${chatMessages} where ${chatMessages.channelId} = ${outer.channelId}
            and ${chatMessages.createdAt} >= ${outer.startedAt} and ${chatMessages.createdAt} <= ${outer.endedAt}`,
      ),
      vodId: sql<string | null>`(select ${vods.id} from ${vods} where ${vods.broadcastId} = ${outer.id}
            and ${vods.status} <> 'deleted' order by ${vods.createdAt} desc limit 1)`,
    })
    .from(broadcasts)
    .where(and(eq(broadcasts.channelId, channelId), eq(broadcasts.kind, "live"), isNotNull(broadcasts.endedAt)))
    .orderBy(desc(broadcasts.startedAt))
    .limit(1);
  if (!row?.endedAt) return null;
  const durationSeconds = Math.max(0, Math.floor((row.endedAt.getTime() - row.startedAt.getTime()) / 1000));
  return {
    broadcastId: row.broadcastId,
    title: row.title,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    durationSeconds,
    newFollowers: row.newFollowers,
    clips: row.clips,
    chatMessages: row.chatMessages,
    peakSoFar: row.peakSoFar,
    vodId: row.vodId,
  };
}
