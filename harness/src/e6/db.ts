// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E6 scenarios' database touches, all with `DATABASE_URL` (the stack's owner connection, as
 * the operator CLI and the other scenario DB helpers use): read-only state the API does not
 * expose (simulcast sessions, removal reasons, storage keys, audit actions, what survived an
 * account deletion), one write the spec asks for (moving an export's `expires_at` into the past),
 * the secrets the export scan looks for (kept in memory, never reported), and the PII scan of
 * the retained tables after a deletion.
 *
 * Nothing here returns personal data into the report: scans return table names, labels and
 * counts only.
 */
import { createDb, uuidv7 } from "@commonair/db";
import { isoOrNull } from "../safety-db.ts";

type Sql = ReturnType<typeof createDb>["sql"];

async function withDb<T>(databaseUrl: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** A Postgres identifier the scan builds SQL from; only plain lower-case names pass. */
export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`refusing identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

// ---------------------------------------------------------------- simulcast

export interface SimulcastSessionRow {
  id: string;
  status: string;
  bytesSent: number;
  startedAt: string | null;
  endedAt: string | null;
}

export async function simulcastSessions(databaseUrl: string, targetId: string): Promise<SimulcastSessionRow[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<
      {
        id: string;
        status: string;
        bytes_sent: string;
        started_at: string | Date | null;
        ended_at: string | Date | null;
      }[]
    >`
      select id::text as id, status::text as status, bytes_sent::text as bytes_sent, started_at, ended_at
        from simulcast_sessions where target_id = ${targetId} order by started_at`;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      bytesSent: Number(r.bytes_sent),
      startedAt: isoOrNull(r.started_at),
      endedAt: isoOrNull(r.ended_at),
    }));
  });
}

// ---------------------------------------------------------------- VODs and clips

export interface MediaRow {
  status: string | null;
  removedReason: string | null;
  /** VOD: its storage prefix; clip: its video key. */
  storage: string | null;
  thumbnailKey: string | null;
}

export interface VodRow extends MediaRow {
  expiresAt: string | null;
  /** `expires_at <= now()` on the database clock: retention will pick the row up. */
  due: boolean;
}

export async function vodRow(databaseUrl: string, vodId: string): Promise<VodRow> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<
      {
        status: string;
        removed_reason: string | null;
        storage_prefix: string;
        thumbnail_key: string | null;
        expires_at: string | Date | null;
        due: boolean;
      }[]
    >`select status::text as status, removed_reason, storage_prefix, thumbnail_key, expires_at,
             coalesce(expires_at <= now(), false) as due
        from vods where id = ${vodId}`;
    return {
      status: r?.status ?? null,
      removedReason: r?.removed_reason ?? null,
      storage: r?.storage_prefix ?? null,
      thumbnailKey: r?.thumbnail_key ?? null,
      expiresAt: isoOrNull(r?.expires_at),
      due: r?.due ?? false,
    };
  });
}

export async function clipRow(databaseUrl: string, clipId: string): Promise<MediaRow> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<
      { status: string; removed_reason: string | null; storage_key: string | null; thumbnail_key: string | null }[]
    >`select status::text as status, removed_reason, storage_key, thumbnail_key from clips where id = ${clipId}`;
    return {
      status: r?.status ?? null,
      removedReason: r?.removed_reason ?? null,
      storage: r?.storage_key ?? null,
      thumbnailKey: r?.thumbnail_key ?? null,
    };
  });
}

/** Clip ids of a broadcast (any status), for "every clip of the broadcast went with the VOD". */
export async function clipsOfVodBroadcast(databaseUrl: string, vodId: string): Promise<string[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ id: string }[]>`
      select c.id::text as id from clips c join vods v on v.broadcast_id = c.broadcast_id
       where v.id = ${vodId} order by c.created_at`;
    return rows.map((r) => r.id);
  });
}

// ---------------------------------------------------------------- exports

export interface ExportRow {
  status: string | null;
  storageKey: string | null;
  expiresAt: string | null;
  completedAt: string | null;
}

export async function exportRow(databaseUrl: string, exportId: string): Promise<ExportRow> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<
      {
        status: string;
        storage_key: string | null;
        expires_at: string | Date | null;
        completed_at: string | Date | null;
      }[]
    >`select status::text as status, storage_key, expires_at, completed_at from data_exports where id = ${exportId}`;
    return {
      status: r?.status ?? null,
      storageKey: r?.storage_key ?? null,
      expiresAt: isoOrNull(r?.expires_at),
      completedAt: isoOrNull(r?.completed_at),
    };
  });
}

/** Move a ready export's `expires_at` a minute into the past (spec step 6). Returns rows changed. */
export async function expireExportNow(databaseUrl: string, exportId: string): Promise<number> {
  return withDb(databaseUrl, async (sql) => {
    const r = await sql`
      update data_exports set expires_at = now() - interval '1 minute'
       where id = ${exportId} and status = 'ready'`;
    return r.count;
  });
}

// ---------------------------------------------------------------- audit

/** Audit actions (with counts) recorded on a channel or about any of the subject ids. */
export async function auditActionCounts(
  databaseUrl: string,
  where: { channelId?: string; subjectIds?: readonly string[] },
): Promise<Record<string, number>> {
  const subjects = [...(where.subjectIds ?? [])];
  if (!where.channelId && subjects.length === 0) return {};
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ action: string; n: string }[]>`
      select action, count(*)::text as n from audit_log
       where ${where.channelId ? sql`channel_id = ${where.channelId}` : sql`false`}
          or ${subjects.length > 0 ? sql`subject_id in ${sql(subjects)}` : sql`false`}
       group by action`;
    return Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]));
  });
}

/** One retained row that references a user: where it is and which of its columns name them. */
export interface RowRef {
  table: string;
  id: string;
  /** `column=value` pairs that held the user's id when recorded (ids only, no personal data). */
  refs: string[];
}

/** Rows present in `before` that are missing from `after` or no longer reference the user the same way. */
export function lostRows(before: readonly RowRef[], after: readonly RowRef[]): RowRef[] {
  const now = new Map(after.map((r) => [`${r.table}/${r.id}`, new Set(r.refs)]));
  return before.filter((r) => {
    const refs = now.get(`${r.table}/${r.id}`);
    return refs === undefined || r.refs.some((x) => !refs.has(x));
  });
}

/**
 * Every `audit_log` row naming the user as actor or subject, and every `*_history` row with the
 * user's id in a uuid column, by primary key (spec step 4 compares these ids, never counts).
 */
export async function rowsReferencing(databaseUrl: string, userId: string): Promise<RowRef[]> {
  return withDb(databaseUrl, async (sql) => {
    const out: RowRef[] = [];
    const audit = await sql<{ id: string; actor: boolean; subject: boolean }[]>`
      select id::text as id, coalesce(actor_id = ${userId}::uuid, false) as actor, subject_id = ${userId} as subject
        from audit_log where actor_id = ${userId}::uuid or subject_id = ${userId}`;
    for (const r of audit) {
      out.push({
        table: "audit_log",
        id: r.id,
        refs: [...(r.actor ? ["actor_id"] : []), ...(r.subject ? ["subject_id"] : [])],
      });
    }
    for (const [table, columns] of await historyUuidColumns(sql)) {
      const cond = columns.map((c) => `${quoteIdent(c)} = $1::uuid`).join(" or ");
      const flags = columns.map((c) => `coalesce(${quoteIdent(c)} = $1::uuid, false) as ${quoteIdent(c)}`).join(", ");
      const rows = await sql.unsafe<Record<string, unknown>[]>(
        `select id::text as id, ${flags} from public.${quoteIdent(table)} where ${cond}`,
        [userId],
      );
      for (const r of rows) {
        out.push({ table, id: String(r.id), refs: columns.filter((c) => r[c] === true) });
      }
    }
    return out;
  });
}

/** uuid columns of every `*_history` table that has an `id` primary key column. */
async function historyUuidColumns(sql: Sql): Promise<Map<string, string[]>> {
  const cols = await sql<{ table_name: string; column_name: string }[]>`
    select c.table_name, c.column_name from information_schema.columns c
     where c.table_schema = 'public' and c.data_type = 'uuid' and c.table_name like '%\\_history'
       and c.column_name <> 'id'
       and exists (select 1 from information_schema.columns i
                    where i.table_schema = 'public' and i.table_name = c.table_name and i.column_name = 'id')
     order by c.table_name, c.ordinal_position`;
  const byTable = new Map<string, string[]>();
  for (const c of cols) {
    if (!isHistoryTable(c.table_name) || !IDENT.test(c.column_name)) continue;
    byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
  }
  return byTable;
}

// ---------------------------------------------------------------- webhook delivery fixture

/** The outbox `channel.tip` event of a named (non-anonymous) tip by the user with this message. */
export async function tipEventId(databaseUrl: string, userId: string, message: string): Promise<string | null> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<{ id: string }[]>`
      select id::text as id from events
       where type = 'channel.tip' and payload->>'user_id' = ${userId} and payload->>'message' = ${message}
       order by occurred_at desc limit 1`;
    return r?.id ?? null;
  });
}

/**
 * A webhook delivery log row for an outbox event, as the worker writes one when a receiver echoes
 * the payload back (`response_body`). The public subscribe API is not implemented yet, so the
 * scenario seeds a revoked subscription of the broadcaster (never fanned out to) and one delivery
 * row; the deletion must remove it with the event. Returns the delivery id.
 */
export async function seedWebhookDelivery(
  databaseUrl: string,
  input: { subscriberId: string; eventId: string; responseBody: string },
): Promise<{ subscriptionId: string; deliveryId: string }> {
  return withDb(databaseUrl, async (sql) => {
    const subscriptionId = uuidv7();
    const deliveryId = uuidv7();
    await sql.begin(async (tx) => {
      await tx`
        insert into event_subscriptions (id, user_id, type, version, condition, transport, callback_url, secret_ciphertext, status)
        values (${subscriptionId}, ${input.subscriberId}, 'channel.tip', '1',
                ${JSON.stringify({ broadcaster_user_id: input.subscriberId })}::jsonb, 'webhook',
                'http://harness.invalid/webhook', 'harness-fixture-never-delivered', 'revoked')`;
      await tx`
        insert into webhook_deliveries (id, subscription_id, event_id, message_id, status, response_status, response_body)
        values (${deliveryId}, ${subscriptionId}, ${input.eventId}, ${uuidv7()}, 'succeeded', 200, ${input.responseBody})`;
    });
    return { subscriptionId, deliveryId };
  });
}

export async function webhookDeliveryExists(databaseUrl: string, deliveryId: string): Promise<boolean> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<{ n: string }[]>`select count(*)::text as n from webhook_deliveries where id = ${deliveryId}`;
    return Number(r?.n ?? 0) > 0;
  });
}

/** Drop the seeded subscription (its delivery rows cascade). */
export async function dropSubscription(databaseUrl: string, subscriptionId: string): Promise<void> {
  await withDb(databaseUrl, async (sql) => {
    await sql`delete from event_subscriptions where id = ${subscriptionId}`;
  });
}

// ---------------------------------------------------------------- outbox scan

/** Outbox rows whose payload contains `value` (case-sensitive). Returns a count, never rows. */
export async function eventsContaining(databaseUrl: string, value: string, since?: Date): Promise<number> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<{ n: string }[]>`
      select count(*)::text as n from events
       where strpos(payload::text, ${value}) > 0
         and ${since ? sql`occurred_at >= ${since.toISOString()}::timestamptz` : sql`true`}`;
    return Number(r?.n ?? 0);
  });
}

// ---------------------------------------------------------------- secrets the export scan looks for

export interface UserSecrets {
  sessionTokens: string[];
  passwordHashes: string[];
  /** OAuth access/refresh/id tokens of linked providers (usually none on the harness stack). */
  providerTokens: string[];
}

/** The users' secret values, in memory only, for "no file contains …" scans. Never report these. */
export async function userSecrets(databaseUrl: string, userIds: readonly string[]): Promise<UserSecrets> {
  if (userIds.length === 0) return { sessionTokens: [], passwordHashes: [], providerTokens: [] };
  return withDb(databaseUrl, async (sql) => {
    const ids = [...userIds];
    const sessions = await sql<{ token: string }[]>`select token from sessions where user_id in ${sql(ids)}`;
    const accounts = await sql<
      {
        password: string | null;
        access_token: string | null;
        refresh_token: string | null;
        id_token: string | null;
      }[]
    >`select password, access_token, refresh_token, id_token from accounts where user_id in ${sql(ids)}`;
    const present = (v: string | null): v is string => typeof v === "string" && v.length > 0;
    return {
      sessionTokens: sessions.map((s) => s.token).filter(present),
      passwordHashes: accounts.map((a) => a.password).filter(present),
      providerTokens: accounts.flatMap((a) => [a.access_token, a.refresh_token, a.id_token]).filter(present),
    };
  });
}

/**
 * The stored forms of a user's channel and developer secrets (in memory only, never reported):
 * stream-key hashes, overlay-token hashes, simulcast key ciphertexts and the access/refresh token
 * hashes of the user and the bots they own. An archive must hold none of them.
 */
export async function storedSecrets(
  databaseUrl: string,
  userId: string,
): Promise<{
  streamKeyHashes: string[];
  overlayTokenHashes: string[];
  simulcastCiphertexts: string[];
  tokenHashes: string[];
}> {
  return withDb(databaseUrl, async (sql) => {
    const keys = await sql<{ v: string }[]>`
      select k.key_hash as v from stream_keys k join channels c on c.id = k.channel_id where c.owner_id = ${userId}`;
    const overlay = await sql<{ v: string }[]>`
      select o.token_hash as v from overlay_tokens o join channels c on c.id = o.channel_id where c.owner_id = ${userId}`;
    const simulcast = await sql<{ v: string }[]>`
      select t.stream_key_ciphertext as v from simulcast_targets t join channels c on c.id = t.channel_id
       where c.owner_id = ${userId}`;
    const tokens = await sql<{ a: string; r: string | null }[]>`
      select access_token_hash as a, refresh_token_hash as r from oauth_tokens
       where user_id = ${userId} or user_id in (select id from users where bot_owner_id = ${userId})`;
    const present = (v: string | null | undefined): v is string => typeof v === "string" && v.length > 0;
    return {
      streamKeyHashes: keys.map((r) => r.v).filter(present),
      overlayTokenHashes: overlay.map((r) => r.v).filter(present),
      simulcastCiphertexts: simulcast.map((r) => r.v).filter(present),
      tokenHashes: tokens.flatMap((r) => [r.a, r.r]).filter(present),
    };
  });
}

// ---------------------------------------------------------------- account deletion

export interface IdentityState {
  exists: boolean;
  /** `deleted_` + hex (only the shape is reported, never the value). */
  usernamePseudonymized: boolean;
  /** True when the email column still contains the original address or its local part (any case). */
  emailKept: boolean;
  /** The email is exactly the pseudonym placeholder (`deleted_<hex>@deleted.invalid`). */
  emailDeletedPlaceholder: boolean;
  /** True when `name` or `display_username` still contains the original display name or username. */
  nameKept: boolean;
  sessions: number;
  accounts: number;
  exports: number;
}

/** Does `stored` still hold the original email or its local part (case-insensitive)? */
export function emailRetained(stored: string, originalEmail: string): boolean {
  const s = stored.toLowerCase();
  const email = originalEmail.toLowerCase();
  const local = email.split("@")[0] ?? "";
  return s.includes(email) || (local.length >= 4 && s.includes(local));
}

/** Does any stored name field still contain one of the original names (case-insensitive)? */
export function nameRetained(stored: readonly (string | null)[], originals: readonly string[]): boolean {
  const names = originals.map((o) => o.trim().toLowerCase()).filter((o) => o.length >= 4);
  return stored.some((v) => v !== null && names.some((n) => v.toLowerCase().includes(n)));
}

export const DELETED_EMAIL = /^deleted_[0-9a-f]+@deleted\.invalid$/;

export async function identityState(
  databaseUrl: string,
  userId: string,
  original: { email: string; username: string; displayName: string },
): Promise<IdentityState> {
  return withDb(databaseUrl, async (sql) => {
    const [u] = await sql<{ username: string; email: string; name: string; display_username: string | null }[]>`
      select username, email, name, display_username from users where id = ${userId}`;
    const [s] = await sql<{ n: string }[]>`select count(*)::text as n from sessions where user_id = ${userId}`;
    const [a] = await sql<{ n: string }[]>`select count(*)::text as n from accounts where user_id = ${userId}`;
    const [e] = await sql<{ n: string }[]>`select count(*)::text as n from data_exports where user_id = ${userId}`;
    return {
      exists: u !== undefined,
      // The pseudonymized username is not personal data (`deleted_` + hex); only its shape is reported.
      usernamePseudonymized: u !== undefined && /^deleted_[0-9a-f]+$/.test(u.username),
      emailKept: u !== undefined && emailRetained(u.email, original.email),
      emailDeletedPlaceholder: u !== undefined && DELETED_EMAIL.test(u.email),
      nameKept:
        u !== undefined && nameRetained([u.name, u.display_username], [original.displayName, original.username]),
      sessions: Number(s?.n ?? 0),
      accounts: Number(a?.n ?? 0),
      exports: Number(e?.n ?? 0),
    };
  });
}

/** Payments the user made (ids), oldest first. */
export async function paymentsOf(databaseUrl: string, userId: string): Promise<{ id: string; kind: string }[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ id: string; kind: string }[]>`
      select id::text as id, kind::text as kind from payments where user_id = ${userId} order by created_at`;
    return rows;
  });
}

/** Tables named `<something>_history` in the public schema. */
export function isHistoryTable(name: string): boolean {
  return /^[a-z][a-z0-9_]*_history$/.test(name);
}

/**
 * The retained tables the deletion PII scan covers (spec step 5): `ledger_*`, `payments`, `tips`,
 * `audit_log`, every `*_history` table, `events` and `webhook_deliveries`.
 */
export function isPiiScanTable(name: string): boolean {
  return (
    /^ledger_[a-z0-9_]+$/.test(name) ||
    ["payments", "tips", "audit_log", "events", "webhook_deliveries"].includes(name) ||
    isHistoryTable(name)
  );
}

/** Column types the scan reads (text, varchar, json, jsonb, text arrays). */
export const SCANNED_TYPES = ["text", "character varying", "json", "jsonb", "ARRAY"] as const;

export interface PiiNeedle {
  label: string;
  value: string;
}

export interface PiiHit {
  table: string;
  label: string;
  rows: number;
}

/**
 * Search every text/json column of the retained tables for each needle (case-insensitive
 * substring). Returns where something was found, by table and label; never the matched text.
 */
export async function piiScan(
  databaseUrl: string,
  needles: readonly PiiNeedle[],
): Promise<{ tables: number; columns: number; hits: PiiHit[] }> {
  const usable = needles.filter((n) => n.value.trim().length >= 4);
  return withDb(databaseUrl, async (sql) => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      select c.table_name, c.column_name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and c.data_type in ${sql([...SCANNED_TYPES])}
       order by c.table_name, c.ordinal_position`;
    const byTable = new Map<string, string[]>();
    for (const c of cols) {
      if (!isPiiScanTable(c.table_name) || !IDENT.test(c.column_name)) continue;
      byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
    }
    const hits: PiiHit[] = [];
    let columns = 0;
    for (const [table, list] of byTable) {
      columns += list.length;
      const text = list.map((c) => `coalesce(${quoteIdent(c)}::text, '')`).join(" || chr(31) || ");
      for (const n of usable) {
        const [r] = await sql.unsafe<{ n: string }[]>(
          `select count(*)::text as n from public.${quoteIdent(table)} where strpos(lower(${text}), $1) > 0`,
          [n.value.toLowerCase()],
        );
        const rows = Number(r?.n ?? 0);
        if (rows > 0) hits.push({ table, label: n.label, rows });
      }
    }
    return { tables: byTable.size, columns, hits };
  });
}
