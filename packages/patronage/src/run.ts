// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { PatronageWeights } from "@commonair/contracts/shapes";
import { type Executor, schema } from "@commonair/db";
import { assertCents, assertCurrency, patronageAllocation, post, retainedSurplus } from "@commonair/ledger";
import { type AllocationResult, getFormula } from "./formula.ts";
import { collectInputs, eligibleMembers } from "./inputs.ts";

export const PatronageFormulaSetting = z.object({ version: z.string().min(1), weights: PatronageWeights });
export type PatronageFormulaSetting = z.infer<typeof PatronageFormulaSetting>;

/** The `patronage.formula` governance setting. */
export async function loadPatronageFormula(db: Executor): Promise<PatronageFormulaSetting> {
  const [row] = await db
    .select({ value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, "patronage.formula"));
  if (!row) throw new Error("governance setting patronage.formula must be seeded");
  return PatronageFormulaSetting.parse(row.value);
}

export class PatronagePeriodStateError extends Error {
  override name = "PatronagePeriodStateError";
}
/** The period overlaps another computed or approved period: members would be paid twice. */
export class PatronagePeriodOverlapError extends PatronagePeriodStateError {
  override name = "PatronagePeriodOverlapError";
}
/** The ledger's retained surplus cannot cover the requested distribution. */
export class SurplusUnavailableError extends PatronagePeriodStateError {
  override name = "SurplusUnavailableError";
}

