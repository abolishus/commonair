// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One member's Connect patronage payout (batch 8, M1-coop-money; ADR 0020), run by the
 * `patronage-payout` job that an approved `coop.patronage.pay` enqueues for each `stripe` row:
 *
 * 1. find the member's `pending` `stripe` row for the period; anything else is not ours to send;
 * 2. check the member: account not deleted, a ready Stripe Express account, no fraud hold. If not,
 *    and no earlier attempt can have reached Stripe, the row becomes `manual` (still `pending`) for
 *    the treasurer to pay by hand. If an earlier attempt may have (a `patronage.payout_sending`
 *    marker), the transfer may exist at Stripe: the row is left for a person, never switched;
 * 3. mark the row sending, then call M1-connect's transfer service (the adapter's `transfer`) outside
 *    any transaction, under the row's own key, so a retry gets Stripe's first answer back;
 * 4. record the answer: created → `paid` with the `patronagePayout` posting keyed by the row
 *    (`cash:stripe`), its event and audit row; a definite 4xx → `failed` (nothing was posted), and a
 *    new `manual` row for what the member is still owed; an unknown outcome → still pending, and the
 *    job throws so BullMQ retries under the same key; after the last attempt the row carries a
 *    `patronage.payout_outcome_unknown` marker for the treasurer.
 *
 * A row carrying that marker is never sent again, and neither is a maybe-sent row whose first send
 * is older than `PAYOUT_TRANSFER_KEY_WINDOW_MS` (Stripe forgets idempotency keys after about a day,
 * so a repeat could make a second transfer). A treasurer settles it from what Stripe shows: paid
 * with the `tr_` id, or not sent (failed, with a manual row), in the API's `patronage-payouts.ts`.
 *
 * The transfer request names the row as both our ids (`payout_id`, `transfer_id` metadata), so the
 * API's transfer webhook can find it (`coop/patronage-payouts.ts` `patronageTransferEvent`). Ids and
 * cents only reach Stripe, the logs and the audit rows.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { emitEvent, systemAudit } from "@commonair/governance";
import {
  PAYOUT_TRANSFER_KEY_WINDOW_MS,
  owedCents,
  patronagePayout,
  patronageReversedCents,
  payeeHasHoldingFlag,
  payoutTransferKey,
  post,
} from "@commonair/ledger";
import { type PaymentAdapter, StripeRequestError } from "@commonair/payments";
import type { WorkerContext } from "../context.ts";

const { patronagePayouts, patronageAllocations, payoutAccounts, users, auditLog } = schema;
type PayoutRow = typeof patronagePayouts.$inferSelect;

export const PAYOUT_SENDING = "patronage.payout_sending";
export const PAYOUT_OUTCOME_UNKNOWN = "patronage.payout_outcome_unknown";
export const PAYOUT_FAILED = "patronage.payout_failed";
export const PAYOUT_TO_MANUAL = "patronage.payout_manual";
export const PAYOUT_PAID = "patronage.payout_paid";
export const PAYOUT_OPENED = "patronage.payout_open";

export interface PatronagePayoutDeps {
  adapter: Pick<PaymentAdapter, "provider" | "transfer">;
}

export type PatronagePayoutOutcome =
  | { outcome: "paid"; payoutId: string }
  | { outcome: "failed"; payoutId: string; code: string; followUpId: string | null }
  | { outcome: "manual"; payoutId: string; reason: ManualReason }
  | { outcome: "unknown"; payoutId: string }
  | { outcome: "skipped"; reason: "manual_adapter" | "no_row" | "manual_row" };

export type ManualReason = "account_deleted" | "account_not_ready" | "held";

/** The opaque code of a definite refusal: Stripe's code when it is one, else the HTTP status. */
export function refusalCode(err: StripeRequestError): string {
  const code = err.code;
  return code && /^[a-z0-9_]{1,56}$/.test(code) ? code : `stripe_${err.status}`;
}

