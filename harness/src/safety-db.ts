// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `trust-safety` scenario's database touches, all with `DATABASE_URL` (the stack's owner
 * connection, as the operator CLI uses): read-only state checks the API does not expose
 * (pseudonymization, `account_deletions.retained`, clip `removed_reason`, audit actions, the local
 * block list), and the app-role refusal checks of step 2.
 *
 * The refusal checks run `SET LOCAL ROLE <app role>` inside a transaction that is **always rolled
 * back**, so even if the database ever accepted a delete, no evidence, hold or draft would be lost.
 * Nothing here reads evidence bytes, snapshots or personal data into the report.
 */
import { createDb } from "@commonair/db";

/** The tables whose rows the app role must never be able to delete (migration 0016). */
export const PROTECTED_TABLES = ["evidence_objects", "legal_holds", "ncmec_reports"] as const;
export type ProtectedTable = (typeof PROTECTED_TABLES)[number];

/** The application role compose and `infra/postgres/app-role.sql` create. */
export const DEFAULT_APP_ROLE = "commonair_app";

const ROLLBACK = Symbol("rollback");

async function withDb<T>(databaseUrl: string, fn: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

export interface RefusalResult {
  table: ProtectedTable;
  /** True when the database refused the delete. */
  refused: boolean;
  /** Rows the delete would have removed when it was not refused (rolled back either way). */
  rowCount: number;
  /** The database's error message when refused (no row data). */
  message: string | null;
}

/**
 * Try to delete one protected row as the app role; always rolled back. Throws (instead of
 * reporting a refusal) when the role switch itself fails, so a misconfigured check never passes.
 */
export async function appRoleDeleteRefused(
  databaseUrl: string,
  table: ProtectedTable,
  id: string,
  appRole = DEFAULT_APP_ROLE,
): Promise<RefusalResult> {
  if (!(PROTECTED_TABLES as readonly string[]).includes(table)) throw new Error(`not a protected table: ${table}`);
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`bad role name: ${appRole}`);
  return withDb(databaseUrl, async (sql) => {
    let result: RefusalResult | null = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${appRole}`);
        const [who] = await tx<{ current_user: string }[]>`select current_user`;
        if (who?.current_user !== appRole) throw new Error(`could not act as ${appRole} (got ${who?.current_user})`);
        await tx.unsafe("savepoint attempt");
        try {
          const deleted = await tx.unsafe(`delete from public.${table} where id = $1`, [id]);
          result = { table, refused: false, rowCount: deleted.count, message: null };
        } catch (err) {
          await tx.unsafe("rollback to savepoint attempt");
          result = { table, refused: true, rowCount: 0, message: err instanceof Error ? err.message : String(err) };
        }
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    if (!result) throw new Error("refusal check did not run");
    return result;
  });
}

export interface DeletionState {
  pseudonymizedAt: string | null;
  deletedAt: string | null;
  /** The username column no longer holds the original username. */
  usernameReplaced: boolean;
  deletionStatus: string | null;
  retained: { table: string; reason: string; rows: number }[];
}

export async function deletionState(
  databaseUrl: string,
  userId: string,
  originalUsername: string,
): Promise<DeletionState> {
  return withDb(databaseUrl, async (sql) => {
    const [u] = await sql<{ pseudonymized_at: Date | null; deleted_at: Date | null; username: string | null }[]>`
      select pseudonymized_at, deleted_at, username from users where id = ${userId}`;
    const [d] = await sql<{ status: string; retained: { table: string; reason: string; rows: number }[] }[]>`
      select status::text as status, retained from account_deletions
       where user_id = ${userId} order by requested_at desc limit 1`;
    return {
      pseudonymizedAt: u?.pseudonymized_at?.toISOString() ?? null,
      deletedAt: u?.deleted_at?.toISOString() ?? null,
      usernameReplaced: u !== undefined && u.username !== originalUsername,
      deletionStatus: d?.status ?? null,
      retained: d?.retained ?? [],
    };
  });
}

export async function userBanned(
  databaseUrl: string,
  userId: string,
): Promise<{ banned: boolean; banReason: string | null }> {
  return withDb(databaseUrl, async (sql) => {
    const [u] = await sql<{ banned: boolean; ban_reason: string | null }[]>`
      select banned, ban_reason from users where id = ${userId}`;
    return { banned: u?.banned ?? false, banReason: u?.ban_reason ?? null };
  });
}

export async function clipState(
  databaseUrl: string,
  clipId: string,
): Promise<{ status: string | null; removedReason: string | null }> {
  return withDb(databaseUrl, async (sql) => {
    const [c] = await sql<{ status: string; removed_reason: string | null }[]>`
      select status::text as status, removed_reason from clips where id = ${clipId}`;
    return { status: c?.status ?? null, removedReason: c?.removed_reason ?? null };
  });
}

/** Audit actions (and actor types) recorded about any of the subject ids, oldest first. */
export async function auditActions(
  databaseUrl: string,
  subjectIds: readonly string[],
): Promise<{ action: string; actorType: string }[]> {
  if (subjectIds.length === 0) return [];
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ action: string; actor_type: string }[]>`
      select action, actor_type::text as actor_type from audit_log
       where subject_id in ${sql([...subjectIds])} order by created_at`;
    return rows.map((r) => ({ action: r.action, actorType: r.actor_type }));
  });
}

/** Active local block-list entries added from one source (an NCII request or a case). */
export async function localHashCount(
  databaseUrl: string,
  sourceId: string,
  category: "csam" | "ncii",
): Promise<number> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<{ n: string }[]>`
      select count(*)::text as n from local_hash_list
       where source_id = ${sourceId} and category = ${category} and revoked_at is null`;
    return Number(r?.n ?? 0);
  });
}

/** T0 cases of a user (any status), newest first: `{ id, status }`. */
export async function t0CasesOf(databaseUrl: string, userId: string): Promise<{ id: string; status: string }[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ id: string; status: string }[]>`
      select id::text as id, status::text as status from moderation_cases
       where user_id = ${userId} and tier = 't0' order by created_at desc`;
    return rows;
  });
}
