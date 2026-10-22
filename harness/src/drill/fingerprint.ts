// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a restore must bring back (docs/testing/e6-selectors.md, "Backup and restore drill"):
 * every non-internal trigger with its enabled state, full definition (timing, events,
 * deferrability) and the function it runs; the protection functions (`commonair_*`: md5 of the
 * full definition incl. SECURITY DEFINER, SET search_path and volatility, plus owner); the app
 * role's table and column grants, attributes, memberships and TEMP right; per-table row counts
 * and an ordered digest of `ledger_entries`, plus every ledger transaction that does not sum to zero. `collectFingerprint`
 * reads it from a database; `compareFingerprints` is pure and decides the drill.
 */
import type { DbHandle } from "@commonair/db";

type Sql = DbHandle["sql"];

export interface TriggerFact {
  table: string;
  name: string;
  /** `pg_trigger.tgenabled`: O (origin), D (disabled), R (replica), A (always). */
  enabled: string;
  /** md5 of `pg_get_triggerdef`: timing, events, deferrability, condition, function. */
  def: string;
  /** The function it runs, `tgfoid::regprocedure` (schema-qualified unless on the search path). */
  fn: string;
}

export interface FunctionFact {
  name: string;
  /** Identity arguments, so overloads are told apart. */
  args: string;
  /** md5 of `pg_get_functiondef`: body, SECURITY DEFINER, SET search_path, volatility. */
  md5: string;
  owner: string;
  securityDefiner: boolean;
  /** `proconfig` (e.g. `search_path=pg_catalog, public, pg_temp`), null when none. */
  config: string | null;
}

export interface ColumnGrantFact {
  table: string;
  column: string;
  privilege: string;
}

/** The app role as app-role.sql leaves it: powerless outside its grants (ADR 0004). */
export interface RoleFact {
  exists: boolean;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDb: boolean;
  replication: boolean;
  bypassRls: boolean;
  /** Roles the app role is a member of (must be none: SET ROLE would escape every grant). */
  memberOf: string[];
  /** Column-level privileges (`information_schema.column_privileges`). */
  columnGrants: ColumnGrantFact[];
  /** TEMP on the database (revoked: the search_path shadowing vector). */
  temp: boolean;
}

export interface GrantFact {
  table: string;
  privilege: string;
}

export interface LedgerEntryRow {
  id: string;
  transactionId: string;
  accountId: string;
  amountCents: string;
  currency: string;
  memo: string | null;
  /** Microseconds since the epoch, as text (no time-zone rendering in the digest). */
  createdAtUs: string;
}

export interface Imbalance {
  transactionId: string;
  currency: string;
  sumCents: string;
}

export interface Fingerprint {
  triggers: TriggerFact[];
  functions: FunctionFact[];
  grants: GrantFact[];
  role: RoleFact;
  rowCounts: Record<string, number>;
  ledgerTransactionIds: string[];
  /** Ordered md5 of the ledger entries (see `ledgerDigest`), without `digestExcludes`' transactions. */
  ledgerDigest: string;
  digestExcludes: string[];
  ledgerEntryCount: number;
  imbalances: Imbalance[];
}

/**
 * Protections the drill insists on before trusting a fingerprint at all, so a broken query that
 * returns nothing on both sides can never compare equal (ADR 0004 / migration 0001).
 */
export const REQUIRED_TRIGGERS: readonly (readonly [table: string, name: string, fn: string])[] = [
  ["ledger_entries", "ledger_entries_append_only", "commonair_forbid_mutation"],
  ["ledger_entries", "ledger_entries_balanced", "commonair_ledger_entry_balance_check"],
  ["ledger_transactions", "ledger_transactions_append_only", "commonair_forbid_mutation"],
  ["ledger_transactions", "ledger_transactions_balanced", "commonair_ledger_balance_check"],
  ["audit_log", "audit_log_append_only", "commonair_forbid_mutation"],
  ["proposals", "proposals_guard", "commonair_proposal_guard"],
  ["votes", "votes_guard", "commonair_vote_guard"],
];
export const REQUIRED_FUNCTIONS: readonly string[] = [
  "commonair_forbid_mutation",
  "commonair_ledger_balance_check",
  "commonair_ledger_entry_balance_check",
  "commonair_proposal_guard",
  "commonair_vote_guard",
];
/** Tables the app role must hold no UPDATE on, not even on a single column. */
export const APPEND_ONLY_TABLES: readonly string[] = ["ledger_entries", "ledger_transactions", "audit_log"];

