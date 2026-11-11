// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion requests (docs/testing/e4c-selectors.md "Account deletion"). The API schedules
 * them; the worker's `deletions` job completes due requests and fills `retained` with the held
 * tables it left untouched. Requests for one user are serialized on the user's row.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import {
  type PaymentAdapter,
  type PaymentsEnvLike,
  StripeApiError,
  StripeOutcomeUnknown,
  createAdapter,
} from "@commonair/payments";
import { audit } from "../events/audit.ts";
import { iso } from "../lib/dto.ts";

const { accountDeletions, users } = schema;
type DeletionRow = typeof accountDeletions.$inferSelect;

export const DELETION_GRACE_DAYS = 30;

export const toDeletion = (d: DeletionRow) => ({
  id: d.id,
  status: d.status,
  scheduledFor: iso(d.scheduledFor),
  retained: d.retained,
});

/**
 * Which of these users have a deletion scheduled. Checkout refuses them (as payer, or as the
 * channel's owner): the deletion ends every subscription they pay or are paid (worker
 * `deletion/money.ts`), so new money would only be refunded.
 */
export async function deletionScheduledAmong(db: Executor, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: accountDeletions.userId })
    .from(accountDeletions)
    .where(and(inArray(accountDeletions.userId, [...userIds]), eq(accountDeletions.status, "scheduled")));
  return new Set(rows.map((r) => r.userId));
}

/** Lock the user row so concurrent requests for one account cannot both insert. */
export async function lockUser(tx: Executor, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
}

export async function scheduledDeletion(tx: Executor, userId: string): Promise<DeletionRow | undefined> {
  const [d] = await tx
    .select()
    .from(accountDeletions)
    .where(and(eq(accountDeletions.userId, userId), eq(accountDeletions.status, "scheduled")))
    .orderBy(desc(accountDeletions.requestedAt))
    .limit(1);
  return d;
}

/** The most recent request that is scheduled or completed (a canceled one reads as none). */
export async function currentDeletion(db: Executor, userId: string): Promise<DeletionRow | undefined> {
  const [d] = await db
    .select()
    .from(accountDeletions)
    .where(and(eq(accountDeletions.userId, userId), inArray(accountDeletions.status, ["scheduled", "completed"])))
    .orderBy(desc(accountDeletions.requestedAt))
    .limit(1);
  return d;
}

/** When each of these users' scheduled deletion is due (`ShareView.deletionScheduledFor`). */
export async function deletionDatesAmong(db: Executor, userIds: readonly string[]): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: accountDeletions.userId, at: accountDeletions.scheduledFor })
    .from(accountDeletions)
    .where(and(inArray(accountDeletions.userId, [...new Set(userIds)]), eq(accountDeletions.status, "scheduled")));
  return new Map(rows.map((r) => [r.userId, r.at]));
}

/* ------------------------------------------------------------------------------------------------ *
 * Renewal stops when a deletion is requested (overhaul wave 5, ADR 0042)
 *
 * The subscriptions concerned are the ones the worker's deletion ends (services/worker
 * src/deletion/money.ts `concerned`): paid by the user or on the user's channels, gifts excepted.
 * Those still renewing (`active` or `past_due`, `cancel_at_period_end` false) are set to end at
 * period end, so the paid time runs out during the grace period and nothing is charged again.
 *
 * - Request: the provider first (`stopRenewalsAtProvider`, before the transaction). A provider that
 *   cannot be reached refuses the request, so a scheduled deletion never leaves a card charging;
 *   the subscriptions already stopped for it are turned back on (best effort). Then, in the request
 *   transaction, the local rows (`markRenewalsStopped`): `cancel_at_period_end`, the deletion's
 *   marker and an audit row each (ids and cents only).
 * - Cancel: in the cancel transaction, the manual rows carrying the deletion's marker renew again
 *   (`restoreManualRenewals`; the 0060 trigger clears the marker). After commit, each provider row
 *   is resumed at the provider and then locally (`resumeAtProvider`). A provider failure leaves that
 *   one ending at period end on both sides (consistent, nothing charged) and drops its marker: the
 *   cancel never fails because a provider is down.
 * ------------------------------------------------------------------------------------------------ */

const { channels, subscriptions } = schema;

/** The part of a payment adapter renewal stops need; tests pass their own. */
export type RenewalAdapter = Pick<PaymentAdapter, "provider" | "cancelSubscription" | "resumeSubscription">;

