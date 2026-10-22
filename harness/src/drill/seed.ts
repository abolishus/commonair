// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Drill data and the refusal checks. Everything here runs as the least-privilege app role, the
 * way the services do: the demo seed (its own CLI, as an operator would run it), balanced
 * ledger postings through `@commonair/ledger`, the WAL-replay marker, and the writes the
 * database must refuse after a restore.
 */
import { type DbHandle, createDb, uuidv7 } from "@commonair/db";
import { type Posting, accounts, post } from "@commonair/ledger";
import { fileURLToPath } from "node:url";
import type { Marker } from "./fingerprint.ts";

type Sql = DbHandle["sql"];
/** The transaction handle `sql.begin` passes (its last overload: options, callback). */
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Postings the drill seeds before the backup. */
export const DRILL_POSTINGS = 20;

/** One balanced posting: an infrastructure cost paid from the manual cash account. Pure. */
export function drillPosting(runId: string, label: string, amountCents: number, occurredAt: Date): Posting {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new RangeError("amountCents must be positive");
  return {
    kind: "infrastructure_cost",
    description: "restore drill posting",
    refType: null,
    refId: null,
    idempotencyKey: `restore-drill:${runId}:${label}`,
    currency: "usd",
    occurredAt,
    metadata: { drill: true },
    entries: [
      { code: accounts.infrastructure("restore-drill"), amountCents },
      { code: accounts.cash("manual"), amountCents: -amountCents },
    ],
  };
}

/** Amounts that vary (odd cents, growing), so a reordered or truncated restore changes the digest. */
export const drillAmount = (i: number): number => 101 + i * 37;

async function withDb<T>(url: string, fn: (h: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const h = createDb({ url, max: 1, applicationName: "commonair-drill" });
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

/** Post `count` balanced transactions as the app role; returns their ids. */
export function postDrillLedger(appUrl: string, runId: string, count = DRILL_POSTINGS): Promise<string[]> {
  return withDb(appUrl, async ({ db }) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = await post(db, drillPosting(runId, `seed-${i}`, drillAmount(i), new Date()));
      ids.push(r.transactionId);
    }
    return ids;
  });
}

/** Post the WAL-replay marker (after the base backup) as the app role. */
export function postMarker(appUrl: string, runId: string): Promise<Marker> {
  return withDb(appUrl, async ({ db }) => {
    const p = drillPosting(runId, "marker", 4_242, new Date());
    const r = await post(db, p);
    return { transactionId: r.transactionId, entries: p.entries.length };
  });
}

