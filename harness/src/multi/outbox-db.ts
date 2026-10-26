// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A backlog for the outbox relay: `channel.update` rows for the scenario's own channel written
 * straight into `events` in one transaction (the stack's owner connection, `DATABASE_URL`, as
 * the other scenario DB helpers use), so the relay finds thousands of unpublished rows at once
 * — more than the API's per-user limits let a scenario produce in time. Payloads are valid for
 * the catalog (`toBusEvent` would otherwise mark them published without relaying them), carry a
 * run-unique title, and change nothing: the channel's own row is untouched.
 */
import { createDb, uuidv7 } from "@commonair/db";

export interface Broadcaster {
  channelId: string;
  userId: string;
  login: string;
  name: string;
}

/** Insert one unpublished `channel.update` row per title; returns their ids. */
export async function insertOutboxBacklog(
  databaseUrl: string,
  b: Broadcaster,
  titles: readonly string[],
): Promise<string[]> {
  const ids = titles.map(() => uuidv7());
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    await handle.sql`
      insert into events (id, type, version, channel_id, payload)
      select u.id, 'channel.update', '1', ${b.channelId}::uuid,
             jsonb_build_object(
               'broadcaster_user_id', ${b.userId}::text,
               'broadcaster_user_login', ${b.login}::text,
               'broadcaster_user_name', ${b.name}::text,
               'title', u.title,
               'language', 'en',
               'category_id', null,
               'category_name', null,
               'tags', '[]'::jsonb,
               'mature', false)
        from unnest(${ids}::uuid[], ${[...titles]}::text[]) as u(id, title)`;
    return ids;
  } finally {
    await handle.close();
  }
}

/** How many of `ids` the relay has not marked published yet. */
export async function unpublishedCount(databaseUrl: string, ids: readonly string[]): Promise<number> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    const [r] = await handle.sql<{ n: string }[]>`
      select count(*)::text as n from events where id = any(${[...ids]}::uuid[]) and published_at is null`;
    return Number(r?.n ?? 0);
  } finally {
    await handle.close();
  }
}
