// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `e4b-money` scenario's two database touches, both with `DATABASE_URL`: granting the
 * treasurer role through the operator CLI (as an operator would; the CLI writes the audit row),
 * and a read-only check that every ledger transaction referencing the scenario's payments and
 * their disputes balances to zero per currency.
 */
import { fileURLToPath } from "node:url";
import { createDb } from "@commonair/db";
import type { LedgerSumRow } from "./money.ts";
import { spawnSupervised } from "./process.ts";
import { withTimeout } from "./wait.ts";

/** The repository root (the CLI runs from there, like `bun run --filter @commonair/db role`). */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ROLE_CLI = "packages/db/src/roles/cli.ts";

export function roleCliCommand(username: string, role: string, bun = process.execPath): string[] {
  return [bun, ROLE_CLI, username, role];
}

/** Run the operator role CLI; resolves with its stdout, rejects with its stderr on a non-zero exit. */
export async function grantRole(
  databaseUrl: string,
  username: string,
  role: string,
  timeoutMs = 30_000,
): Promise<string> {
  const out: string[] = [];
  const proc = spawnSupervised(roleCliCommand(username, role), {
    name: "role-cli",
    cwd: REPO_ROOT,
    env: { DATABASE_URL: databaseUrl },
    stopSignal: "SIGTERM",
    onStdoutLine: (line) => out.push(line),
  });
  let code: number;
  try {
    code = await withTimeout(`role CLI (${role})`, proc.exited, timeoutMs);
  } catch (err) {
    await proc.stop(500);
    throw err;
  }
  if (code !== 0) throw new Error(`role CLI exited ${code}: ${proc.stderr().join(" | ")}`);
  return out.join("\n");
}

export interface LedgerCheck {
  rows: LedgerSumRow[];
  disputes: { id: string; paymentId: string; kind: string }[];
}

/** Per-transaction, per-currency entry sums for the payments' and their disputes' transactions. */
export async function ledgerSums(databaseUrl: string, paymentIds: readonly string[]): Promise<LedgerCheck> {
  if (paymentIds.length === 0) return { rows: [], disputes: [] };
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  const { sql } = handle;
  try {
    const ids = [...paymentIds];
    const disputes = await sql<{ id: string; payment_id: string; kind: string }[]>`
      select d.id::text as id, d.payment_id::text as payment_id, d.kind::text as kind
        from disputes d
       where d.payment_id::text in ${sql(ids)}`;
    const refs = [...ids, ...disputes.map((d) => d.id)];
    const rows = await sql<
      { transaction_id: string; ref_id: string | null; kind: string; currency: string; sum: string }[]
    >`
      select t.id::text as transaction_id, t.ref_id::text as ref_id, t.kind, e.currency,
             sum(e.amount_cents)::text as sum
        from ledger_transactions t
        join ledger_entries e on e.transaction_id = t.id
       where t.ref_id::text in ${sql(refs)}
       group by t.id, t.ref_id, t.kind, e.currency
       order by t.id`;
    return {
      rows: rows.map((r) => ({
        transactionId: r.transaction_id,
        refId: r.ref_id,
        kind: r.kind,
        currency: r.currency,
        sum: r.sum,
      })),
      disputes: disputes.map((d) => ({ id: d.id, paymentId: d.payment_id, kind: d.kind })),
    };
  } finally {
    await handle.close();
  }
}
