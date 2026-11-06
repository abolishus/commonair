// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Paying approved patronage out (batch 8, M1-coop-money; ADR 0020): `coop.patronage.payouts` and
 * `coop.patronage.pay`, the manual mark-paid, a member's own payout, and Connect transfer events
 * for a patronage payout.
 *
 * - **Two approvers, as for write-offs.** The first `pay` records a request (`patronage.pay_request`
 *   audit row); a second treasurer, or an admin, approves it (`patronage.pay_approve`) and the same
 *   transaction opens one `patronage_payouts` row per member with a positive allocation. The
 *   requester cannot approve their own request. A repeat after approval changes nothing, except
 *   that a member whose last row failed or was reversed and who is still owed gets a new row (the
 *   unique index covers `pending` and `paid` only, so it never makes a second open row).
 * - **Manual first.** A row is `pending` until a treasurer marks it `paid` with their reference.
 *   That posts `patronagePayout` (Dr the member's patronage payable, Cr `cash:manual`), keyed by the
 *   row, with the `coop.patronage_payout.paid` event and an audit row.
 * - **Connect second.** On an instance whose adapter can transfer, a member with a ready Express
 *   account (and no fraud hold) gets a `stripe` row, and the `patronage-payout` job is enqueued
 *   after commit (the worker sends it through M1-connect's transfer service). Everyone else's row
 *   is `manual`.
 * - **Unknown outcomes.** A Connect row the worker could not settle (`patronage.payout_outcome_unknown`)
 *   is never sent again; a treasurer looks it up at Stripe and marks it paid with its `tr_` id, or
 *   not sent (failed, with a manual follow-up row). Nobody settles their own payout.
 * - **Reversals.** A Connect reversal posts `patronagePayoutReversed` (the cash returns, the member
 *   is owed it again), marks the row `reversed`, and opens a new manual row for what is still owed.
 * - **Deleted accounts.** Their row stays `pending` and cannot be marked paid: the money stays in
 *   the payable, and the treasurer sees "account deleted". Nothing personal is copied into the row,
 *   the ledger or the audit details; a manual reference is a short code, never free text.
 *
 * The database is the backstop (0049): status only moves forward, the paid rows of a member never
 * exceed their allocation, and the allocation row lock serializes every writer per member.
 */
import { Queue } from "bullmq";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Valkey } from "iovalkey";
import { B8_JOBS, PatronagePayoutJob, QUEUES, patronagePayoutJobId } from "@commonair/contracts/internal";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  distributePatronageIfPaid,
  owedCents,
  patronagePayout,
  patronagePayoutReversed,
  patronageReversedCents,
  payeeHasHoldingFlag,
  post,
} from "@commonair/ledger";
import { type StripeAction, createAdapter } from "@commonair/payments";
import { valkeyTls } from "@commonair/service";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { apiError, badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import type { AppliedAction } from "../money/stripe-events.ts";
import { withCoopErrors } from "./errors.ts";
import { STAFF, money, unknownUser } from "./shared.ts";

const { patronagePayouts, patronagePeriods, patronageAllocations, payoutAccounts, users, auditLog } = schema;
type PayoutRow = typeof patronagePayouts.$inferSelect;
type PeriodRow = typeof patronagePeriods.$inferSelect;

export const PAY_REQUESTED = "patronage.pay_request";
export const PAY_APPROVED = "patronage.pay_approve";
export const PAYOUT_OPENED = "patronage.payout_open";
export const PAYOUT_PAID = "patronage.payout_paid";
export const PAYOUT_REVERSED = "patronage.payout_reversed";
export const PAYOUT_ORPHANED = "patronage.payout_orphaned";
/** The worker's marker on a Connect row whose transfer may or may not exist at Stripe. */
export const PAYOUT_OUTCOME_UNKNOWN = "patronage.payout_outcome_unknown";
export const PAYOUT_UNSENT = "patronage.payout_unsent";
/** The period flipped to `distributed` when its last payout settled (system; follow-ups, unit money). */
export const PERIOD_DISTRIBUTED = "patronage.distribute";
const PAID_PERIODS = ["approved", "distributed"] as const;

/**
 * A treasurer's manual reference: a short code (bank reference, cheque number), never free text.
 * No spaces, so a name ("Paid Jane Doe") cannot land in the write-once `provider_ref` (ADR 0004).
 */
export const MANUAL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/;
/** A Stripe transfer id, the only reference a Connect row settled by hand takes. */
export const STRIPE_TRANSFER_REFERENCE = /^tr_[A-Za-z0-9]{1,60}$/;

// ── Pure rules (unit-tested) ────────────────────────────────────────────────────────────────

export type PayStep =
  | { kind: "request" }
  | { kind: "approve"; requesterId: string }
  | { kind: "approved" }
  | { kind: "same_person" };

/** What a `pay` call does, from the period's request and approval markers (oldest first). */
export function payStep(markers: readonly { action: string; actorId: string | null }[], callerId: string): PayStep {
  if (markers.some((m) => m.action === PAY_APPROVED)) return { kind: "approved" };
  const request = markers.find((m) => m.action === PAY_REQUESTED);
  if (!request || request.actorId === null) return { kind: "request" };
  if (request.actorId === callerId) return { kind: "same_person" };
  return { kind: "approve", requesterId: request.actorId };
}

const isOpen = (s: PayoutRow["status"]) => s === "pending" || s === "paid";

// ── The producer ─────────────────────────────────────────────────────────────────────────────

export interface PatronagePayoutQueue {
  enqueue(jobs: readonly PatronagePayoutJob[]): Promise<void>;
  close(): Promise<void>;
}

/** Attempts and backoff of a Connect patronage payout (an unknown outcome retries under the same key). */
export const PATRONAGE_PAYOUT_ATTEMPTS = 6;
export const PATRONAGE_PAYOUT_BACKOFF_MS = 30_000;

export function createPatronagePayoutQueue(valkeyUrl: string, prefix: string): PatronagePayoutQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, {
    ...valkeyTls(valkeyUrl),
    maxRetriesPerRequest: null,
    connectionName: "api-patronage-payout-queue",
  });
  const queue = new Queue(QUEUES.payments, { connection: conn, prefix });
  return {
    async enqueue(jobs) {
      if (jobs.length === 0) return;
      await queue.addBulk(
        jobs.map((data) => ({
          name: B8_JOBS.patronagePayout,
          data,
          opts: {
            jobId: patronagePayoutJobId(data.periodId, data.userId),
            attempts: PATRONAGE_PAYOUT_ATTEMPTS,
            backoff: { type: "exponential", delay: PATRONAGE_PAYOUT_BACKOFF_MS },
            // The row is the record, not the job: a later pay may queue the same member again.
            removeOnComplete: true,
            removeOnFail: true,
          },
        })),
      );
    },
    async close() {
      await queue.close();
      conn.disconnect();
    },
  };
}

