// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `portability` scenario's database reads (`DATABASE_URL`, the stack's owner connection): what
 * no API shows (a follow's source, the T0 case an import's refused image opened). Reads only.
 */
import { createDb } from "@commonair/db";
import { tsParam } from "../../w2/sql-time.ts";

type Sql = ReturnType<typeof createDb>["sql"];

async function withDb<T>(databaseUrl: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness-portability" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

/** A follow's `source` and whether it names a move link; null when there is no follow. */
export async function followSource(
  databaseUrl: string,
  followerId: string,
  channelId: string,
): Promise<{ source: string; moveLinkId: string | null } | null> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ source: string; move_link_id: string | null }[]>`
      select source::text as source, move_link_id::text as move_link_id from follows
       where follower_id = ${followerId} and channel_id = ${channelId}`;
    const r = rows[0];
    return r ? { source: r.source, moveLinkId: r.move_link_id } : null;
  });
}

/** T0 cases opened for a channel since `since` (an import's refused image opens one). */
export async function t0CasesSince(databaseUrl: string, channelId: string, since: Date): Promise<number> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from moderation_cases
       where channel_id = ${channelId} and tier = 't0' and created_at >= ${tsParam(since)}::timestamptz`;
    return Number(rows[0]?.n ?? 0);
  });
}
