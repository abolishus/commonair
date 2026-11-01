// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `watch-room` scenario's database touches, with `DATABASE_URL` (the stack's owner connection,
 * as the operator CLI uses). The direct-insert refusal runs `SET LOCAL ROLE <app role>` inside a
 * transaction that is **always rolled back**: even if the trigger ever accepted the row, nothing
 * would be kept. Reads return ids, enums, counts and the report's evidence (ids and the scenario's
 * own marker text only).
 */
import { createDb } from "@commonair/db";
import { DEFAULT_APP_ROLE } from "../../safety-db.ts";

type Sql = ReturnType<typeof createDb>["sql"];
const ROLLBACK = Symbol("rollback");

async function withDb<T>(databaseUrl: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

export interface InsertRefusal {
  refused: boolean;
  sqlState: string | null;
  /** The trigger's message (its code prefix, e.g. `room_age_band:`), no row data. */
  message: string | null;
}

/** Try, as the app role, to add `userId` to the room directly; always rolled back. */
export async function directMemberInsert(
  databaseUrl: string,
  roomId: string,
  userId: string,
  appRole = DEFAULT_APP_ROLE,
): Promise<InsertRefusal> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`bad role name: ${appRole}`);
  return withDb(databaseUrl, async (sql) => {
    let result: InsertRefusal | null = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${appRole}`);
        const [who] = await tx<{ current_user: string }[]>`select current_user`;
        if (who?.current_user !== appRole) throw new Error(`could not act as ${appRole} (got ${who?.current_user})`);
        try {
          await tx`insert into public.watch_room_members (room_id, user_id) values (${roomId}::uuid, ${userId}::uuid)`;
          result = { refused: false, sqlState: null, message: null };
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          result = {
            refused: true,
            sqlState: typeof code === "string" ? code : null,
            message: err instanceof Error ? err.message.slice(0, 200) : String(err),
          };
        }
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    if (!result) throw new Error("direct insert did not run");
    return result;
  });
}

export interface ReportRow {
  channelId: string | null;
  subjectType: string;
  evidence: unknown;
}

export async function reportRow(databaseUrl: string, reportId: string): Promise<ReportRow | null> {
  return withDb(databaseUrl, async (sql) => {
    const [row] = await sql<{ channel_id: string | null; subject_type: string; evidence: unknown }[]>`
      select channel_id, subject_type::text, evidence from public.reports where id = ${reportId}::uuid`;
    if (!row) return null;
    const evidence = typeof row.evidence === "string" ? (JSON.parse(row.evidence) as unknown) : row.evidence;
    return { channelId: row.channel_id, subjectType: row.subject_type, evidence };
  });
}

export interface RoomCounts {
  rooms: number;
  members: number;
  messages: number;
}

/** Rows left for a room (0 everywhere once retention deleted it). */
export async function roomCounts(databaseUrl: string, roomId: string): Promise<RoomCounts> {
  return withDb(databaseUrl, async (sql) => {
    const [row] = await sql<{ rooms: number; members: number; messages: number }[]>`
      select (select count(*)::int from public.watch_rooms where id = ${roomId}::uuid) as rooms,
             (select count(*)::int from public.watch_room_members where room_id = ${roomId}::uuid) as members,
             (select count(*)::int from public.watch_room_messages where room_id = ${roomId}::uuid) as messages`;
    return row ?? { rooms: 0, members: 0, messages: 0 };
  });
}