/** When the marker was first written, or null. The sending marker's time is the key's first use. */
async function markerAt(db: Executor, payoutId: string, action: string): Promise<Date | null> {
  const [m] = await db
    .select({ at: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(eq(auditLog.subjectType, "patronage_payout"), eq(auditLog.subjectId, payoutId), eq(auditLog.action, action)),
    )
    .orderBy(asc(auditLog.createdAt))
    .limit(1);
  return m?.at ?? null;
}

async function hasMarker(db: Executor, payoutId: string, action: string): Promise<boolean> {
  return (await markerAt(db, payoutId, action)) !== null;
}

async function marker(ctx: WorkerContext, row: PayoutRow, action: string, details: Record<string, unknown> = {}) {
  if (await hasMarker(ctx.db, row.id, action)) return;
  await systemAudit(
    ctx.db,
    {
      action,
      subjectType: "patronage_payout",
      subjectId: row.id,
      reason: "",
      details: { periodId: row.periodId, userId: row.userId, ...details },
    },
    ctx.now(),
  );
}

/** Why the member cannot be sent a transfer now, or null with their Express account. */
async function readiness(
  db: Executor,
  userId: string,
): Promise<{ ready: true; destination: string } | { ready: false; reason: ManualReason }> {
  const [u] = await db
    .select({
      deletedAt: users.deletedAt,
      provider: payoutAccounts.provider,
      account: payoutAccounts.providerAccountId,
      enabled: payoutAccounts.payoutsEnabled,
    })
    .from(users)
    .leftJoin(payoutAccounts, eq(payoutAccounts.userId, users.id))
    .where(eq(users.id, userId));
  if (!u || u.deletedAt) return { ready: false, reason: "account_deleted" };
  if (u.provider !== "stripe" || !u.enabled || !u.account) return { ready: false, reason: "account_not_ready" };
  if (await payeeHasHoldingFlag(db, userId)) return { ready: false, reason: "held" };
  return { ready: true, destination: u.account };
}

export async function runPatronagePayout(
  ctx: WorkerContext,
  deps: PatronagePayoutDeps,
  job: { periodId: string; userId: string },
  opts: { lastAttempt: boolean },
): Promise<PatronagePayoutOutcome> {
  const send = deps.adapter.transfer;
  if (!send) return { outcome: "skipped", reason: "manual_adapter" };
  const [row] = await ctx.db
    .select()
    .from(patronagePayouts)
    .where(
      and(
        eq(patronagePayouts.periodId, job.periodId),
        eq(patronagePayouts.userId, job.userId),
        eq(patronagePayouts.status, "pending"),
      ),
    )
    .orderBy(desc(patronagePayouts.createdAt))
    .limit(1);
  if (!row) return { outcome: "skipped", reason: "no_row" };
  if (row.provider !== "stripe") return { outcome: "skipped", reason: "manual_row" };

  // A row whose outcome is already unknown is a person's to settle (coop.patronage.markPaid with
  // Stripe's tr_ reference, or markUnsent); a re-queued job never sends it again.
  if (await hasMarker(ctx.db, row.id, PAYOUT_OUTCOME_UNKNOWN)) {
    ctx.logger.warn("patronage payout outcome unknown; left for a person", { payoutId: row.id });
    return { outcome: "unknown", payoutId: row.id };
  }
  const firstSent = await markerAt(ctx.db, row.id, PAYOUT_SENDING);
  const maybeSent = firstSent !== null;
  const member = await readiness(ctx.db, row.userId);
  if (!member.ready) {
    if (maybeSent) {
      // Stripe may already have the transfer: never hand it to the manual path (it would pay twice).
      await marker(ctx, row, PAYOUT_OUTCOME_UNKNOWN, { reason: member.reason });
      ctx.logger.warn("patronage payout may exist at Stripe but the member is not sendable; left for a person", {
        payoutId: row.id,
        reason: member.reason,
      });
      return { outcome: "unknown", payoutId: row.id };
    }
    return toManual(ctx, row, member.reason);
  }
  // Stripe forgets an idempotency key after about a day: past M1-connect's window a repeat could
  // create a second transfer, so it is never sent again (as runPayoutTransfer).
  if (firstSent && ctx.now().getTime() - firstSent.getTime() > PAYOUT_TRANSFER_KEY_WINDOW_MS) {
    await marker(ctx, row, PAYOUT_OUTCOME_UNKNOWN, { reason: "key_window" });
    ctx.logger.warn("patronage payout: past the idempotency window, not sent again", { payoutId: row.id });
    return { outcome: "unknown", payoutId: row.id };
  }

  await marker(ctx, row, PAYOUT_SENDING);
  let providerRef: string;
  try {
    const r = await send({
      payoutId: row.id,
      transferId: row.id,
      destination: member.destination,
      amountCents: row.amountCents,
      currency: row.currency,
      group: `patronage-${row.periodId}`,
      idempotencyKey: payoutTransferKey(row.id),
    });
    providerRef = r.providerRef;
  } catch (err) {
    if (err instanceof StripeRequestError) return fail(ctx, row, refusalCode(err));
    // A request the adapter refused to build never reached Stripe.
    if (err instanceof RangeError) return fail(ctx, row, "invalid_request");
    if (opts.lastAttempt) await marker(ctx, row, PAYOUT_OUTCOME_UNKNOWN, { reason: "no_answer" });
    ctx.logger.warn("patronage payout: no answer, retrying with the same key", {
      payoutId: row.id,
      errorName: err instanceof Error ? err.name : "UnknownError",
      lastAttempt: opts.lastAttempt,
    });
    throw err;
  }
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(patronagePayouts).where(eq(patronagePayouts.id, row.id)).for("update");
    // The webhook may have recorded it first.
    if (locked?.status === "pending") await recordPaid(tx, locked, providerRef, ctx.now());
  });
  ctx.logger.info("patronage payout sent", { payoutId: row.id });
  return { outcome: "paid", payoutId: row.id };
}

