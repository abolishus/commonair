// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `rehearsal` scenario's database reads (`DATABASE_URL`, the stack's owner connection): what
 * no API exposes (outbox rows, streaming hours, ledger postings, attestations, the VOD's expiry,
 * audit rows), and the direct inserts the 0043 triggers must refuse, each in a transaction that is
 * always rolled back so nothing is ever written.
 */
import { createDb } from "@commonair/db";

type Sql = ReturnType<typeof createDb>["sql"];
const ROLLBACK = Symbol("rollback");

async function withDb<T>(databaseUrl: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness-rehearsal" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

const count = async (q: PromiseLike<readonly { n: string }[]>) => Number((await q)[0]?.n ?? 0);

export interface Downstream {
  /** `stream.online` / `stream.offline` outbox rows for the channel since the run started. */
  streamEvents: number;
  /** Webhook / EventSub deliveries of those events for the channel. */
  deliveries: number;
  /** Go-live notifications (inbox, push and e-mail digests read the same rows) of a follower. */
  goLiveNotifications: number;
}

export async function downstreamOf(
  databaseUrl: string,
  channelId: string,
  followerId: string,
  since: Date,
): Promise<Downstream> {
  return withDb(databaseUrl, async (sql) => ({
    streamEvents: await count(sql`select count(*)::text as n from events where channel_id = ${channelId}
           and type in ('stream.online', 'stream.offline') and occurred_at >= ${since}`),
    deliveries: await count(sql`select count(*)::text as n from webhook_deliveries d join events e on e.id = d.event_id
           where e.channel_id = ${channelId} and e.type in ('stream.online', 'stream.offline')
             and e.occurred_at >= ${since}`),
    goLiveNotifications: await count(sql`select count(*)::text as n from notifications where type = 'go_live'
           and user_id = ${followerId} and created_at >= ${since}`),
  }));
}

export interface Counted {
  streamHours: number;
  ledger: number;
  attestations: number;
  audienceRollup: number;
}

export async function countedFor(databaseUrl: string, broadcastId: string): Promise<Counted> {
  return withDb(databaseUrl, async (sql) => ({
    streamHours: await count(sql`select count(*)::text as n from stream_hours where broadcast_id = ${broadcastId}`),
    ledger: await count(
      sql`select count(*)::text as n from ledger_transactions where ref_type = 'broadcast' and ref_id = ${broadcastId}`,
    ),
    attestations: await count(
      sql`select count(*)::text as n from integrity_attestations where broadcast_id = ${broadcastId}`,
    ),
    audienceRollup: await count(
      sql`select count(*)::text as n from broadcast_audience_totals where broadcast_id = ${broadcastId}`,
    ),
  }));
}

/** Each direct insert, rolled back whatever happens: the database's own refusal message, or null if it was accepted. */
export async function directInsertRefusals(
  databaseUrl: string,
  b: { broadcastId: string; channelId: string },
): Promise<Record<"streamHours" | "ledger" | "attestation" | "liveBroadcast", string | null>> {
  return withDb(databaseUrl, async (sql) => {
    const attempt = async (fn: (tx: Sql) => Promise<unknown>): Promise<string | null> => {
      try {
        await sql.begin(async (tx) => {
          await fn(tx as unknown as Sql);
          throw ROLLBACK;
        });
        return null;
      } catch (err) {
        if (err === ROLLBACK) return null;
        return err instanceof Error ? err.message : String(err);
      }
    };
    return {
      streamHours: await attempt(
        (tx) =>
          tx`insert into stream_hours (broadcast_id, channel_id, hour_start, live_seconds)
             values (${b.broadcastId}, ${b.channelId}, now(), 60)`,
      ),
      ledger: await attempt(
        (tx) =>
          tx`insert into ledger_transactions (id, kind, description, occurred_at, ref_type, ref_id, idempotency_key)
             values (gen_random_uuid(), 'tip', 'harness', now(), 'broadcast', ${b.broadcastId}, gen_random_uuid()::text)`,
      ),
      attestation: await attempt(
        (tx) =>
          tx`insert into integrity_attestations (channel_id, broadcast_id) values (${b.channelId}, ${b.broadcastId})`,
      ),
      liveBroadcast: await attempt(
        (tx) => tx`update channels set live_broadcast_id = ${b.broadcastId} where id = ${b.channelId}`,
      ),
    };
  });
}

export interface RehearsalVod {
  id: string;
  visibility: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export async function vodOf(databaseUrl: string, broadcastId: string): Promise<RehearsalVod | null> {
  return withDb(databaseUrl, async (sql) => {
    const [v] = await sql<
      { id: string; visibility: string; status: string; expires_at: Date | null; created_at: Date }[]
    >`select id, visibility::text as visibility, status::text as status, expires_at, created_at
        from vods where broadcast_id = ${broadcastId} limit 1`;
    return v
      ? { id: v.id, visibility: v.visibility, status: v.status, expiresAt: v.expires_at, createdAt: v.created_at }
      : null;
  });
}

export interface StoredChat {
  /** Messages stored for the channel since the run started (this scenario sends none of its own). */
  channel: number;
  /** Messages on the rehearsal broadcast: what chat replay of its VOD would show. */
  broadcast: number;
}

/** Simulated chat goes through the dry run, which never stores: both counts must stay 0. */
export async function storedChat(
  databaseUrl: string,
  channelId: string,
  broadcastId: string,
  since: Date,
): Promise<StoredChat> {
  return withDb(databaseUrl, async (sql) => ({
    channel: await count(sql`select count(*)::text as n from chat_messages
           where channel_id = ${channelId} and created_at >= ${since}`),
    broadcast: await count(sql`select count(*)::text as n from chat_messages where broadcast_id = ${broadcastId}`),
  }));
}

export async function broadcastEndedAt(databaseUrl: string, broadcastId: string): Promise<Date | null> {
  return withDb(databaseUrl, async (sql) => {
    const [b] = await sql<{ ended_at: Date | null }[]>`select ended_at from broadcasts where id = ${broadcastId}`;
    return b?.ended_at ?? null;
  });
}

/** Audit rows of the rehearsal's channel since the run started: action, subject and details' arm id. */
export async function rehearsalAudit(
  databaseUrl: string,
  channelId: string,
  since: Date,
): Promise<{ action: string; subjectType: string; subjectId: string; armId: string | null }[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ action: string; subject_type: string; subject_id: string; arm_id: string | null }[]>`
      select action, subject_type, subject_id, details->>'armId' as arm_id from audit_log
       where channel_id = ${channelId} and action like 'rehearsal.%' and created_at >= ${since}
       order by created_at`;
    return rows.map((r) => ({
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      armId: r.arm_id,
    }));
  });
}