const queues = new WeakMap<Deps, PatronagePayoutQueue>();

export function patronagePayoutQueue(deps: Deps): PatronagePayoutQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createPatronagePayoutQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setPatronagePayoutQueue(deps: Deps, q: PatronagePayoutQueue): void {
  queues.set(deps, q);
}

export async function closePatronagePayoutQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────

interface Member {
  userId: string;
  deleted: boolean;
  /** A ready Stripe Express account to transfer to, or null. */
  stripeAccount: string | null;
}

async function membersOf(tx: Executor, userIds: readonly string[]): Promise<Map<string, Member>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: users.id,
      deletedAt: users.deletedAt,
      provider: payoutAccounts.provider,
      account: payoutAccounts.providerAccountId,
      enabled: payoutAccounts.payoutsEnabled,
    })
    .from(users)
    .leftJoin(payoutAccounts, eq(payoutAccounts.userId, users.id))
    .where(inArray(users.id, [...userIds]));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        userId: r.id,
        deleted: r.deletedAt !== null,
        stripeAccount: r.provider === "stripe" && r.enabled && r.account ? r.account : null,
      },
    ]),
  );
}

/**
 * Open a row for every member of the period who is owed and has none open (the caller holds the
 * period lock). `canTransfer`: the instance's adapter can send Connect transfers. Returns the
 * members whose new row is `stripe`, for the job.
 */
