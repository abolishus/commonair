// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `e5-coop` scenario's database touches, all with `DATABASE_URL` (the stack's owner
 * connection, as the operator CLI uses). Everything is read-only except the protected-decision
 * refusal checks of step 5, which run `SET LOCAL ROLE <app role>` inside a transaction that is
 * **always rolled back**: even if the database ever accepted one of them, nothing would be kept.
 * Rows come back as ids, enums, numbers and JSON for the scenario's own checks; the report only
 * carries counts and the names of what is missing.
 */
import { createDb } from "@commonair/db";
import type { AuditRow, EventRow } from "./coop.ts";
import type { LedgerSumRow } from "./money.ts";
import { DEFAULT_APP_ROLE } from "./safety-db.ts";

export { DEFAULT_APP_ROLE };

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

export const PROTECTED_BYPASSES = ["proposal-passed", "tally-passed", "apply-change"] as const;
export type ProtectedBypass = (typeof PROTECTED_BYPASSES)[number];

export interface BypassResult {
  attempt: ProtectedBypass;
  /** True when the database refused the statement. */
  refused: boolean;
  /** Rows the statement changed when it was not refused (rolled back either way). */
  rowCount: number;
  /** SQLSTATE and message when refused (the trigger's text; no row data). */
  sqlState: string | null;
  message: string | null;
}

export interface BypassInput {
  /** The rejected protected proposal. */
  proposalId: string;
  /** Its `tallies.breakdown` as recorded (so only `passed` differs in the forged row). */
  breakdown: unknown;
  /** The setting its change targets and the value it would set. */
  settingKey: string;
  value: unknown;
}

function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Try, as the app role, to record the rejected protected proposal as passed, to insert a `tallies`
 * row with `passed = true`, and to apply its change; each in a savepoint of one transaction that
 * is always rolled back. Throws (instead of reporting a refusal) when the role switch fails, so a
 * misconfigured check never passes.
 */
