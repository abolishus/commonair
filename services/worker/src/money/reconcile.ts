// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Nightly reconciliation (feature-wins §4.1): for every payment whose ledger postings changed
 * since the last run, the breakdown a payer or creator is shown must agree with the money that
 * actually moved through the payment's settlement account. A mismatch (or postings the breakdown
 * cannot read) is counted and logged with the payment id and the two totals only.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { schema } from "@commonair/db";
import {
  BreakdownError,
  type BreakdownTransaction,
  breakdownSettlement,
  buildBreakdown,
  settlementMovement,
} from "@commonair/ledger";
import { meter } from "@commonair/observability";
import type { WorkerContext } from "../context.ts";

/** Valkey key of the last run's high-water mark (an ISO timestamp of `ledger_transactions.created_at`). */
export const RECONCILE_CURSOR_KEY = "worker:money:reconcile:cursor";
/** With no cursor yet, check the payments whose postings changed in this many days. */
export const RECONCILE_FIRST_RUN_DAYS = 35;
/** Re-check this much before the last run's start, so a posting that committed late is never skipped. */
export const RECONCILE_OVERLAP_MS = 10 * 60_000;
/** Payments per batch (one read of their rows and one of their postings). */
export const RECONCILE_BATCH = 200;

const m = meter("commonair.worker");
/** Reconciliation instruments (no-ops until telemetry is initialised). No ids in labels. */
export const reconcileMetrics = {
  checked: m.createCounter("worker.money.reconcile.payments", {
    description: "Payments whose breakdown was checked against the ledger",
  }),
  mismatches: m.createCounter("worker.money.reconcile.mismatches", {
    description: "Payments whose breakdown disagrees with their settlement postings, by reason",
  }),
};

export interface ReconcileResult {
  payments: number;
  mismatches: number;
}

const { ledgerTransactions: lt, ledgerEntries: le, ledgerAccounts: la, payments } = schema;

/** The payment ids with a posting created after `since`, after `after` in id order. */
async function changedPayments(ctx: WorkerContext, since: Date, after: string | null): Promise<string[]> {
  const rows = await ctx.db
    .selectDistinct({ id: lt.refId })
    .from(lt)
    .where(
      and(eq(lt.refType, "payment"), gt(lt.createdAt, since), after ? sql`${lt.refId} > ${after}::uuid` : undefined),
    )
    .orderBy(asc(lt.refId))
    .limit(RECONCILE_BATCH);
  return rows.map((r) => r.id).filter((id): id is string => id !== null);
}

async function checkBatch(ctx: WorkerContext, ids: readonly string[]): Promise<number> {
  const [rows, entries] = await Promise.all([
    ctx.db
      .select({ id: payments.id, kind: payments.kind, currency: payments.currency, succeededAt: payments.succeededAt })
      .from(payments)
      .where(inArray(payments.id, [...ids])),
    ctx.db
      .select({
        id: lt.id,
        refId: lt.refId,
        kind: lt.kind,
        occurredAt: lt.occurredAt,
        metadata: lt.metadata,
        code: la.code,
        amountCents: le.amountCents,
      })
      .from(lt)
      .innerJoin(le, eq(le.transactionId, lt.id))
      .innerJoin(la, eq(la.id, le.accountId))
      .where(and(eq(lt.refType, "payment"), inArray(lt.refId, [...ids]))),
  ]);
  const txs = new Map<
    string,
    Map<string, BreakdownTransaction & { entries: { code: string; amountCents: number }[] }>
  >();
  for (const e of entries) {
    if (!e.refId) continue;
    const byId = txs.get(e.refId) ?? new Map();
    txs.set(e.refId, byId);
    const tx = byId.get(e.id) ?? {
      id: e.id,
      kind: e.kind,
      occurredAt: e.occurredAt,
      metadata: e.metadata,
      entries: [],
    };
    byId.set(e.id, tx);
    tx.entries.push({ code: e.code, amountCents: e.amountCents });
  }
  const byPayment = new Map(rows.map((r) => [r.id, r]));
  let mismatches = 0;
  for (const id of ids) {
    const p = byPayment.get(id);
    const list = [...(txs.get(id)?.values() ?? [])];
    try {
      if (!p) throw new BreakdownError("no payments row");
      // The hold date plays no part in the comparison.
      const b = buildBreakdown({ id, kind: p.kind, currency: p.currency, succeededAt: p.succeededAt }, list, 0);
      const ledger = settlementMovement(list);
      const shown = breakdownSettlement(b);
      if (shown !== ledger) {
        mismatches += 1;
        reconcileMetrics.mismatches.add(1, { reason: "amount" });
        ctx.logger.error("payment breakdown disagrees with the ledger", {
          paymentId: id,
          breakdownCents: shown,
          ledgerCents: ledger,
        });
      }
    } catch (err) {
      if (!(err instanceof BreakdownError)) throw err;
      mismatches += 1;
      reconcileMetrics.mismatches.add(1, { reason: "unreadable" });
      ctx.logger.error("payment breakdown cannot be built", { paymentId: id, error: err.message });
    }
  }
  reconcileMetrics.checked.add(ids.length);
  return mismatches;
}

/** One reconciliation run. Advances the cursor only after every changed payment was checked. */
export async function reconcilePayments(ctx: WorkerContext): Promise<ReconcileResult> {
  const [clock] = await ctx.db.execute<{ now: string | Date }>(sql`select now() as now`);
  // The database's clock, as `created_at` is: the worker's may be skewed (or pinned in tests).
  const startedAt = new Date(clock?.now ?? Date.now());
  const stored = await ctx.valkey.get(RECONCILE_CURSOR_KEY);
  const parsed = stored ? new Date(stored) : null;
  const since =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed
      : new Date(startedAt.getTime() - RECONCILE_FIRST_RUN_DAYS * 86_400_000);

  let checked = 0;
  let mismatches = 0;
  let after: string | null = null;
  for (;;) {
    const ids = await changedPayments(ctx, since, after);
    if (ids.length === 0) break;
    mismatches += await checkBatch(ctx, ids);
    checked += ids.length;
    after = ids[ids.length - 1] ?? null;
    if (ids.length < RECONCILE_BATCH) break;
  }
  await ctx.valkey.set(RECONCILE_CURSOR_KEY, new Date(startedAt.getTime() - RECONCILE_OVERLAP_MS).toISOString());
  if (checked > 0) ctx.logger.info("reconciled payment breakdowns", { payments: checked, mismatches });
  return { payments: checked, mismatches };
}
