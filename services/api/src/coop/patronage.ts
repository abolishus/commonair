// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Patronage (docs/testing/e5-selectors.md "Patronage", ADR 0020): a treasurer runs a period (the
 * ledger closes for exactly that period, then `computePeriod`), someone else approves it (the
 * allocation posts), and members read their statements. Run and approve are each one transaction
 * with their audit row and event; the period trigger refuses an approval by the person who ran it.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Executor, schema } from "@commonair/db";
import { PeriodCloseError, closePeriod, loadMoneySettings } from "@commonair/ledger";
import {
  PatronagePeriodOverlapError,
  PatronagePeriodStateError,
  SecondApproverError,
  SurplusUnavailableError,
  approvePeriod,
  availableSurplusCents,
  computePeriod,
} from "@commonair/patronage";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { apiError, badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { withCoopErrors } from "./errors.ts";
import { STAFF, money } from "./shared.ts";

const { patronagePeriods, patronageAllocations, patronageInputs, users } = schema;
type PeriodRow = typeof patronagePeriods.$inferSelect;

/** Patronage library refusals as contract errors (the overlap check sits before the state check). */
function mapPatronageError(err: unknown): never {
  if (err instanceof SurplusUnavailableError)
    throw precondition("surplus", "There is not enough retained surplus for that distribution");
  if (err instanceof SecondApproverError)
    throw apiError("FORBIDDEN", "Someone other than the person who ran it must approve", {
      reason: "second_approver",
    });
  if (err instanceof PatronagePeriodOverlapError) throw conflict("The period overlaps another patronage period");
  if (err instanceof PatronagePeriodStateError) throw conflict("This patronage period is not open to that change");
  if (err instanceof PeriodCloseError) throw conflict("The period overlaps a period already closed in the ledger");
  throw err;
}

async function totals(db: Executor, periodIds: readonly string[]) {
  if (periodIds.length === 0) return new Map<string, { total: number; members: number }>();
  const [alloc, inputs] = await Promise.all([
    db
      .select({
        periodId: patronageAllocations.periodId,
        total: sql<string>`coalesce(sum(${patronageAllocations.amountCents}), 0)::text`,
      })
      .from(patronageAllocations)
      .where(inArray(patronageAllocations.periodId, [...periodIds]))
      .groupBy(patronageAllocations.periodId),
    db
      .select({ periodId: patronageInputs.periodId, n: sql<string>`count(*)::text` })
      .from(patronageInputs)
      .where(inArray(patronageInputs.periodId, [...periodIds]))
      .groupBy(patronageInputs.periodId),
  ]);
  const out = new Map<string, { total: number; members: number }>();
  for (const id of periodIds) out.set(id, { total: 0, members: 0 });
  for (const a of alloc) out.set(a.periodId, { ...(out.get(a.periodId) ?? { members: 0 }), total: Number(a.total) });
  for (const i of inputs) out.set(i.periodId, { ...(out.get(i.periodId) ?? { total: 0 }), members: Number(i.n) });
  return out;
}

async function statementOf(db: Executor, period: PeriodRow, userId: string) {
  const [[alloc], [inputs]] = await Promise.all([
    db
      .select()
      .from(patronageAllocations)
      .where(and(eq(patronageAllocations.periodId, period.id), eq(patronageAllocations.userId, userId))),
    db
      .select()
      .from(patronageInputs)
      .where(and(eq(patronageInputs.periodId, period.id), eq(patronageInputs.userId, userId))),
  ]);
  if (!alloc && !inputs) return null;
  return {
    periodId: period.id,
    periodStart: iso(period.periodStart),
    periodEnd: iso(period.periodEnd),
    status: period.status,
    formulaVersion: period.formulaVersion,
    weights: period.weights,
    surplus: money(period.surplusCents, period.currency),
    total: money(alloc?.amountCents ?? 0, period.currency),
    lines: alloc?.lines ?? [],
    inputs: {
      revenueCents: inputs?.revenueCents ?? 0,
      eligibleStreamingHours: inputs?.eligibleStreamingHours ?? 0,
      relayBytesVerified: inputs?.relayBytesVerified ?? 0,
      viewerHoursVerified: inputs?.viewerHoursVerified ?? 0,
      viewerHoursExcluded: inputs?.viewerHoursExcluded ?? 0,
    },
  };
}

const PUBLISHED = ["approved", "distributed"] as const;

export const patronageHandlers = {
  run: os.coop.patronage.run.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    const now = deps.now();
    if (!(periodStart < periodEnd)) throw badRequest("The period must start before it ends");
    if (periodEnd.getTime() > now.getTime()) throw badRequest("The period must have ended");
    return withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const { payoutRules } = await loadMoneySettings(tx);
        const currency = payoutRules.currency;
        try {
          // Idempotent for the same period; an overlap with another closed period is refused.
          await closePeriod(tx, { periodStart, periodEnd, currency });
          const available = await availableSurplusCents(tx, { periodStart, periodEnd, currency });
          const surplusCents = input.surplusCents ?? available;
          const r = await computePeriod(tx, {
            periodStart,
            periodEnd,
            surplusCents,
            currency,
            computedById: caller.user.id,
          });
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: "patronage.run",
            subjectType: "patronage_period",
            subjectId: r.periodId,
            details: {
              periodId: r.periodId,
              surplusCents,
              totalCents: r.totalCents,
              retainedCents: r.retainedCents,
              members: r.members,
            },
          });
          await emit(
            tx,
            "coop.patronage.update",
            null,
            { period_id: r.periodId, status: "computed", total_cents: r.totalCents, members: r.members },
            now,
          );
          return {
            periodId: r.periodId,
            members: r.members,
            total: money(r.totalCents, currency),
            surplus: money(surplusCents, currency),
          };
        } catch (err) {
          return mapPatronageError(err);
        }
      }),
    );
  }),

  approve: os.coop.patronage.approve.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        const [period] = await tx
          .select({ id: patronagePeriods.id, status: patronagePeriods.status })
          .from(patronagePeriods)
          .where(eq(patronagePeriods.id, input.periodId));
        if (!period) throw notFound("Patronage period not found");
        if (period.status !== "computed") throw conflict(`This period is ${period.status}, not computed`);
        try {
          // approvePeriod locks the period and refuses the person who ran it (as does the trigger).
          const r = await approvePeriod(tx, { periodId: period.id, approvedById: caller.user.id, at: now });
          if (!r.approvedNow) throw conflict("This period was already approved");
          const members = (await totals(tx, [period.id])).get(period.id)?.members ?? 0;
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: "patronage.approve",
            subjectType: "patronage_period",
            subjectId: period.id,
            details: { periodId: period.id, totalCents: r.totalCents, ledgerTransactionId: r.ledgerTransactionId },
          });
          await emit(
            tx,
            "coop.patronage.update",
            null,
            { period_id: period.id, status: "approved", total_cents: r.totalCents, members },
            now,
          );
        } catch (err) {
          return mapPatronageError(err);
        }
      }),
    );
    return { ok: true as const };
  }),

  periods: os.coop.patronage.periods.handler(async ({ context }) => {
    const { db } = context.deps;
    const rows = await db.select().from(patronagePeriods).orderBy(desc(patronagePeriods.periodEnd)).limit(200);
    const ids = [
      ...new Set(rows.flatMap((r) => [r.computedById, r.approvedById]).filter((x): x is string => x !== null)),
    ];
    const people = new Map(
      ids.length
        ? (await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))).map(
            (u) => [u.id, u],
          )
        : [],
    );
    const sums = await totals(
      db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      periodStart: iso(r.periodStart),
      periodEnd: iso(r.periodEnd),
      status: r.status,
      formulaVersion: r.formulaVersion,
      surplus: money(r.surplusCents, r.currency),
      total: money(sums.get(r.id)?.total ?? 0, r.currency),
      retained: money(r.retainedCents, r.currency),
      members: sums.get(r.id)?.members ?? 0,
      computedAt: isoOrNull(r.computedAt),
      computedBy: r.computedById ? (people.get(r.computedById) ?? null) : null,
      approvedAt: isoOrNull(r.approvedAt),
      approvedBy: r.approvedById ? (people.get(r.approvedById) ?? null) : null,
    }));
  }),

  statements: os.coop.patronage.statements.handler(async ({ context }) => {
    const { db } = context.deps;
    const caller = requireCaller(context);
    const rows = await db
      .select()
      .from(patronagePeriods)
      .where(
        and(
          inArray(patronagePeriods.status, [...PUBLISHED]),
          sql`(exists (select 1 from patronage_allocations a where a.period_id = ${patronagePeriods.id} and a.user_id = ${caller.user.id})
            or exists (select 1 from patronage_inputs i where i.period_id = ${patronagePeriods.id} and i.user_id = ${caller.user.id}))`,
        ),
      )
      .orderBy(desc(patronagePeriods.periodEnd))
      .limit(120);
    const out = [];
    for (const p of rows) {
      const s = await statementOf(db, p, caller.user.id);
      if (s) out.push(s);
    }
    return out;
  }),

  statement: os.coop.patronage.statement.handler(async ({ context, input }) => {
    const { db } = context.deps;
    const caller = requireCaller(context);
    const [p] = await db.select().from(patronagePeriods).where(eq(patronagePeriods.id, input.periodId));
    // Unpublished periods and periods without the caller do not exist for them.
    if (!p || !(PUBLISHED as readonly string[]).includes(p.status)) throw notFound("Statement not found");
    const s = await statementOf(db, p, caller.user.id);
    if (!s) throw notFound("Statement not found");
    return s;
  }),
};
