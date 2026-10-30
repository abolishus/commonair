// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The go-live cooldown (ADR 0028 decision 3): one conditional upsert per page. A follower passes
 * when they have no row for the channel, when their last send is at least `cooldownHours` old, or
 * when the row was written by this same event (a retried job passes again; everything after it is
 * idempotent by event and user). Concurrent jobs for two events of one channel serialize on the
 * row: the second sees the first's committed send and is refused, so replicas cannot both pass.
 */
import type { Executor } from "@commonair/db";
import { sql } from "drizzle-orm";

export interface CooldownClaim {
  channelId: string;
  eventId: string;
  now: Date;
  cooldownHours: number;
  /** Followers with at least one medium. */
  userIds: readonly string[];
}

/** Returns the followers who passed; the rest are cooled down. */
export async function claimCooldown(tx: Executor, c: CooldownClaim): Promise<Set<string>> {
  if (c.userIds.length === 0) return new Set();
  // Sorted: two pages that overlap in followers lock their rows in the same order (no deadlock).
  const ids = [...c.userIds].sort();
  const rows = (await tx.execute(sql`
    insert into notification_go_live_sends as s (user_id, channel_id, last_sent_at, event_id)
    select u, ${c.channelId}::uuid, ${c.now.toISOString()}::timestamptz, ${c.eventId}::uuid
      from unnest(array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]) with ordinality as t(u, n)
     order by n
    on conflict (user_id, channel_id) do update
       set last_sent_at = excluded.last_sent_at, event_id = excluded.event_id
     where s.last_sent_at <= excluded.last_sent_at - make_interval(hours => ${c.cooldownHours}::int)
        or s.event_id = excluded.event_id
    returning user_id`)) as unknown as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}
