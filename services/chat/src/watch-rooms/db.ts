// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch-room reads and writes in chat (ADR 0017). The band and mature checks call the 0046
 * functions (`commonair_age_band`, `commonair_room_mature`), so chat and the trigger agree on the
 * database's date. Ending a room and removing a member are conditional updates: several chat
 * instances may act on the same bus event, and only the one whose update changed a row publishes.
 */
import { sql } from "drizzle-orm";
import type { RoomEndReason } from "@commonair/contracts/enums";
import type { Database } from "@commonair/db";

export type MemberCheck = "ok" | "closed" | "age_band" | "banned";

export interface RoomInfo {
  hostId: string;
  channelId: string;
  ageBand: "minor" | "adult";
  slug: string;
}

export type CheckResult =
  | { result: "ok"; member: true; room: RoomInfo }
  | { result: Exclude<MemberCheck, "ok">; member: boolean };

interface CheckRow extends Record<string, unknown> {
  host_id: string;
  channel_id: string;
  age_band: "minor" | "adult";
  ended: boolean;
  slug: string;
  member: boolean;
  band: string | null;
  mature: boolean;
  mature_confirmed: boolean;
  platform_banned: boolean;
  channel_banned: boolean;
}

/**
 * Re-check a member at (re)connect, against the database's day. Blocks are not re-checked: they
 * are checked once, at first join (API, under the room lock; ADR 0017). Re-checking them here
 * would remove whichever party reconnects first, so a host who blocks a disruptive member and
 * refreshes would lose the room, and a member could end it by blocking the host.
 */
export async function checkMember(db: Database, roomId: string, userId: string): Promise<CheckResult> {
  const rows = await db.execute<CheckRow>(sql`
    select r.host_id, r.channel_id, r.age_band, r.ended_at is not null as ended, c.slug,
           exists (select 1 from watch_room_members m
                    where m.room_id = r.id and m.user_id = u.id and m.left_at is null) as member,
           public.commonair_age_band(u.id) as band,
           public.commonair_room_mature(r.broadcast_id) as mature,
           u.mature_confirmed_at is not null as mature_confirmed,
           (u.deleted_at is not null or (u.banned and (u.ban_expires is null or u.ban_expires > now()))) as platform_banned,
           exists (select 1 from chat_bans b
                    where b.channel_id = r.channel_id and b.user_id = u.id and b.lifted_at is null
                      and (b.expires_at is null or b.expires_at > now())) as channel_banned
      from watch_rooms r
      join channels c on c.id = r.channel_id
      join users u on u.id = ${userId}::uuid
     where r.id = ${roomId}::uuid`);
  const row = rows[0];
  if (!row || row.ended || !row.member) return { result: "closed", member: Boolean(row?.member) };
  const member = true;
  if (row.platform_banned || row.channel_banned) return { result: "banned", member };
  if (row.band === null || row.band !== row.age_band) return { result: "age_band", member };
  if (row.mature && (row.band !== "adult" || !row.mature_confirmed)) return { result: "age_band", member };
  return {
    result: "ok",
    member,
    room: { hostId: row.host_id, channelId: row.channel_id, ageBand: row.age_band, slug: row.slug },
  };
}

/**
 * Remove a member (`left_at`); the host's removal ends the room instead. Returns what changed:
 * `kicked`, `ended` (the host), or null when someone else already did it.
 */
export async function removeMember(db: Database, roomId: string, userId: string): Promise<"kicked" | "ended" | null> {
  const [room] = await db.execute<{ host_id: string }>(
    sql`select host_id from watch_rooms where id = ${roomId}::uuid and ended_at is null`,
  );
  if (!room) return null;
  if (room.host_id === userId) return (await endRoom(db, roomId, "moderation")) ? "ended" : null;
  return (await kickMember(db, roomId, userId)) ? "kicked" : null;
}

/** Close the member's open membership. True when this call closed it. */
export async function kickMember(db: Database, roomId: string, userId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    update watch_room_members set left_at = now()
     where room_id = ${roomId}::uuid and user_id = ${userId}::uuid and left_at is null
    returning id`);
  return rows.length > 0;
}

/** End an open room: clear the invite and close every membership. True when this call ended it. */
export async function endRoom(db: Database, roomId: string, reason: RoomEndReason): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ended = await tx.execute(sql`
      update watch_rooms set ended_at = now(), end_reason = ${reason}::room_end_reason, invite_hash = null
       where id = ${roomId}::uuid and ended_at is null
      returning id`);
    if (ended.length === 0) return false;
    await tx.execute(
      sql`update watch_room_members set left_at = now() where room_id = ${roomId}::uuid and left_at is null`,
    );
    return true;
  });
}

/** Open rooms on a channel; `minorOnMature` keeps only minor rooms whose broadcast is mature now. */
export async function openRoomsOnChannel(
  db: Database,
  channelId: string,
  opts: { minorOnMature?: boolean } = {},
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(
    opts.minorOnMature
      ? sql`select id from watch_rooms where channel_id = ${channelId}::uuid and ended_at is null
             and age_band = 'minor' and public.commonair_room_mature(broadcast_id)`
      : sql`select id from watch_rooms where channel_id = ${channelId}::uuid and ended_at is null`,
  );
  return rows.map((r) => r.id);
}

/**
 * Members of the channel's open adult rooms who may no longer watch now that the broadcast is
 * mature: anyone who has not confirmed mature viewing (the band itself is checked at join). The
 * host comes first in each room, so the caller ends the room rather than kicking around it.
 */
export async function unconfirmedOnMature(
  db: Database,
  channelId: string,
): Promise<{ roomId: string; userId: string; isHost: boolean }[]> {
  const rows = await db.execute<{ room_id: string; user_id: string; is_host: boolean }>(sql`
    select r.id as room_id, m.user_id, m.user_id = r.host_id as is_host
      from watch_rooms r
      join watch_room_members m on m.room_id = r.id and m.left_at is null
      join users u on u.id = m.user_id
     where r.channel_id = ${channelId}::uuid and r.ended_at is null and r.age_band = 'adult'
       and public.commonair_room_mature(r.broadcast_id)
       and u.mature_confirmed_at is null
     order by r.id, (m.user_id = r.host_id) desc`);
  return rows.map((r) => ({ roomId: r.room_id, userId: r.user_id, isHost: r.is_host }));
}

/** Rooms the user hosted that account deletion ended in the last hour (`host_deleted`). */
export async function roomsEndedByHostDeletion(db: Database, userId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from watch_rooms
     where host_id = ${userId}::uuid and end_reason = 'host_deleted' and ended_at > now() - interval '1 hour'`);
  return rows.map((r) => r.id);
}

/** Open rooms the user is an active member of, optionally only on one channel. */
export async function openRoomsOfMember(db: Database, userId: string, channelId?: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select r.id from watch_rooms r
      join watch_room_members m on m.room_id = r.id and m.user_id = ${userId}::uuid and m.left_at is null
     where r.ended_at is null ${channelId ? sql`and r.channel_id = ${channelId}::uuid` : sql``}`);
  return rows.map((r) => r.id);
}

/** Whether the user is platform-banned or suspended now (or deleted). */
export async function platformBanned(db: Database, userId: string): Promise<boolean> {
  const [row] = await db.execute<{ banned: boolean }>(sql`
    select (deleted_at is not null or (banned and (ban_expires is null or ban_expires > now()))) as banned
      from users where id = ${userId}::uuid`);
  return Boolean(row?.banned);
}
