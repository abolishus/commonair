// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `twitch-import` scenario's database access (`DATABASE_URL`, the stack's owner connection):
 * the fixture category the import maps by name (categories have no API to create them), and the
 * T0 cases a refused emote opened.
 */
import { createDb, uuidv7 } from "@commonair/db";
import { tsParam } from "../w2/sql-time.ts";

type Sql = ReturnType<typeof createDb>["sql"];

async function withDb<T>(databaseUrl: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness-twitch-import" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

/** The category named `name` (created with `slug` when missing); its id. */
export async function ensureCategory(databaseUrl: string, slug: string, name: string): Promise<string> {
  return withDb(databaseUrl, async (sql) => {
    await sql`insert into categories (id, slug, name) values (${uuidv7()}, ${slug}, ${name})
               on conflict (slug) do nothing`;
    const rows = await sql<
      { id: string }[]
    >`select id::text as id from categories where name = ${name} order by created_at limit 1`;
    const id = rows[0]?.id;
    if (!id) throw new Error(`category ${name} is missing`);
    return id;
  });
}

/** T0 cases opened for a channel since `since` (a refused emote image opens one). */
export async function t0CasesSince(databaseUrl: string, channelId: string, since: Date): Promise<number> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from moderation_cases
       where channel_id = ${channelId} and tier = 't0' and created_at >= ${tsParam(since)}::timestamptz`;
    return Number(rows[0]?.n ?? 0);
  });
}