/** `public.f()` and `f()` name the same function (regprocedure drops a visible schema). */
const normalizeFn = (fn: string) => fn.replace(/^public\./, "");
export const REQUIRED_GRANTS: readonly GrantFact[] = [
  { table: "ledger_entries", privilege: "INSERT" },
  { table: "ledger_entries", privilege: "SELECT" },
  { table: "audit_log", privilege: "INSERT" },
];

/** Ordered md5 over the entries (sorted by id here, whatever order they arrive in). */
export function ledgerDigest(rows: readonly LedgerEntryRow[], exclude: ReadonlySet<string> = new Set()): string {
  const lines = rows
    .filter((r) => !exclude.has(r.transactionId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) =>
      [r.id, r.transactionId, r.accountId, r.amountCents, r.currency, r.memo ?? "\\N", r.createdAtUs].join("|"),
    );
  return new Bun.CryptoHasher("md5").update(lines.join("\n")).digest("hex");
}

/** Facts that must be present in a fingerprint taken right after migration (empty = fine). */
export function missingRequired(fp: Pick<Fingerprint, "triggers" | "functions" | "grants" | "role">): string[] {
  const problems: string[] = [];
  for (const [table, name, fn] of REQUIRED_TRIGGERS) {
    const t = fp.triggers.find((x) => x.table === table && x.name === name);
    if (!t) problems.push(`trigger ${table}.${name} is missing`);
    else {
      if (t.enabled === "D") problems.push(`trigger ${table}.${name} is disabled`);
      if (normalizeFn(t.fn) !== `${fn}()`) problems.push(`trigger ${table}.${name} runs ${t.fn}, not ${fn}()`);
    }
  }
  for (const name of REQUIRED_FUNCTIONS) {
    const f = fp.functions.find((x) => x.name === name);
    if (!f) problems.push(`function ${name} is missing`);
    else if (!f.config?.includes("search_path=")) problems.push(`function ${name} has no pinned search_path`);
  }
  problems.push(...roleProblems(fp.role));
  for (const g of REQUIRED_GRANTS) {
    if (!fp.grants.some((x) => x.table === g.table && x.privilege === g.privilege)) {
      problems.push(`app role lacks ${g.privilege} on ${g.table}`);
    }
  }
  return problems;
}

/** Ways the app role could escape its grants (empty = as app-role.sql leaves it). Pure. */
export function roleProblems(role: RoleFact): string[] {
  if (!role.exists) return ["app role does not exist"];
  const problems: string[] = [];
  const attrs = [
    ["superuser", role.superuser],
    ["inherit", role.inherit],
    ["createrole", role.createRole],
    ["createdb", role.createDb],
    ["replication", role.replication],
    ["bypassrls", role.bypassRls],
  ] as const;
  for (const [attr, on] of attrs) if (on) problems.push(`app role has ${attr.toUpperCase()}`);
  for (const r of role.memberOf) problems.push(`app role is a member of ${r}`);
  if (role.temp) problems.push("app role can create temporary tables");
  for (const g of role.columnGrants) {
    if (g.privilege === "UPDATE" && APPEND_ONLY_TABLES.includes(g.table)) {
      problems.push(`app role holds UPDATE on ${g.table}.${g.column}`);
    }
  }
  return problems;
}

/** What the WAL-replay marker added after the base backup. */
export interface Marker {
  transactionId: string;
  entries: number;
}

const key = {
  trigger: (t: TriggerFact) => `${t.table}.${t.name}`,
  fn: (f: FunctionFact) => `${f.name}(${f.args})`,
  grant: (g: GrantFact) => `${g.privilege} on ${g.table}`,
  column: (g: ColumnGrantFact) => `${g.privilege} on ${g.table}.${g.column}`,
};

/** Fields of matching items that changed between the two sides, as problems. */
function diffFields<T extends object>(
  label: string,
  before: readonly T[],
  after: readonly T[],
  id: (t: T) => string,
  fields: readonly (keyof T & string)[],
): string[] {
  const was = new Map(before.map((t) => [id(t), t]));
  const problems: string[] = [];
  for (const t of after) {
    const b = was.get(id(t));
    if (b === undefined) continue;
    for (const f of fields) {
      if (b[f] !== t[f]) problems.push(`${label} ${id(t)} ${f} changed: ${String(b[f])} → ${String(t[f])}`);
    }
  }
  return problems;
}

function diffSets<T>(label: string, before: readonly T[], after: readonly T[], id: (t: T) => string): string[] {
  const a = new Set(before.map(id));
  const b = new Set(after.map(id));
  return [
    ...[...a].filter((x) => !b.has(x)).map((x) => `${label} ${x} missing after restore`),
    ...[...b].filter((x) => !a.has(x)).map((x) => `${label} ${x} appeared after restore`),
  ];
}