export async function openMissingPayouts(
  tx: Executor,
  period: Pick<PeriodRow, "id" | "currency">,
  o: {
    canTransfer: boolean;
    actor: { type: "admin" | "system"; id: string | null };
    /** Only these members (a reversal or a settled row opens a follow-up for its own member only). */
    userIds?: readonly string[];
  },
): Promise<{ created: number; stripe: string[] }> {
  if (o.userIds?.length === 0) return { created: 0, stripe: [] };
  const allocations = await tx
    .select({ userId: patronageAllocations.userId, amountCents: patronageAllocations.amountCents })
    .from(patronageAllocations)
    .where(
      and(
        eq(patronageAllocations.periodId, period.id),
        sql`${patronageAllocations.amountCents} > 0`,
        o.userIds ? inArray(patronageAllocations.userId, [...o.userIds]) : undefined,
      ),
    )
    .orderBy(asc(patronageAllocations.userId));
  if (allocations.length === 0) return { created: 0, stripe: [] };
  const rows = await tx.select().from(patronagePayouts).where(eq(patronagePayouts.periodId, period.id));
  const reversed = await patronageReversedCents(
    tx,
    rows.filter((r) => r.status === "reversed").map((r) => r.id),
  );
  const people = await membersOf(
    tx,
    allocations.map((a) => a.userId),
  );
  let created = 0;
  const stripe: string[] = [];
  for (const a of allocations) {
    const mine = rows.filter((r) => r.userId === a.userId);
    if (mine.some((r) => isOpen(r.status))) continue;
    const owed = owedCents(
      a.amountCents,
      mine.map((r) => ({ status: r.status, amountCents: r.amountCents, reversedCents: reversed.get(r.id) ?? 0 })),
    );
    if (owed <= 0) continue;
    const m = people.get(a.userId);
    const ready = o.canTransfer && m && !m.deleted && m.stripeAccount && !(await payeeHasHoldingFlag(tx, a.userId));
    const id = uuidv7();
    const [row] = await tx
      .insert(patronagePayouts)
      .values({
        id,
        periodId: period.id,
        userId: a.userId,
        amountCents: owed,
        currency: period.currency,
        provider: ready ? "stripe" : "manual",
        idempotencyKey: `patronage-payout:${id}`,
      })
      .onConflictDoNothing()
      .returning({ id: patronagePayouts.id, provider: patronagePayouts.provider });
    if (!row) continue;
    created += 1;
    if (row.provider === "stripe") stripe.push(a.userId);
    await audit(tx, {
      actorType: o.actor.type,
      actorId: o.actor.id,
      action: PAYOUT_OPENED,
      subjectType: "patronage_payout",
      subjectId: row.id,
      details: { periodId: period.id, userId: a.userId, amountCents: owed, provider: row.provider },
    });
  }
  return { created, stripe };
}

/**
 * A pending row is paid (the caller holds its lock): `paid` with the reference and time, the
 * `patronagePayout` posting keyed by the row, the `coop.patronage_payout.paid` event and the audit
 * row. Returns the paid row, or null when it was no longer pending.
 */
async function recordPaid(
  tx: Executor,
  row: PayoutRow,
  o: { reference: string; paidAt: Date; now: Date; actor: { type: "admin" | "system"; id: string | null } },
): Promise<PayoutRow | null> {
  const [paid] = await tx
    .update(patronagePayouts)
    .set({ status: "paid", providerRef: o.reference, paidAt: o.paidAt })
    .where(and(eq(patronagePayouts.id, row.id), eq(patronagePayouts.status, "pending")))
    .returning();
  if (!paid) return null;
  await post(
    tx,
    patronagePayout({
      payoutId: paid.id,
      periodId: paid.periodId,
      userId: paid.userId,
      provider: paid.provider,
      amountCents: paid.amountCents,
      currency: paid.currency,
      occurredAt: o.paidAt,
    }),
  );
  await emit(
    tx,
    "coop.patronage_payout.paid",
    null,
    {
      patronage_payout_id: paid.id,
      period_id: paid.periodId,
      user_id: paid.userId,
      amount_cents: paid.amountCents,
      currency: paid.currency,
      provider: paid.provider,
    },
    o.now,
  );
  await audit(tx, {
    actorType: o.actor.type,
    actorId: o.actor.id,
    action: PAYOUT_PAID,
    subjectType: "patronage_payout",
    subjectId: paid.id,
    details: { periodId: paid.periodId, userId: paid.userId, amountCents: paid.amountCents, provider: paid.provider },
  });
  return paid;
}