/** The instance's adapter, or null when it cannot be built (then provider rows cannot be stopped). */
export function renewalAdapter(env: PaymentsEnvLike): RenewalAdapter | null {
  try {
    return createAdapter(env);
  } catch {
    return null;
  }
}

/** Raised when a provider-managed subscription's renewal cannot be stopped; nothing is scheduled. */
export class RenewalStopError extends Error {
  readonly code = "RENEWAL_STOP_FAILED";
  constructor(
    readonly subscriptionId: string,
    readonly reason: "no_provider" | "provider_mismatch" | "no_reference" | "provider_error",
  ) {
    super("a provider-managed subscription's renewal could not be stopped");
  }
}

const ownedChannels = (userId: string) =>
  sql`${subscriptions.channelId} in (select ${channels.id} from ${channels} where ${channels.ownerId} = ${userId})`;

/** Subscriptions the user's deletion ends that still renew. */
export function renewingConcerned(userId: string) {
  return and(
    or(eq(subscriptions.subscriberId, userId), ownedChannels(userId)),
    inArray(subscriptions.status, ["active", "past_due"]),
    eq(subscriptions.cancelAtPeriodEnd, false),
    isNull(subscriptions.giftedById),
    isNull(subscriptions.giftPaymentId),
  );
}

export const stopKey = (deletionId: string, subId: string) => `deletion-${deletionId}-stop-${subId}`;
const undoKey = (deletionId: string, subId: string) => `deletion-${deletionId}-undo-${subId}`;
export const resumeKey = (deletionId: string, subId: string) => `deletion-${deletionId}-resume-${subId}`;

/** The provider no longer has the subscription: it charges nothing more. */
const isGone = (err: unknown) =>
  err instanceof StripeApiError && !(err instanceof StripeOutcomeUnknown) && err.status === 404;

interface ProviderRow {
  id: string;
  provider: string;
  ref: string | null;
}

/** Turn back on what this request stopped before it failed (best effort; logged by id). */
async function undoStops(
  adapter: RenewalAdapter | null,
  rows: readonly ProviderRow[],
  deletionId: string,
  logger: Logger,
): Promise<void> {
  for (const r of rows) {
    try {
      if (!adapter?.resumeSubscription || !r.ref) throw new Error("no resume");
      await adapter.resumeSubscription(r.ref, { idempotencyKey: undoKey(deletionId, r.id) });
    } catch {
      // It ends at period end at the provider; the provider's end event ends it here too.
      logger.error("deletion request: a stopped renewal could not be turned back on", {
        subscriptionId: r.id,
        provider: r.provider,
      });
    }
  }
}

export interface StoppedRenewals {
  /** Provider-managed subscriptions set to end at period end at the provider. */
  ids: string[];
  /** Turn them back on (the request's transaction failed after the provider calls). */
  undo(): Promise<void>;
}

/**
 * Before the request transaction: set every provider-managed subscription the deletion concerns to
 * end at period end at the provider. Throws `RenewalStopError` (after undoing the ones it stopped)
 * when one cannot be stopped.
 */
export async function stopRenewalsAtProvider(
  db: Executor,
  adapter: RenewalAdapter | null,
  userId: string,
  deletionId: string,
  logger: Logger,
): Promise<StoppedRenewals> {
  const rows = await db
    .select({ id: subscriptions.id, provider: subscriptions.provider, ref: subscriptions.providerRef })
    .from(subscriptions)
    .where(and(renewingConcerned(userId), ne(subscriptions.provider, "manual")));
  const stopped: ProviderRow[] = [];
  for (const r of rows) {
    let reason: RenewalStopError["reason"] | null = null;
    let providerStatus: number | null = null;
    if (!adapter?.cancelSubscription) reason = "no_provider";
    else if (adapter.provider !== r.provider) reason = "provider_mismatch";
    else if (!r.ref) reason = "no_reference";
    else {
      try {
        await adapter.cancelSubscription(r.ref, { atPeriodEnd: true, idempotencyKey: stopKey(deletionId, r.id) });
      } catch (err) {
        if (!isGone(err)) {
          reason = "provider_error";
          providerStatus = err instanceof StripeApiError ? err.status : null;
        }
      }
    }
    if (reason) {
      logger.error("deletion request refused: a subscription's renewal could not be stopped", {
        subscriptionId: r.id,
        provider: r.provider,
        reason,
        providerStatus,
      });
      await undoStops(adapter, stopped, deletionId, logger);
      throw new RenewalStopError(r.id, reason);
    }
    stopped.push(r);
  }
  return { ids: stopped.map((r) => r.id), undo: () => undoStops(adapter, stopped, deletionId, logger) };
}