/**
 * Every way `after` (the restored database) differs from `before` (taken before the backup) plus
 * the marker. Empty means the restore is faithful. Pure.
 */
export function compareFingerprints(before: Fingerprint, after: Fingerprint, marker: Marker): string[] {
  const problems: string[] = [];
  problems.push(...missingRequired(before).map((p) => `before backup: ${p}`));
  problems.push(...missingRequired(after).map((p) => `after restore: ${p}`));

  problems.push(...diffSets("trigger", before.triggers, after.triggers, key.trigger));
  const enabledBefore = new Map(before.triggers.map((t) => [key.trigger(t), t.enabled]));
  for (const t of after.triggers) {
    const was = enabledBefore.get(key.trigger(t));
    if (was !== undefined && was !== t.enabled) {
      problems.push(`trigger ${key.trigger(t)} enabled state ${was} → ${t.enabled}`);
    }
  }
  problems.push(...diffFields("trigger", before.triggers, after.triggers, key.trigger, ["fn"]));
  const defBefore = new Map(before.triggers.map((t) => [key.trigger(t), t.def]));
  for (const t of after.triggers) {
    const was = defBefore.get(key.trigger(t));
    if (was !== undefined && was !== t.def) problems.push(`trigger ${key.trigger(t)} definition changed`);
  }

  problems.push(...diffSets("function", before.functions, after.functions, key.fn));
  const bodyBefore = new Map(before.functions.map((f) => [key.fn(f), f.md5]));
  for (const f of after.functions) {
    const was = bodyBefore.get(key.fn(f));
    if (was !== undefined && was !== f.md5) problems.push(`function ${key.fn(f)} body changed`);
  }
  problems.push(
    ...diffFields("function", before.functions, after.functions, key.fn, ["owner", "securityDefiner", "config"]),
  );

  problems.push(...diffSets("grant", before.grants, after.grants, key.grant));
  problems.push(...diffSets("column grant", before.role.columnGrants, after.role.columnGrants, key.column));
  const roleFlags = [
    "exists",
    "superuser",
    "inherit",
    "createRole",
    "createDb",
    "replication",
    "bypassRls",
    "temp",
  ] as const;
  for (const f of roleFlags) {
    if (before.role[f] !== after.role[f]) problems.push(`app role ${f} changed: ${before.role[f]} → ${after.role[f]}`);
  }
  problems.push(...diffSets("app role membership", before.role.memberOf, after.role.memberOf, (r) => r));

  // Row counts: equal everywhere except the marker's ledger rows.
  const expected: Record<string, number> = { ...before.rowCounts };
  expected.ledger_transactions = (expected.ledger_transactions ?? 0) + 1;
  expected.ledger_entries = (expected.ledger_entries ?? 0) + marker.entries;
  for (const table of new Set([...Object.keys(expected), ...Object.keys(after.rowCounts)])) {
    const want = expected[table];
    const got = after.rowCounts[table];
    if (want !== got) problems.push(`table ${table}: ${String(got)} rows after restore, expected ${String(want)}`);
  }

  if (before.ledgerTransactionIds.includes(marker.transactionId)) {
    problems.push("the WAL-replay marker was already in the backup");
  }
  if (!after.ledgerTransactionIds.includes(marker.transactionId)) {
    problems.push("the WAL-replay marker transaction is missing: WAL after the base backup was not replayed");
  }
  const lostTx = before.ledgerTransactionIds.filter((id) => !after.ledgerTransactionIds.includes(id));
  if (lostTx.length > 0) problems.push(`${lostTx.length} ledger transaction(s) lost in the restore`);
  if (!after.digestExcludes.includes(marker.transactionId)) {
    problems.push("the after-restore ledger digest was taken with the marker included");
  } else if (after.ledgerDigest !== before.ledgerDigest) {
    problems.push("ledger_entries differ from the backup (ordered md5, marker excluded)");
  }

  if (before.imbalances.length > 0)
    problems.push(`before backup: ${before.imbalances.length} unbalanced transaction(s)`);
  for (const i of after.imbalances) {
    problems.push(`ledger transaction ${i.transactionId} sums to ${i.sumCents} ${i.currency} after restore`);
  }
  return problems;
}

// ------------------------------------------------------------------------------------- queries

/** Base tables of `public` whose rows are counted (everything but Drizzle's own bookkeeping). */
const TABLES_SQL = `
  select c.relname as name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
   order by 1`;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Read a fingerprint. `sql` must be able to read every table (the owner); `appRole` names the
 * grantee; `digestExcludes` leaves those ledger transactions (the marker) out of the digest.
 */