/**
 * Lock the period of a payout row before the row itself: the order `pay` uses (period, then the
 * allocation its rows lock), so settling a row and the automatic `distributed` flip after it never
 * deadlock against a pay. Returns the row's period id, or null when there is no such row.
 */
async function lockPeriodOfPayout(tx: Executor, payoutId: string): Promise<string | null> {
  const [r] = await tx
    .select({ periodId: patronagePayouts.periodId })
    .from(patronagePayouts)
    .where(eq(patronagePayouts.id, payoutId));
  if (!r) return null;
  await tx
    .select({ id: patronagePeriods.id })
    .from(patronagePeriods)
    .where(eq(patronagePeriods.id, r.periodId))
    .for("update");
  return r.periodId;
}

/**
 * After a row was paid (period locked by the caller): the period becomes `distributed` when nothing
 * is owed any more, with the `coop.patronage.update` event and a system audit row. Idempotent.
 */
export async function distributeIfPaid(tx: Executor, periodId: string, now: Date): Promise<boolean> {
  const d = await distributePatronageIfPaid(tx, periodId);
  if (!d) return false;
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: PERIOD_DISTRIBUTED,
    subjectType: "patronage_period",
    subjectId: periodId,
    details: { periodId, totalCents: d.totalCents, members: d.members },
  });
  await emit(
    tx,
    "coop.patronage.update",
    null,
    { period_id: periodId, status: "distributed", total_cents: d.totalCents, members: d.members },
    now,
  );
  return true;
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────

type Person = { id: string; username: string; displayName: string };

async function peopleOf(db: Executor, ids: readonly string[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.name, deletedAt: users.deletedAt })
    .from(users)
    .where(inArray(users.id, unique));
  // A deleted account shows as such (its pseudonym says nothing to a treasurer).
  return new Map(
    rows.map((r) => [
      r.id,
      r.deletedAt ? unknownUser(r.id) : { id: r.id, username: r.username, displayName: r.displayName },
    ]),
  );
}

export function payoutView(r: PayoutRow, people: ReadonlyMap<string, Person>) {
  return {
    id: r.id,
    periodId: r.periodId,
    user: people.get(r.userId) ?? unknownUser(r.userId),
    amount: money(r.amountCents, r.currency),
    provider: r.provider,
    status: r.status,
    reference: r.providerRef,
    createdAt: iso(r.createdAt),
    paidAt: isoOrNull(r.paidAt),
  };
}
export type PatronagePayoutDto = ReturnType<typeof payoutView>;

/**
 * A member's own payout for a period: the latest row (a failed or reversed one is followed by a new
 * one), or null. Only ever the caller's own row.
 */
export async function memberPatronagePayout(
  db: Executor,
  periodId: string,
  userId: string,
): Promise<PatronagePayoutDto | null> {
  const [row] = await db
    .select()
    .from(patronagePayouts)
    .where(and(eq(patronagePayouts.periodId, periodId), eq(patronagePayouts.userId, userId)))
    .orderBy(desc(patronagePayouts.createdAt), desc(patronagePayouts.id))
    .limit(1);
  return row ? payoutView(row, await peopleOf(db, [userId])) : null;
}

// ── Manual mark-paid ─────────────────────────────────────────────────────────────────────────

const ownPayout = () =>
  apiError("FORBIDDEN", "Another treasurer or an admin settles your own payout", { reason: "second_approver" });

async function hasOutcomeUnknown(tx: Executor, payoutId: string): Promise<boolean> {
  const [m] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectType, "patronage_payout"),
        eq(auditLog.subjectId, payoutId),
        eq(auditLog.action, PAYOUT_OUTCOME_UNKNOWN),
      ),
    )
    .limit(1);
  return m !== undefined;
}

