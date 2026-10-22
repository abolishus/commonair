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
import { createDb } from "@commonair/db";
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

export async function vodRow(databaseUrl: string, vodId: string): Promise<MediaRow> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<
      { status: string; removed_reason: string | null; storage_prefix: string; thumbnail_key: string | null }[]
    >`select status::text as status, removed_reason, storage_prefix, thumbnail_key from vods where id = ${vodId}`;
    return {
      status: r?.status ?? null,
      removedReason: r?.removed_reason ?? null,
      storage: r?.storage_prefix ?? null,
      thumbnailKey: r?.thumbnail_key ?? null,
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

/** Audit rows naming the user as actor or subject. */
export async function auditRowsReferencing(databaseUrl: string, userId: string): Promise<number> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_log where actor_id = ${userId} or subject_id = ${userId}`;
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

// ---------------------------------------------------------------- account deletion

export interface IdentityState {
  exists: boolean;
  /** `deleted_` + hex (only the shape is reported, never the value). */
  usernamePseudonymized: boolean;
  /** True when the email column still equals the original (case-insensitive). */
  emailKept: boolean;
  emailDeletedPlaceholder: boolean;
  sessions: number;
  accounts: number;
  exports: number;
}

export async function identityState(
  databaseUrl: string,
  userId: string,
  originalEmail: string,
): Promise<IdentityState> {
  return withDb(databaseUrl, async (sql) => {
    const [u] = await sql<{ username: string; email: string }[]>`
      select username, email from users where id = ${userId}`;
    const [s] = await sql<{ n: string }[]>`select count(*)::text as n from sessions where user_id = ${userId}`;
    const [a] = await sql<{ n: string }[]>`select count(*)::text as n from accounts where user_id = ${userId}`;
    const [e] = await sql<{ n: string }[]>`select count(*)::text as n from data_exports where user_id = ${userId}`;
    return {
      exists: u !== undefined,
      // The pseudonymized username is not personal data (`deleted_` + hex); only its shape is reported.
      usernamePseudonymized: u !== undefined && /^deleted_[0-9a-f]+$/.test(u.username),
      emailKept: u !== undefined && u.email.toLowerCase() === originalEmail.toLowerCase(),
      emailDeletedPlaceholder: u !== undefined && u.email.endsWith("@deleted.invalid"),
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

/** Rows per `*_history` table that reference the user's id in any uuid column. */
export async function historyRefCounts(databaseUrl: string, userId: string): Promise<Record<string, number>> {
  return withDb(databaseUrl, async (sql) => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type = 'uuid' and table_name like '%\\_history'
       order by table_name, ordinal_position`;
    const byTable = new Map<string, string[]>();
    for (const c of cols) {
      if (!isHistoryTable(c.table_name) || !IDENT.test(c.column_name)) continue;
      byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
    }
    const out: Record<string, number> = {};
    for (const [table, columns] of byTable) {
      const cond = columns.map((c) => `${quoteIdent(c)} = $1::uuid`).join(" or ");
      const [r] = await sql.unsafe<{ n: string }[]>(
        `select count(*)::text as n from public.${quoteIdent(table)} where ${cond}`,
        [userId],
      );
      out[table] = Number(r?.n ?? 0);
    }
    return out;
  });
}

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