export async function protectedBypassRefusals(
  databaseUrl: string,
  input: BypassInput,
  appRole = DEFAULT_APP_ROLE,
): Promise<BypassResult[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`bad role name: ${appRole}`);
  return withDb(databaseUrl, async (sql) => {
    const results: BypassResult[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${appRole}`);
        const [who] = await tx<{ current_user: string }[]>`select current_user`;
        if (who?.current_user !== appRole) throw new Error(`could not act as ${appRole} (got ${who?.current_user})`);
        const attempt = async (name: ProtectedBypass, text: string, params: unknown[]) => {
          await tx.unsafe("savepoint attempt");
          try {
            const r = await tx.unsafe(text, params as never[]);
            results.push({ attempt: name, refused: false, rowCount: r.count, sqlState: null, message: null });
          } catch (err) {
            await tx.unsafe("rollback to savepoint attempt");
            results.push({
              attempt: name,
              refused: true,
              rowCount: 0,
              sqlState: errorCode(err),
              message: err instanceof Error ? err.message.slice(0, 200) : String(err),
            });
          }
        };
        await attempt("proposal-passed", "update public.proposals set status = 'passed' where id = $1", [
          input.proposalId,
        ]);
        await attempt(
          "tally-passed",
          "insert into public.tallies (proposal_id, breakdown, passed, reason) values ($1, $2::jsonb, true, 'passed')",
          [input.proposalId, JSON.stringify(input.breakdown ?? {})],
        );
        await attempt(
          "apply-change",
          "update public.governance_settings set value = $1::jsonb, updated_by_proposal_id = $2 where key = $3",
          [JSON.stringify(input.value), input.proposalId, input.settingKey],
        );
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    if (results.length !== PROTECTED_BYPASSES.length) throw new Error("bypass checks did not all run");
    return results;
  });
}

/** One governance setting as stored (value and the proposal that last set it). */
export async function settingRow(
  databaseUrl: string,
  key: string,
): Promise<{ value: unknown; updatedByProposalId: string | null } | null> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<{ value: unknown; updated_by_proposal_id: string | null }[]>`
      select value, updated_by_proposal_id::text as updated_by_proposal_id
        from governance_settings where key = ${key}`;
    return r ? { value: r.value, updatedByProposalId: r.updated_by_proposal_id } : null;
  });
}

/**
 * Active streamer members in good standing: the council candidates, as `recomputeCouncil`
 * selects them (`packages/governance/src/council.ts`). User ids only.
 */
export async function activeStreamerMembers(databaseUrl: string): Promise<string[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ user_id: string }[]>`
      select distinct m.user_id::text as user_id
        from memberships m join users u on u.id = m.user_id
       where m.class = 'streamer' and m.status = 'active' and u.deleted_at is null and u.banned = false`;
    return rows.map((r) => r.user_id);
  });
}

export interface CoopLedgerQuery {
  /** `ledger_transactions.ref_id` values: shares, payments, the patronage period. */
  refIds: readonly string[];
  /** The patronage period whose `period_close` transaction to include. */
  period?: { start: string; end: string; currency: string };
}

type SumRow = {
  transaction_id: string;
  ref_id: string | null;
  kind: string;
  idempotency_key: string;
  currency: string;
  sum: string;
};

const toLedgerRow = (r: SumRow): LedgerSumRow => ({
  transactionId: r.transaction_id,
  refId: r.ref_id,
  kind: r.kind,
  idempotencyKey: r.idempotency_key,
  currency: r.currency,
  sum: r.sum,
});

/** Per-transaction, per-currency entry sums of the run's co-op postings, with each transaction's kind. */
export async function coopLedgerSums(databaseUrl: string, q: CoopLedgerQuery): Promise<LedgerSumRow[]> {
  const ids = [...new Set(q.refIds)];
  return withDb(databaseUrl, async (sql) => {
    const out: LedgerSumRow[] = [];
    if (ids.length > 0) {
      const rows = await sql<SumRow[]>`
        select t.id::text as transaction_id, t.ref_id::text as ref_id, t.kind,
               t.idempotency_key, e.currency, sum(e.amount_cents)::text as sum
          from ledger_transactions t
          join ledger_entries e on e.transaction_id = t.id
         where t.ref_id::text in ${sql(ids)}
         group by t.id, t.ref_id, t.kind, t.idempotency_key, e.currency
         order by t.id`;
      out.push(...rows.map(toLedgerRow));
    }
    const period = q.period;
    if (period) {
      const rows = await sql<SumRow[]>`
        select t.id::text as transaction_id, t.ref_id::text as ref_id, t.kind,
               t.idempotency_key, e.currency, sum(e.amount_cents)::text as sum
          from ledger_transactions t
          join ledger_entries e on e.transaction_id = t.id
         where t.kind = 'period_close' and t.metadata->>'currency' = ${period.currency}
           and (t.metadata->>'periodStart')::timestamptz = ${period.start}::timestamptz
           and (t.metadata->>'periodEnd')::timestamptz = ${period.end}::timestamptz
         group by t.id, t.ref_id, t.kind, t.idempotency_key, e.currency
         order by t.id`;
      out.push(...rows.map(toLedgerRow));
    }
    return out;
  });
}

/** Co-op audit rows written since `since` (instance-wide; the scenario filters by its own ids). */
export async function coopAuditRows(databaseUrl: string, since: Date): Promise<AuditRow[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<
      {
        action: string;
        actor_type: string;
        actor_id: string | null;
        subject_type: string;
        subject_id: string;
        details: unknown;
      }[]
    >`
      select action, actor_type::text as actor_type, actor_id::text as actor_id, subject_type, subject_id, details
        from audit_log
       where created_at >= ${since.toISOString()}::timestamptz
         and (action like 'coop.%' or action like 'membership.%' or action like 'proposal.%'
              or action like 'council.%' or action like 'patronage.%' or action like 'election.%'
              or action = 'payment.confirm')
       order by created_at`;
    return rows.map((r) => ({
      action: r.action,
      actorType: r.actor_type,
      actorId: r.actor_id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      details: r.details,
    }));
  });
}

/** Co-op outbox events written since `since` (instance-wide). */
export async function coopEventRows(databaseUrl: string, since: Date): Promise<EventRow[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ type: string; payload: unknown }[]>`
      select type, payload from events
       where occurred_at >= ${since.toISOString()}::timestamptz and type like 'coop.%'
       order by occurred_at`;
    return rows.map((r) => ({ type: r.type, payload: r.payload }));
  });
}