/**
 * A treasurer marks a row paid with their reference (`coop.patronage.markPaid` once the contract
 * carries it). A manual row takes a short code. A Connect row is the worker's, except one whose
 * outcome is unknown (the worker will never send it again): the treasurer looks it up at Stripe and
 * marks it paid with its `tr_` id. Refused for the treasurer's own payout, a deleted account, a
 * reference of the wrong shape, and a time in the future or before the period was approved.
 */
export async function markPatronagePayoutPaid(
  deps: Deps,
  input: { payoutId: string; reference: string; paidAt: string; actorId: string },
): Promise<PatronagePayoutDto> {
  const reference = input.reference.trim();
  if (!MANUAL_REFERENCE.test(reference))
    throw badRequest("The reference is a short code (letters, digits, . _ : / # -)");
  const paidAt = new Date(input.paidAt);
  if (Number.isNaN(paidAt.getTime())) throw badRequest("The payment time is not a valid time");
  const now = deps.now();
  if (paidAt.getTime() > now.getTime()) throw badRequest("The payout cannot be paid in the future");
  const paid = await withCoopErrors(() =>
    deps.db.transaction(async (tx) => {
      if (!(await lockPeriodOfPayout(tx, input.payoutId))) throw notFound("Payout not found");
      const [row] = await tx
        .select()
        .from(patronagePayouts)
        .where(eq(patronagePayouts.id, input.payoutId))
        .for("update");
      if (!row) throw notFound("Payout not found");
      if (row.userId === input.actorId) throw ownPayout();
      if (row.status !== "pending") throw conflict(`This payout is ${row.status}, not pending`);
      if (row.provider !== "manual") {
        if (!(await hasOutcomeUnknown(tx, row.id)))
          throw conflict("This payout is sent through the payment provider; it is not marked paid by hand");
        if (!STRIPE_TRANSFER_REFERENCE.test(reference))
          throw badRequest("A payout sent through Stripe is marked paid with its transfer id (tr_…)");
      }
      const [period] = await tx.select().from(patronagePeriods).where(eq(patronagePeriods.id, row.periodId));
      if (period?.approvedAt && paidAt.getTime() < period.approvedAt.getTime())
        throw badRequest("The payout cannot be paid before the period was approved");
      const [u] = await tx.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, row.userId));
      // A Connect transfer that exists left whatever happened to the account since; a manual one is not made.
      if (row.provider === "manual" && (!u || u.deletedAt))
        throw precondition("account_deleted", "This member's account was deleted; it stays owed");
      const done = await recordPaid(tx, row, { reference, paidAt, now, actor: { type: STAFF, id: input.actorId } });
      if (!done) throw conflict("This payout changed; reload and try again");
      await distributeIfPaid(tx, done.periodId, now);
      return done;
    }),
  );
  return payoutView(paid, await peopleOf(deps.db, [paid.userId]));
}

/**
 * A treasurer settles a Connect row whose outcome is unknown as never sent, after checking Stripe
 * shows no transfer for it (`coop.patronage.markUnsent` once the contract carries it): the row
 * fails (nothing was posted, the money is still in the payable) and a manual row opens for what the
 * member is still owed. A transfer that turns up later anyway is recorded for the treasurer
 * (`patronage.payout_orphaned`), never paid twice. Refused for the treasurer's own payout.
 */