/** Serializes period computation and approval (overlap and surplus checks read, then write). */
async function lockPeriods(tx: Executor): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('patronage:periods'))`);
}

async function assertNoOverlap(
  tx: Executor,
  opts: { periodStart: Date; periodEnd: Date; currency: string },
  selfId: string | null,
): Promise<void> {
  const rows = await tx.execute<{ id: string; status: string }>(sql`
    select id, status from patronage_periods
    where currency = ${opts.currency} and status <> 'draft'
      and period_start < ${opts.periodEnd.toISOString()}::timestamptz
      and period_end > ${opts.periodStart.toISOString()}::timestamptz
      ${selfId ? sql`and id <> ${selfId}` : sql``}
    limit 1`);
  const clash = rows[0];
  if (clash) throw new PatronagePeriodOverlapError(`period overlaps ${clash.status} patronage period ${clash.id}`);
}

/**
 * The surplus to distribute must be held in the ledger: retained surplus (after period
 * closes), less what other computed-but-unapproved periods already intend to distribute.
 */
async function assertSurplusAvailable(
  tx: Executor,
  currency: string,
  surplusCents: number,
  selfId: string | null,
): Promise<void> {
  if (surplusCents === 0) return;
  const held = await retainedSurplus(tx, currency);
  const rows = await tx.execute<{ total: string }>(sql`
    select coalesce(sum(surplus_cents), 0)::text as total from patronage_periods
    where currency = ${currency} and status = 'computed' ${selfId ? sql`and id <> ${selfId}` : sql``}`);
  const available = held - Number(rows[0]?.total ?? 0);
  if (surplusCents > available) {
    throw new SurplusUnavailableError(
      `surplus of ${surplusCents} exceeds the ${available} cents of retained surplus available in ${currency}`,
    );
  }
}

export interface ComputeOptions {
  periodStart: Date;
  periodEnd: Date;
  surplusCents: number;
  currency: string;
  /** Defaults to the `patronage.formula` setting; tests and what-if previews may pass one. */
  formula?: PatronageFormulaSetting;
}

export interface ComputeResult {
  periodId: string;
  members: number;
  totalCents: number;
  retainedCents: number;
  result: AllocationResult;
}

const CHUNK = 1000;

/**
 * Compute (or recompute) a period: snapshot the formula version and weights, gather inputs
 * for every eligible member, allocate, and write `patronage_periods` (status computed),
 * `patronage_inputs` and `patronage_allocations` in one transaction. A period that was
 * already approved is never recomputed.
 */
export async function computePeriod(db: Executor, opts: ComputeOptions): Promise<ComputeResult> {
  assertCents("surplus", opts.surplusCents);
  assertCurrency(opts.currency);
  if (!(opts.periodStart < opts.periodEnd)) throw new RangeError("periodStart must be before periodEnd");
  const period = { start: opts.periodStart, end: opts.periodEnd };

  return db.transaction(async (tx) => {
    await lockPeriods(tx);
    const [existing] = await tx
      .select()
      .from(schema.patronagePeriods)
      .where(
        and(
          eq(schema.patronagePeriods.periodStart, opts.periodStart),
          eq(schema.patronagePeriods.periodEnd, opts.periodEnd),
        ),
      )
      .for("update");
    if (existing && existing.status !== "draft" && existing.status !== "computed") {
      throw new PatronagePeriodStateError(`patronage period ${existing.id} is ${existing.status}`);
    }
    if (existing && existing.currency !== opts.currency) {
      throw new PatronagePeriodStateError(`patronage period ${existing.id} is in ${existing.currency}`);
    }
    await assertNoOverlap(tx, opts, existing?.id ?? null);
    await assertSurplusAvailable(tx, opts.currency, opts.surplusCents, existing?.id ?? null);

    const setting = opts.formula ?? (await loadPatronageFormula(tx));
    const formula = getFormula(setting.version);
    const userIds = await eligibleMembers(tx, opts.periodEnd);
    const inputs = await collectInputs(tx, userIds, period, {
      currency: opts.currency,
      dailyStreamingHourCap: setting.weights.dailyStreamingHourCap,
    });
    const result = formula.allocate({
      surplusCents: opts.surplusCents,
      currency: opts.currency,
      weights: setting.weights,
      members: inputs,
    });

    const values = {
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      status: "computed" as const,
      formulaVersion: formula.version,
      weights: setting.weights,
      surplusCents: opts.surplusCents,
      retainedCents: result.retainedCents,
      retainedLines: result.retainedLines,
      currency: opts.currency,
      computedAt: new Date(),
    };
    let periodId: string;
    if (existing) {
      periodId = existing.id;
      await tx.update(schema.patronagePeriods).set(values).where(eq(schema.patronagePeriods.id, periodId));
      await tx.delete(schema.patronageAllocations).where(eq(schema.patronageAllocations.periodId, periodId));
      await tx.delete(schema.patronageInputs).where(eq(schema.patronageInputs.periodId, periodId));
    } else {
      const [row] = await tx
        .insert(schema.patronagePeriods)
        .values(values)
        .returning({ id: schema.patronagePeriods.id });
      if (!row) throw new Error("patronage period insert returned nothing");
      periodId = row.id;
    }

    for (let i = 0; i < inputs.length; i += CHUNK) {
      await tx.insert(schema.patronageInputs).values(inputs.slice(i, i + CHUNK).map((m) => ({ periodId, ...m })));
    }
    for (let i = 0; i < result.allocations.length; i += CHUNK) {
      await tx.insert(schema.patronageAllocations).values(
        result.allocations.slice(i, i + CHUNK).map((a) => ({
          periodId,
          userId: a.userId,
          amountCents: a.amountCents,
          lines: a.lines,
        })),
      );
    }
    const totalCents = result.allocations.reduce((s, a) => s + a.amountCents, 0);
    return { periodId, members: inputs.length, totalCents, retainedCents: result.retainedCents, result };
  });
}

export interface ApproveResult {
  /** Null when nothing was allocated (the whole surplus was retained). */
  ledgerTransactionId: string | null;
  totalCents: number;
  /** False when the period was already approved. */
  approvedNow: boolean;
}

/**
 * Approve a computed period: post the allocation (retained surplus → patronage payable per
 * member) and mark it approved, atomically. Idempotent: approving twice returns the first
 * result and the ledger posting is keyed by the period.
 */
export async function approvePeriod(
  db: Executor,
  opts: { periodId: string; approvedById: string; at?: Date },
): Promise<ApproveResult> {
  return db.transaction(async (tx) => {
    await lockPeriods(tx);
    const [period] = await tx
      .select()
      .from(schema.patronagePeriods)
      .where(eq(schema.patronagePeriods.id, opts.periodId))
      .for("update");
    if (!period) throw new PatronagePeriodStateError(`patronage period ${opts.periodId} not found`);
    const allocations = await tx
      .select({ userId: schema.patronageAllocations.userId, amountCents: schema.patronageAllocations.amountCents })
      .from(schema.patronageAllocations)
      .where(eq(schema.patronageAllocations.periodId, period.id))
      .orderBy(schema.patronageAllocations.userId);
    const totalCents = allocations.reduce((s, a) => s + a.amountCents, 0);
    if (period.status === "approved" || period.status === "distributed") {
      return { ledgerTransactionId: period.ledgerTransactionId, totalCents, approvedNow: false };
    }
    if (period.status !== "computed") {
      throw new PatronagePeriodStateError(`patronage period ${period.id} is ${period.status}; compute it first`);
    }
    if (totalCents > period.surplusCents) {
      throw new PatronagePeriodStateError(`allocations exceed the surplus of period ${period.id}`);
    }
    // Re-check against the ledger now: costs or other approvals may have reduced the surplus.
    const held = await retainedSurplus(tx, period.currency);
    if (totalCents > held) {
      throw new SurplusUnavailableError(`allocations of ${totalCents} exceed the retained surplus of ${held} cents`);
    }
    const at = opts.at ?? new Date();
    let ledgerTransactionId: string | null = null;
    if (totalCents > 0) {
      const r = await post(
        tx,
        patronageAllocation({ periodId: period.id, currency: period.currency, occurredAt: at, allocations }),
      );
      ledgerTransactionId = r.transactionId;
    }
    await tx
      .update(schema.patronagePeriods)
      .set({ status: "approved", approvedAt: at, approvedById: opts.approvedById, ledgerTransactionId })
      .where(eq(schema.patronagePeriods.id, period.id));
    return { ledgerTransactionId, totalCents, approvedNow: true };
  });
}