/**
 * In the request transaction: renewal off locally, marked with the deletion, one audit row each.
 * Provider rows are marked only when the provider stopped them (`providerStopped`); one created in
 * between still ends at completion. Returns how many were marked.
 */
export async function markRenewalsStopped(
  tx: Executor,
  input: { userId: string; deletionId: string; providerStopped: readonly string[]; actorId: string; now: Date },
): Promise<number> {
  const which =
    input.providerStopped.length > 0
      ? or(eq(subscriptions.provider, "manual"), inArray(subscriptions.id, [...input.providerStopped]))
      : eq(subscriptions.provider, "manual");
  const marked = await tx
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: input.deletionId, updatedAt: input.now })
    .where(and(renewingConcerned(input.userId), which))
    .returning({ id: subscriptions.id, channelId: subscriptions.channelId, priceCents: subscriptions.priceCents });
  for (const m of marked)
    await audit(tx, {
      actorType: "user",
      actorId: input.actorId,
      action: "subscription.renewal_stop",
      subjectType: "subscription",
      subjectId: m.id,
      channelId: m.channelId,
      details: { deletionId: input.deletionId, subscriptionId: m.id, priceCents: m.priceCents },
    });
  return marked.length;
}

const markedBy = (deletionId: string) =>
  and(eq(subscriptions.renewalStoppedByDeletionId, deletionId), inArray(subscriptions.status, ["active", "past_due"]));

async function resumeAudit(
  tx: Executor,
  input: { deletionId: string; actorId: string },
  sub: { id: string; channelId: string },
  resumed: boolean,
): Promise<void> {
  await audit(tx, {
    actorType: "user",
    actorId: input.actorId,
    action: "subscription.renewal_resume",
    subjectType: "subscription",
    subjectId: sub.id,
    channelId: sub.channelId,
    details: { deletionId: input.deletionId, subscriptionId: sub.id, resumed },
  });
}

/**
 * In the cancel transaction: the manual subscriptions this deletion stopped renew again. Returns the
 * provider-managed ones, for `resumeAtProvider` after commit.
 */
export async function restoreManualRenewals(
  tx: Executor,
  input: { deletionId: string; actorId: string; now: Date },
): Promise<ProviderRow[]> {
  const rows = await tx
    .select({
      id: subscriptions.id,
      provider: subscriptions.provider,
      ref: subscriptions.providerRef,
      channelId: subscriptions.channelId,
    })
    .from(subscriptions)
    .where(markedBy(input.deletionId))
    .for("update");
  const manual = rows.filter((r) => r.provider === "manual");
  if (manual.length > 0) {
    // The 0060 trigger clears the marker when renewal turns back on.
    await tx
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: false, updatedAt: input.now })
      .where(
        and(
          markedBy(input.deletionId),
          inArray(
            subscriptions.id,
            manual.map((m) => m.id),
          ),
        ),
      );
    for (const m of manual) await resumeAudit(tx, input, m, true);
  }
  return rows.filter((r) => r.provider !== "manual").map(({ id, provider, ref }) => ({ id, provider, ref }));
}

/**
 * After the cancel commits: resume each provider row at the provider, then locally. One the
 * provider refuses stays ending at period end on both sides, without the marker. Returns how many
 * renew again.
 */
export async function resumeAtProvider(
  db: Executor,
  adapter: RenewalAdapter | null,
  rows: readonly ProviderRow[],
  input: { deletionId: string; actorId: string; now: Date },
  logger: Logger,
): Promise<number> {
  let resumed = 0;
  for (const r of rows) {
    let ok = false;
    try {
      if (adapter?.resumeSubscription && adapter.provider === r.provider && r.ref) {
        await adapter.resumeSubscription(r.ref, { idempotencyKey: resumeKey(input.deletionId, r.id) });
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok)
      logger.warn("deletion canceled: a subscription's renewal could not be turned back on", {
        subscriptionId: r.id,
        provider: r.provider,
      });
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(subscriptions)
        .set(ok ? { cancelAtPeriodEnd: false, updatedAt: input.now } : { renewalStoppedByDeletionId: null })
        .where(and(eq(subscriptions.id, r.id), markedBy(input.deletionId)))
        .returning({ id: subscriptions.id, channelId: subscriptions.channelId });
      if (row) await resumeAudit(tx, input, row, ok);
      return row !== undefined && ok;
    });
    if (done) resumed++;
  }
  return resumed;
}