export async function markPatronagePayoutUnsent(
  deps: Deps,
  input: { payoutId: string; actorId: string },
): Promise<{ failed: PatronagePayoutDto; followUp: PatronagePayoutDto | null }> {
  const actor = { type: STAFF, id: input.actorId } as const;
  const r = await withCoopErrors(() =>
    deps.db.transaction(async (tx) => {
      // The period first, as every other path that settles a row locks them: the follow-up row
      // below needs the period too (openMissingPayouts), so row-then-period could deadlock.
      if (!(await lockPeriodOfPayout(tx, input.payoutId))) throw notFound("Payout not found");
      const [row] = await tx
        .select()
        .from(patronagePayouts)
        .where(eq(patronagePayouts.id, input.payoutId))
        .for("update");
      if (!row) throw notFound("Payout not found");
      if (row.userId === input.actorId) throw ownPayout();
      if (row.status !== "pending") throw conflict(`This payout is ${row.status}, not pending`);
      if (row.provider !== "stripe" || !(await hasOutcomeUnknown(tx, row.id)))
        throw conflict("Only a payout whose outcome at Stripe is unknown is settled as not sent");
      const [failed] = await tx
        .update(patronagePayouts)
        .set({ status: "failed" })
        .where(and(eq(patronagePayouts.id, row.id), eq(patronagePayouts.status, "pending")))
        .returning();
      if (!failed) throw conflict("This payout changed; reload and try again");
      await audit(tx, {
        actorType: actor.type,
        actorId: actor.id,
        action: PAYOUT_UNSENT,
        subjectType: "patronage_payout",
        subjectId: row.id,
        details: { periodId: row.periodId, userId: row.userId, amountCents: row.amountCents },
      });
      const [period] = await tx
        .select({ id: patronagePeriods.id, currency: patronagePeriods.currency })
        .from(patronagePeriods)
        .where(eq(patronagePeriods.id, row.periodId));
      if (period) await openMissingPayouts(tx, period, { canTransfer: false, actor, userIds: [row.userId] });
      const [followUp] = await tx
        .select()
        .from(patronagePayouts)
        .where(
          and(
            eq(patronagePayouts.periodId, row.periodId),
            eq(patronagePayouts.userId, row.userId),
            eq(patronagePayouts.status, "pending"),
          ),
        )
        .limit(1);
      return { failed, followUp: followUp ?? null };
    }),
  );
  const people = await peopleOf(deps.db, [r.failed.userId]);
  return { failed: payoutView(r.failed, people), followUp: r.followUp ? payoutView(r.followUp, people) : null };
}

// ── Connect transfer events ──────────────────────────────────────────────────────────────────

type TransferAction = Extract<StripeAction, { type: "transfer.reversed" | "transfer.updated" }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noop = (outcome: string): AppliedAction => ({ outcome, invalidate: [], cancelProviderSubscriptions: [] });

/**
 * A Connect transfer event for a patronage payout, in the webhook's transaction, or null when the
 * transfer is not one (M1-connect's handler then answers `ignored`). The worker sends a patronage
 * transfer with the row's id as both metadata ids, so the row is found by Stripe's id or by ours.
 *
 * - An event before the worker recorded the transfer settles the row `paid` first.
 * - A reversal posts `patronagePayoutReversed` for the increase over what was booked (keyed by the
 *   cumulative total, so a redelivery posts nothing), marks the row `reversed`, writes the
 *   `coop.patronage_payout.reversed` event and an audit row, and opens a new manual row for what the
 *   member is still owed.
 * - A transfer on a row we failed is recorded for the treasurer (`patronage.payout_orphaned`).
 */
export async function patronageTransferEvent(
  tx: Executor,
  a: TransferAction,
  now: Date,
): Promise<AppliedAction | null> {
  // Found unlocked, then the period locked before the row (`lockPeriodOfPayout`).
  const [byRef] = await tx
    .select({ id: patronagePayouts.id })
    .from(patronagePayouts)
    .where(and(eq(patronagePayouts.provider, "stripe"), eq(patronagePayouts.providerRef, a.transferRef)));
  let found = byRef?.id;
  if (!found && a.transferId && UUID.test(a.transferId)) {
    const [byId] = await tx
      .select({ id: patronagePayouts.id })
      .from(patronagePayouts)
      .where(eq(patronagePayouts.id, a.transferId));
    found = byId?.id;
  }
  if (!found || !(await lockPeriodOfPayout(tx, found))) return null;
  let [row] = await tx.select().from(patronagePayouts).where(eq(patronagePayouts.id, found)).for("update");
  if (!row) return null;
  if (
    row.provider !== "stripe" ||
    (row.providerRef !== null && row.providerRef !== a.transferRef) ||
    row.amountCents !== a.amountCents ||
    row.currency !== a.currency
  )
    return noop("transfer_mismatch");
  if (row.status === "failed") {
    const [seen] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectType, "patronage_payout"),
          eq(auditLog.subjectId, row.id),
          eq(auditLog.action, PAYOUT_ORPHANED),
        ),
      )
      .limit(1);
    if (!seen)
      await audit(tx, {
        actorType: "system",
        actorId: null,
        action: PAYOUT_ORPHANED,
        subjectType: "patronage_payout",
        subjectId: row.id,
        details: { periodId: row.periodId, userId: row.userId, transferRef: a.transferRef },
      });
    return noop("patronage_payout_orphaned");
  }
  let settled = false;
  if (row.status === "pending") {
    const paid = await recordPaid(tx, row, {
      reference: a.transferRef,
      paidAt: now,
      now,
      actor: { type: "system", id: null },
    });
    if (paid) {
      row = paid;
      settled = true;
    }
  }

  const booked = (await patronageReversedCents(tx, [row.id])).get(row.id) ?? 0;
  const cumulative = Math.min(a.amountReversed, row.amountCents);
  if (cumulative > booked) {
    await recordReversal(tx, row, { cumulativeCents: cumulative, bookedCents: booked, now });
    return noop("patronage_payout_reversed");
  }
  if (settled) await distributeIfPaid(tx, row.periodId, now);
  return noop(settled ? "patronage_payout_paid" : "duplicate");
}