export async function collectFingerprint(
  sql: Sql,
  appRole: string,
  digestExcludes: readonly string[] = [],
): Promise<Fingerprint> {
  const triggers = await sql<TriggerFact[]>`
    select c.relname as "table", t.tgname as name, t.tgenabled::text as enabled,
           md5(pg_catalog.pg_get_triggerdef(t.oid)) as def, t.tgfoid::regprocedure::text as fn
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = 'public'
     order by 1, 2`;
  const functions = await sql<FunctionFact[]>`
    select p.proname as name, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
           case when p.prokind in ('f', 'p') then md5(pg_catalog.pg_get_functiondef(p.oid)) else md5(p.prosrc) end as md5,
           p.proowner::regrole::text as owner, p.prosecdef as "securityDefiner",
           array_to_string(p.proconfig, ';') as config
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'commonair\\_%'
     order by 1, 2`;
  const grants = await sql<GrantFact[]>`
    select table_name as "table", privilege_type as privilege
      from information_schema.role_table_grants
     where grantee = ${appRole} and table_schema = 'public'
     order by 1, 2`;
  const role = await roleFact(sql, appRole);
  const tables = await sql.unsafe<{ name: string }[]>(TABLES_SQL);
  const rowCounts: Record<string, number> = {};
  for (const { name } of tables) {
    if (name.startsWith("__drizzle")) continue;
    const [row] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from public.${quoteIdent(name)}`);
    rowCounts[name] = Number(row?.n ?? 0);
  }
  const entries = await ledgerEntryRows(sql);
  const txIds = await sql<{ id: string }[]>`select id::text as id from ledger_transactions order by id`;
  const imbalances = await sql<Imbalance[]>`
    select transaction_id::text as "transactionId", currency, sum(amount_cents)::text as "sumCents"
      from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0
     order by 1, 2`;
  return {
    triggers: [...triggers],
    functions: [...functions],
    grants: [...grants],
    role,
    rowCounts,
    ledgerTransactionIds: txIds.map((r) => r.id),
    ledgerDigest: ledgerDigest(entries, new Set(digestExcludes)),
    digestExcludes: [...digestExcludes],
    ledgerEntryCount: entries.length,
    imbalances: [...imbalances],
  };
}

async function roleFact(sql: Sql, appRole: string): Promise<RoleFact> {
  const [r] = await sql<
    {
      superuser: boolean;
      inherit: boolean;
      createRole: boolean;
      createDb: boolean;
      replication: boolean;
      bypassRls: boolean;
    }[]
  >`
    select rolsuper as superuser, rolinherit as inherit, rolcreaterole as "createRole",
           rolcreatedb as "createDb", rolreplication as replication, rolbypassrls as "bypassRls"
      from pg_catalog.pg_roles where rolname = ${appRole}`;
  if (!r) {
    return {
      exists: false,
      superuser: false,
      inherit: false,
      createRole: false,
      createDb: false,
      replication: false,
      bypassRls: false,
      memberOf: [],
      columnGrants: [],
      temp: false,
    };
  }
  const memberOf = await sql<{ name: string }[]>`
    select g.rolname as name
      from pg_catalog.pg_auth_members am
      join pg_catalog.pg_roles g on g.oid = am.roleid
      join pg_catalog.pg_roles u on u.oid = am.member
     where u.rolname = ${appRole}
     order by 1`;
  const columnGrants = await sql<ColumnGrantFact[]>`
    select table_name as "table", column_name as "column", privilege_type as privilege
      from information_schema.column_privileges
     where grantee = ${appRole} and table_schema = 'public'
     order by 1, 2, 3`;
  const [t] = await sql<{ temp: boolean }[]>`
    select pg_catalog.has_database_privilege(${appRole}, current_database(), 'TEMP') as temp`;
  return {
    exists: true,
    ...r,
    memberOf: memberOf.map((m) => m.name),
    columnGrants: [...columnGrants],
    temp: t?.temp ?? true,
  };
}

export async function ledgerEntryRows(sql: Sql): Promise<LedgerEntryRow[]> {
  const rows = await sql<LedgerEntryRow[]>`
    select id::text as id, transaction_id::text as "transactionId", account_id::text as "accountId",
           amount_cents::text as "amountCents", currency, memo,
           ((extract(epoch from created_at) * 1000000)::bigint)::text as "createdAtUs"
      from ledger_entries order by id`;
  return [...rows];
}
