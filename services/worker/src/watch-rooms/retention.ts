// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch-room retention (ADR 0017 decision 1): rooms ended more than `ROOM_LIMITS.retentionDays` ago
 * are deleted (members and messages cascade; a report keeps its own copy in `reports.evidence`).
 * Open rooms that have had no active member for `ROOM_LIMITS.emptyEndMinutes`, and open rooms whose
 * broadcast is no longer live (a missed bus event), are ended, and the chat instances are told over
 * `BUS.roomControl`. Deletion is batched so one run never holds a long lock.
 */
import { BUS, RoomControlMessage } from "@commonair/contracts";
import { ROOM_LIMITS, type RoomEndReason } from "@commonair/contracts/enums";
import { sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";

/** Rooms deleted per statement. */
export const RETENTION_BATCH = 500;

/** The bus prefix tests isolate with: `busChannel` is `<prefix>` + `BUS.events`. */
export function roomControlChannel(busChannel: string): string {
  const prefix = busChannel.endsWith(BUS.events) ? busChannel.slice(0, busChannel.length - BUS.events.length) : "";
  return prefix + BUS.roomControl;
}

async function endRooms(
  ctx: Pick<WorkerContext, "db" | "valkey" | "busChannel" | "logger">,
  ids: readonly string[],
  reason: RoomEndReason,
): Promise<number> {
  let ended = 0;
  for (const id of ids) {
    const done = await ctx.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        update watch_rooms set ended_at = now(), end_reason = ${reason}::room_end_reason, invite_hash = null
         where id = ${id}::uuid and ended_at is null
        returning id`);
      if (rows.length === 0) return false;
      await tx.execute(
        sql`update watch_room_members set left_at = now() where room_id = ${id}::uuid and left_at is null`,
      );
      return true;
    });
    if (!done) continue;
    ended++;
    const msg = RoomControlMessage.parse({ op: "room.close", roomId: id, reason });
    await ctx.valkey
      .publish(roomControlChannel(ctx.busChannel), JSON.stringify(msg))
      .catch((err: unknown) => ctx.logger.warn("room control publish failed", { roomId: id, err }));
  }
  return ended;
}

export async function runRetention(
  ctx: Pick<WorkerContext, "db" | "valkey" | "busChannel" | "logger">,
): Promise<Record<string, number>> {
  const empty = await ctx.db.execute<{ id: string }>(sql`
    select r.id from watch_rooms r
     where r.ended_at is null
       and not exists (select 1 from watch_room_members m where m.room_id = r.id and m.left_at is null)
       and greatest(r.created_at,
                    coalesce((select max(m.left_at) from watch_room_members m where m.room_id = r.id), r.created_at))
           < now() - make_interval(mins => ${ROOM_LIMITS.emptyEndMinutes})`);
  const notLive = await ctx.db.execute<{ id: string }>(sql`
    select r.id from watch_rooms r
      join broadcasts b on b.id = r.broadcast_id
      join channels c on c.id = r.channel_id
     where r.ended_at is null
       and (b.ended_at is not null or c.live_broadcast_id is distinct from r.broadcast_id)`);
  const endedEmpty = await endRooms(
    ctx,
    empty.map((r) => r.id),
    "empty",
  );
  const endedOffline = await endRooms(
    ctx,
    notLive.map((r) => r.id),
    "broadcast_ended",
  );

  let deleted = 0;
  for (;;) {
    const rows = await ctx.db.execute<{ id: string }>(sql`
      delete from watch_rooms where id in (
        select id from watch_rooms
         where ended_at is not null
           and ended_at < now() - make_interval(days => ${ROOM_LIMITS.retentionDays})
         limit ${RETENTION_BATCH})
      returning id`);
    deleted += rows.length;
    if (rows.length < RETENTION_BATCH) break;
  }
  if (deleted + endedEmpty + endedOffline > 0)
    ctx.logger.info("watch room retention", { deleted, endedEmpty, endedOffline });
  return { deleted, endedEmpty, endedOffline };
}