async function recordReversal(
  tx: Executor,
  row: PayoutRow,
  o: { cumulativeCents: number; bookedCents: number; now: Date },
): Promise<void> {
  const delta = o.cumulativeCents - o.bookedCents;
  await post(
    tx,
    patronagePayoutReversed({
      payoutId: row.id,
      periodId: row.periodId,
      userId: row.userId,
      provider: row.provider,
      amountCents: delta,
      cumulativeCents: o.cumulativeCents,
      currency: row.currency,
      occurredAt: o.now,
    }),
  );
  // Any reversal ends the row, so what is still owed can be paid again (by hand).
  if (row.status === "paid")
    await tx
      .update(patronagePayouts)
      .set({ status: "reversed" })
      .where(and(eq(patronagePayouts.id, row.id), eq(patronagePayouts.status, "paid")));
  await emit(
    tx,
    "coop.patronage_payout.reversed",
    null,
    {
      patronage_payout_id: row.id,
      period_id: row.periodId,
      user_id: row.userId,
      amount_cents: delta,
      currency: row.currency,
    },
    o.now,
  );
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: PAYOUT_REVERSED,
    subjectType: "patronage_payout",
    subjectId: row.id,
    details: { periodId: row.periodId, userId: row.userId, amountCents: delta, cumulativeCents: o.cumulativeCents },
  });
  // No period lock here (a pay holds it while it locks allocations: the reverse order would
  // deadlock); the open-row index and the allocation lock keep the follow-up row single.
  const [period] = await tx
    .select({ id: patronagePeriods.id, currency: patronagePeriods.currency })
    .from(patronagePeriods)
    .where(eq(patronagePeriods.id, row.periodId));
  if (period)
    await openMissingPayouts(tx, period, {
      canTransfer: false,
      actor: { type: "system", id: null },
      userIds: [row.userId],
    });
}

// ── Handlers ────────────────────────────────────────────────────────────────────────────────

const secondApprover = () =>
  apiError("FORBIDDEN", "A second treasurer or an admin must approve paying this period out", {
    reason: "second_approver",
  });

/** After commit: queue the Connect payouts. Never throws; the rows stay pending for a later pay. */
async function startPatronageTransfers(deps: Deps, periodId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await patronagePayoutQueue(deps).enqueue(userIds.map((userId) => ({ periodId, userId })));
  } catch (err) {
    deps.logger.warn("patronage payouts not queued; pay again to retry", {
      periodId,
      errorName: err instanceof Error ? err.name : "UnknownError",
    });
  }
}