async function toManual(ctx: WorkerContext, row: PayoutRow, reason: ManualReason): Promise<PatronagePayoutOutcome> {
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const [moved] = await tx
      .update(patronagePayouts)
      .set({ provider: "manual" })
      .where(
        and(
          eq(patronagePayouts.id, row.id),
          eq(patronagePayouts.status, "pending"),
          eq(patronagePayouts.provider, "stripe"),
        ),
      )
      .returning({ id: patronagePayouts.id });
    if (!moved) return;
    await systemAudit(
      tx,
      {
        action: PAYOUT_TO_MANUAL,
        subjectType: "patronage_payout",
        subjectId: row.id,
        reason: "",
        details: { periodId: row.periodId, userId: row.userId, reason },
      },
      now,
    );
  });
  ctx.logger.info("patronage payout left for the manual path", { payoutId: row.id, reason });
  return { outcome: "manual", payoutId: row.id, reason };
}

async function fail(ctx: WorkerContext, row: PayoutRow, code: string): Promise<PatronagePayoutOutcome> {
  const now = ctx.now();
  const followUpId = await ctx.db.transaction(async (tx) => {
    const [failed] = await tx
      .update(patronagePayouts)
      .set({ status: "failed" })
      .where(and(eq(patronagePayouts.id, row.id), eq(patronagePayouts.status, "pending")))
      .returning();
    if (!failed) return null;
    await systemAudit(
      tx,
      {
        action: PAYOUT_FAILED,
        subjectType: "patronage_payout",
        subjectId: row.id,
        reason: "",
        details: { periodId: row.periodId, userId: row.userId, code },
      },
      now,
    );
    // Nothing was posted for a pending row: the money is still in the payable. Pay it by hand.
    return openFollowUp(tx, failed, now);
  });
  ctx.logger.info("patronage payout failed; a manual payout follows", { payoutId: row.id, code });
  return { outcome: "failed", payoutId: row.id, code, followUpId };
}

/** The row is paid through Stripe (the caller holds its lock). */
async function recordPaid(tx: Executor, row: PayoutRow, providerRef: string, now: Date): Promise<void> {
  const [paid] = await tx
    .update(patronagePayouts)
    .set({ status: "paid", providerRef, paidAt: now })
    .where(and(eq(patronagePayouts.id, row.id), eq(patronagePayouts.status, "pending")))
    .returning();
  if (!paid) return;
  await post(
    tx,
    patronagePayout({
      payoutId: paid.id,
      periodId: paid.periodId,
      userId: paid.userId,
      provider: paid.provider,
      amountCents: paid.amountCents,
      currency: paid.currency,
      occurredAt: now,
    }),
  );
  await emitEvent(
    tx,
    "coop.patronage_payout.paid",
    {
      patronage_payout_id: paid.id,
      period_id: paid.periodId,
      user_id: paid.userId,
      amount_cents: paid.amountCents,
      currency: paid.currency,
      provider: paid.provider,
    },
    now,
  );
  await systemAudit(
    tx,
    {
      action: PAYOUT_PAID,
      subjectType: "patronage_payout",
      subjectId: paid.id,
      reason: "",
      details: { periodId: paid.periodId, userId: paid.userId, amountCents: paid.amountCents, provider: paid.provider },
    },
    now,
  );
}

/** A new `manual` row for what the member is still owed for the period, unless one is open. */
async function openFollowUp(tx: Executor, row: PayoutRow, now: Date): Promise<string | null> {
  const [alloc] = await tx
    .select({ amountCents: patronageAllocations.amountCents })
    .from(patronageAllocations)
    .where(and(eq(patronageAllocations.periodId, row.periodId), eq(patronageAllocations.userId, row.userId)));
  if (!alloc) return null;
  const rows = await tx
    .select()
    .from(patronagePayouts)
    .where(and(eq(patronagePayouts.periodId, row.periodId), eq(patronagePayouts.userId, row.userId)));
  if (rows.some((r) => r.status === "pending" || r.status === "paid")) return null;
  const reversed = await patronageReversedCents(
    tx,
    rows.filter((r) => r.status === "reversed").map((r) => r.id),
  );
  const owed = owedCents(
    alloc.amountCents,
    rows.map((r) => ({ status: r.status, amountCents: r.amountCents, reversedCents: reversed.get(r.id) ?? 0 })),
  );
  if (owed <= 0) return null;
  const id = uuidv7(now.getTime());
  const [created] = await tx
    .insert(patronagePayouts)
    .values({
      id,
      periodId: row.periodId,
      userId: row.userId,
      amountCents: owed,
      currency: row.currency,
      provider: "manual",
      idempotencyKey: `patronage-payout:${id}`,
    })
    .onConflictDoNothing()
    .returning({ id: patronagePayouts.id });
  if (!created) return null;
  await systemAudit(
    tx,
    {
      action: PAYOUT_OPENED,
      subjectType: "patronage_payout",
      subjectId: id,
      reason: "",
      details: { periodId: row.periodId, userId: row.userId, amountCents: owed, provider: "manual", follows: row.id },
    },
    now,
  );
  return id;
}