/** Run the demo seed CLI against `appUrl` (stdout is discarded: it lists demo accounts). */
export async function seedDemoAsAppRole(appUrl: string): Promise<void> {
  const proc = Bun.spawn(["bun", "packages/db/src/demo/cli.ts", "seed"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: appUrl,
      DEMO_SEED_PASSWORD: `drill-${crypto.randomUUID()}`,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`demo seed failed (${code}): ${err.trim().split("\n").slice(-3).join(" | ")}`);
}

export interface Refusal {
  name: string;
  refused: boolean;
  /** SQLSTATE of the refusal (null when not refused). */
  code: string | null;
  /** The database's message when refused, or why the check could not run. */
  detail: string;
}

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

/**
 * Every write the restored database must refuse to the app role (spec step 6), with the
 * SQLSTATEs and message that count as the protection refusing it. Anything else (a typo, a
 * missing column, a lost connection) is not a refusal: it would let the check pass with the
 * protection gone.
 */
export const REFUSAL_EXPECTATIONS = {
  "UPDATE ledger_entries": { codes: [INSUFFICIENT_PRIVILEGE], message: /permission denied|append-only/ },
  "DELETE ledger_entries": { codes: [INSUFFICIENT_PRIVILEGE], message: /permission denied|append-only/ },
  "UPDATE audit_log": { codes: [INSUFFICIENT_PRIVILEGE], message: /permission denied|append-only/ },
  "DELETE audit_log": { codes: [INSUFFICIENT_PRIVILEGE], message: /permission denied|append-only/ },
  "unbalanced posting": { codes: [CHECK_VIOLATION], message: /unbalanced/ },
  "INSERT proposals with status passed": { codes: [CHECK_VIOLATION], message: /start as drafts/ },
  "UPDATE proposals.status = passed": {
    codes: [CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE],
    message: /proposal|status/,
  },
} as const satisfies Record<string, { codes: readonly string[]; message: RegExp }>;

export type RefusalName = keyof typeof REFUSAL_EXPECTATIONS;
export const REFUSALS = Object.keys(REFUSAL_EXPECTATIONS) as RefusalName[];

class Rollback extends Error {}

const message = (err: unknown) => {
  const e = err as { message?: string };
  return (e.message ?? String(err)).split("\n")[0]?.slice(0, 200) ?? "";
};
const sqlState = (err: unknown): string | null => {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

/**
 * Attempt each refused write as the app role. `setup` runs first in the same transaction (it
 * must succeed, or the check is inconclusive); `attack` must fail. A write that succeeds is
 * rolled back, except the unbalanced posting, whose refusal comes at commit.
 */
async function attempt(
  sql: Sql,
  name: RefusalName,
  attack: (tx: Tx) => Promise<unknown>,
  setup?: (tx: Tx) => Promise<void>,
  refusedAtCommit = false,
): Promise<Refusal> {
  // An object, so the assignment inside the callback is visible to the narrowing below.
  const failed: { setup: string | null } = { setup: null };
  try {
    await sql.begin(async (tx) => {
      if (setup) {
        try {
          await setup(tx);
        } catch (err) {
          failed.setup = message(err);
          throw err;
        }
      }
      await attack(tx);
      if (!refusedAtCommit) throw new Rollback("write succeeded");
    });
    return { name, refused: false, code: null, detail: "the write was committed" };
  } catch (err) {
    if (failed.setup !== null) {
      return { name, refused: false, code: null, detail: `inconclusive: setup failed: ${failed.setup}` };
    }
    if (err instanceof Rollback)
      return { name, refused: false, code: null, detail: "the write succeeded (rolled back)" };
    return { name, refused: true, code: sqlState(err), detail: message(err) };
  }
}

export async function refusalChecks(appUrl: string): Promise<Refusal[]> {
  return withDb(appUrl, async ({ sql }) => {
    const oneEntry = sql`(select id from ledger_entries order by id limit 1)`;
    const oneAudit = sql`(select id from audit_log order by id limit 1)`;
    const results: Refusal[] = [];
    results.push(
      await attempt(
        sql,
        "UPDATE ledger_entries",
        (tx) => tx`update ledger_entries set memo = coalesce(memo, '') || 'x' where id = ${oneEntry}`,
      ),
    );
    results.push(
      await attempt(sql, "DELETE ledger_entries", (tx) => tx`delete from ledger_entries where id = ${oneEntry}`),
    );
    results.push(
      await attempt(
        sql,
        "UPDATE audit_log",
        (tx) => tx`update audit_log set reason = reason || 'x' where id = ${oneAudit}`,
      ),
    );
    results.push(await attempt(sql, "DELETE audit_log", (tx) => tx`delete from audit_log where id = ${oneAudit}`));
    results.push(
      await attempt(
        sql,
        "unbalanced posting",
        async (tx) => {
          const accountsUsd = await tx<{ id: string }[]>`
            select id from ledger_accounts where currency = 'usd' order by id limit 2`;
          const [a, b] = accountsUsd;
          if (!a || !b) throw new Error("no two usd ledger accounts to post to");
          const txId = uuidv7();
          await tx`insert into ledger_transactions (id, kind, description, occurred_at, idempotency_key)
                   values (${txId}, 'infrastructure_cost', 'restore drill: unbalanced', now(), ${`restore-drill:unbalanced:${txId}`})`;
          await tx`insert into ledger_entries (id, transaction_id, account_id, amount_cents, currency)
                   values (${uuidv7()}, ${txId}, ${a.id}, 100, 'usd'), (${uuidv7()}, ${txId}, ${b.id}, -99, 'usd')`;
        },
        undefined,
        true,
      ),
    );
    const author = sql`(select id from users order by id limit 1)`;
    results.push(
      await attempt(
        sql,
        "INSERT proposals with status passed",
        (tx) => tx`insert into proposals (id, author_id, title, body, kind, affects_creators, status)
                   values (${uuidv7()}, ${author}, 'restore drill', '', 'ordinary', false, 'passed')`,
      ),
    );
    const proposalId = uuidv7();
    results.push(
      await attempt(
        sql,
        "UPDATE proposals.status = passed",
        (tx) => tx`update proposals set status = 'passed' where id = ${proposalId}`,
        async (tx) => {
          const inserted = await tx`insert into proposals (id, author_id, title, body, kind, affects_creators)
                   values (${proposalId}, ${author}, 'restore drill', '', 'ordinary', false) returning id`;
          if (inserted.length !== 1) throw new Error("draft proposal not inserted");
        },
      ),
    );
    return results;
  });
}

/**
 * Problems with a set of refusal results: anything not refused, refused for another reason than
 * the protection (wrong SQLSTATE or message), or not attempted. Pure.
 */
export function refusalProblems(results: readonly Refusal[]): string[] {
  const problems: string[] = [];
  for (const name of REFUSALS) {
    const r = results.find((x) => x.name === name);
    const want = REFUSAL_EXPECTATIONS[name];
    if (!r) problems.push(`${name}: not attempted`);
    else if (!r.refused) problems.push(`${name}: ${r.detail}`);
    else if (r.code === null || !(want.codes as readonly string[]).includes(r.code) || !want.message.test(r.detail)) {
      problems.push(`${name}: refused for another reason (${r.code ?? "no SQLSTATE"}: ${r.detail})`);
    }
  }
  return problems;
}