export const patronagePayoutHandlers = {
  markPaid: os.coop.patronage.markPaid.handler(async ({ context, input }) =>
    markPatronagePayoutPaid(context.deps, { ...input, actorId: requireCaller(context).user.id }),
  ),
  markUnsent: os.coop.patronage.markUnsent.handler(async ({ context, input }) =>
    markPatronagePayoutUnsent(context.deps, { ...input, actorId: requireCaller(context).user.id }),
  ),
  payouts: os.coop.patronage.payouts.handler(async ({ context, input }) => {
    const { db } = context.deps;
    const [period] = await db
      .select({ id: patronagePeriods.id })
      .from(patronagePeriods)
      .where(eq(patronagePeriods.id, input.periodId));
    if (!period) throw notFound("Patronage period not found");
    const rows = await db
      .select()
      .from(patronagePayouts)
      .where(eq(patronagePayouts.periodId, input.periodId))
      .orderBy(asc(patronagePayouts.createdAt), asc(patronagePayouts.id));
    const people = await peopleOf(
      db,
      rows.map((r) => r.userId),
    );
    return rows.map((r) => payoutView(r, people));
  }),

  pay: os.coop.patronage.pay.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    // Only an adapter that can send Connect transfers (Stripe) opens `stripe` rows.
    const canTransfer = "transfer" in createAdapter(deps.env);
    const r = await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        // The period lock serializes requests, approvals and repeats.
        const [period] = await tx
          .select()
          .from(patronagePeriods)
          .where(eq(patronagePeriods.id, input.periodId))
          .for("update");
        if (!period) throw notFound("Patronage period not found");
        if (!(PAID_PERIODS as readonly string[]).includes(period.status))
          throw conflict(`This period is ${period.status}; only an approved period is paid out`);
        const [alloc] = await tx
          .select({
            members: sql<string>`count(*)::text`,
            total: sql<string>`coalesce(sum(${patronageAllocations.amountCents}), 0)::text`,
          })
          .from(patronageAllocations)
          .where(and(eq(patronageAllocations.periodId, period.id), sql`${patronageAllocations.amountCents} > 0`));
        const members = Number(alloc?.members ?? 0);
        const totalCents = Number(alloc?.total ?? 0);
        if (members === 0) throw precondition("allocations", "This period allocated nothing to pay out");
        const markers = await tx
          .select({ action: auditLog.action, actorId: auditLog.actorId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.subjectType, "patronage_period"),
              eq(auditLog.subjectId, period.id),
              inArray(auditLog.action, [PAY_REQUESTED, PAY_APPROVED]),
            ),
          )
          .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
        const step = payStep(markers, caller.user.id);
        const actor = { type: STAFF, id: caller.user.id } as const;
        if (step.kind === "same_person") throw secondApprover();
        if (step.kind === "request") {
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: PAY_REQUESTED,
            subjectType: "patronage_period",
            subjectId: period.id,
            details: { periodId: period.id, members, totalCents },
          });
          return { state: "awaiting_second_approver" as const, created: 0, stripe: [] as string[] };
        }
        if (step.kind === "approve")
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: PAY_APPROVED,
            subjectType: "patronage_period",
            subjectId: period.id,
            details: { periodId: period.id, members, totalCents, requestedBy: step.requesterId },
          });
        const opened = await openMissingPayouts(tx, period, { canTransfer, actor });
        // Every Connect row still pending is queued (again): a repeat recovers a lost enqueue, and
        // the job id keeps one job per member and period. A row whose outcome is unknown is a
        // person's to settle, never sent again (the worker refuses it too).
        const pendingStripe = canTransfer
          ? await tx
              .select({ id: patronagePayouts.id, userId: patronagePayouts.userId })
              .from(patronagePayouts)
              .where(
                and(
                  eq(patronagePayouts.periodId, period.id),
                  eq(patronagePayouts.status, "pending"),
                  eq(patronagePayouts.provider, "stripe"),
                ),
              )
          : [];
        const unknown =
          pendingStripe.length === 0
            ? new Set<string>()
            : new Set(
                (
                  await tx
                    .select({ id: auditLog.subjectId })
                    .from(auditLog)
                    .where(
                      and(
                        eq(auditLog.subjectType, "patronage_payout"),
                        inArray(
                          auditLog.subjectId,
                          pendingStripe.map((w) => w.id),
                        ),
                        eq(auditLog.action, PAYOUT_OUTCOME_UNKNOWN),
                      ),
                    )
                ).map((m) => m.id),
              );
        const waiting = pendingStripe.filter((w) => !unknown.has(w.id));
        const stripe = [...new Set([...opened.stripe, ...waiting.map((w) => w.userId)])];
        return { state: "approved" as const, created: opened.created, stripe };
      }),
    );
    await startPatronageTransfers(deps, input.periodId, r.stripe);
    return { state: r.state, created: r.created };
  }),
};
