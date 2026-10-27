// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared rules for `account_actions` (DMCA strikes and the repeat-infringer suspension). The API
 * (DMCA, appeals) and the worker (dmca-restore) both record and reverse them, in parallel; the
 * rules live here so they cannot drift. Callers write the `account.action.*` outbox event and the
 * audit row themselves, and publish the user-control invalidation after commit.
 */
import { ACCOUNT_ACTIONS, ACCOUNT_ACTION_REVERSALS, DMCA_RULES } from "@commonair/contracts/enums";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Executor } from "./client.ts";
import { accountActions } from "./schema/safety.ts";
import { users } from "./schema/auth.ts";

export type AccountActionRow = typeof accountActions.$inferSelect;
export type AccountActionKind = (typeof ACCOUNT_ACTIONS)[number];
export type AccountActionReversal = (typeof ACCOUNT_ACTION_REVERSALS)[number];

/** `users.ban_reason` of the repeat-infringer suspension; nothing else may lift it here. */
export const DMCA_SUSPENSION_REASON = "dmca_repeat_infringer";

const DAY_MS = 86_400_000;

/**
 * Take the per-user account-actions lock for the rest of the transaction. Every path that records
 * or reverses an account action for a user takes it first, so strike counts and the termination
 * decision see one consistent set of rows. Re-entrant within a transaction.
 */
export async function lockAccountActions(tx: Executor, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account_actions:${userId}`}, 0))`);
}

/** Unreversed `dmca_strike` rows created within `DMCA_RULES.strikeWindowDays` before `now`. */
export async function activeDmcaStrikes(tx: Executor, userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - DMCA_RULES.strikeWindowDays * DAY_MS);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountActions)
    .where(
      and(
        eq(accountActions.userId, userId),
        eq(accountActions.action, "dmca_strike"),
        isNull(accountActions.reversedAt),
        gt(accountActions.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** The unreversed row of that action for the user (the most recent if several), or `null`. */
export async function activeAccountAction(
  tx: Executor,
  userId: string,
  action: AccountActionKind,
): Promise<AccountActionRow | null> {
  const [row] = await tx
    .select()
    .from(accountActions)
    .where(and(eq(accountActions.userId, userId), eq(accountActions.action, action), isNull(accountActions.reversedAt)))
    .orderBy(sql`${accountActions.createdAt} desc`)
    .limit(1);
  return row ?? null;
}

/**
 * Reverse an account action once (compare-and-set on `reversed_at is null`). Returns the reversed
 * row, or `null` when it was already reversed (or does not exist).
 */
export async function reverseAccountActionInTx(
  tx: Executor,
  args: { id: string; now: Date; byId: string | null; reason: AccountActionReversal; appealId?: string },
): Promise<AccountActionRow | null> {
  const [row] = await tx
    .update(accountActions)
    .set({
      reversedAt: args.now,
      reversedById: args.byId,
      reversedReason: args.reason,
      reversalAppealId: args.appealId ?? null,
    })
    .where(and(eq(accountActions.id, args.id), isNull(accountActions.reversedAt)))
    .returning();
  return row ?? null;
}

/**
 * Lift the repeat-infringer suspension, and only that one: a moderation or T0 suspension is left
 * alone. Returns whether the user was unsuspended. Callers publish `BUS.userControl` invalidate
 * after commit.
 */
export async function liftDmcaSuspensionInTx(tx: Executor, userId: string): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ banned: false, banReason: null, banExpires: null })
    .where(and(eq(users.id, userId), eq(users.banned, true), eq(users.banReason, DMCA_SUSPENSION_REASON)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * After a strike was reversed: if the user has an unreversed `dmca_termination` and is now below
 * `DMCA_RULES.repeatInfringerStrikes` (or the automatic suspension is off), reverse it with
 * `strikes_below_threshold` and lift the repeat-infringer suspension. Returns the reversed
 * termination, or `null` when nothing changed.
 */
export async function reconcileDmcaTerminationInTx(
  tx: Executor,
  args: {
    userId: string;
    now: Date;
    byId: string | null;
    /** Tests only; defaults to `DMCA_RULES.repeatInfringerStrikes`. */
    threshold?: number;
  },
): Promise<AccountActionRow | null> {
  await lockAccountActions(tx, args.userId);
  const termination = await activeAccountAction(tx, args.userId, "dmca_termination");
  if (!termination) return null;
  const threshold: number = args.threshold ?? DMCA_RULES.repeatInfringerStrikes;
  if (threshold > 0 && (await activeDmcaStrikes(tx, args.userId, args.now)) >= threshold) return null;
  const reversed = await reverseAccountActionInTx(tx, {
    id: termination.id,
    now: args.now,
    byId: args.byId,
    reason: "strikes_below_threshold",
  });
  if (reversed) await liftDmcaSuspensionInTx(tx, args.userId);
  return reversed;
}
