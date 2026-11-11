// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.deletion.preview` (overhaul wave 4, D7.4): what deleting the account changes, read from the
 * caller's own rows, so the settings dialog says what really happens (fix F0,
 * services/worker/src/deletion/money.ts) before the member asks for it:
 *
 * - subscriptions the member pays for, and paid ones on the member's channel, gifts excepted, end
 *   when the deletion completes (the worker cancels them at the provider and locally);
 * - earnings not yet paid out stay owed and follow the payout rules (the ledger is append-only);
 * - every active co-op membership exits, and a held share goes to the treasurer as
 *   `refund_pending` only when the bylaws make the viewer share refundable on exit (ADR 0020);
 * - a legal hold keeps the records it covers (ADR 0004).
 *
 * Read-only: counts and amounts only, nothing written, nothing logged about the member.
 */
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DeletionPreview } from "@commonair/contracts/dto";
import { schema, type Executor } from "@commonair/db";
import { loadSettings, membershipClassesOf } from "@commonair/governance";
import { creatorBalances } from "@commonair/ledger";
import { DELETION_GRACE_DAYS, scheduledDeletion, toDeletion } from "../moderation/deletion.ts";

const s = schema;

/** The statuses the worker ends as paid subscriptions (`incomplete` ones only expire, unpaid). */
const PAYING = ["active", "past_due"] as const;

/**
 * Only a litigation hold is shown to the member it covers. Holds placed for a hash match, a
 * confirmed report or a law-enforcement request are never disclosed to their subject, so the
 * preview cannot tip anyone off (conservative default; the account is deleted either way).
 */
const DISCLOSED_HOLDS = ["litigation"] as const;

/** Unpaid earnings in cents: released (a receivable larger than it shows as nothing owed), held and reserved. */
export function unpaidCents(b: { availableCents: number; holdCents: number; reservedCents: number }): number {
  return Math.max(0, b.availableCents) + Math.max(0, b.holdCents) + Math.max(0, b.reservedCents);
}

/** One query: paid subscriptions the member pays for, and those paid on the member's channels. */
async function subscriptionCounts(
  db: Executor,
  userId: string,
): Promise<{ activeSubscriptions: number; channelSubscriptions: number }> {
  const owned = db.select({ id: s.channels.id }).from(s.channels).where(eq(s.channels.ownerId, userId));
  const [row] = await db
    .select({
      paying: sql<number>`count(*) filter (where ${s.subscriptions.subscriberId} = ${userId})::int`,
      onChannel: sql<number>`count(*) filter (where ${s.subscriptions.channelId} in ${owned})::int`,
    })
    .from(s.subscriptions)
    .where(
      and(
        or(eq(s.subscriptions.subscriberId, userId), inArray(s.subscriptions.channelId, owned)),
        inArray(s.subscriptions.status, [...PAYING]),
        // Gifts never renew and expire on their own; the deletion leaves them alone.
        isNull(s.subscriptions.giftedById),
        isNull(s.subscriptions.giftPaymentId),
      ),
    );
  return { activeSubscriptions: Number(row?.paying ?? 0), channelSubscriptions: Number(row?.onChannel ?? 0) };
}

export async function deletionPreview(db: Executor, userId: string, currency: string): Promise<DeletionPreview> {
  const [subs, balances, memberships, share, holds, scheduled] = await Promise.all([
    subscriptionCounts(db, userId),
    creatorBalances(db, userId, currency),
    db
      .select({ class: s.memberships.class })
      .from(s.memberships)
      .where(and(eq(s.memberships.userId, userId), eq(s.memberships.status, "active")))
      .orderBy(s.memberships.class),
    db
      .select({ amountCents: s.membershipShares.amountCents, currency: s.membershipShares.currency })
      .from(s.membershipShares)
      .where(and(eq(s.membershipShares.userId, userId), eq(s.membershipShares.status, "held")))
      .limit(1),
    db
      .select({ n: count() })
      .from(s.legalHolds)
      .where(
        and(
          eq(s.legalHolds.userId, userId),
          isNull(s.legalHolds.releasedAt),
          inArray(s.legalHolds.reasonCode, [...DISCLOSED_HOLDS]),
        ),
      ),
    scheduledDeletion(db, userId),
  ]);
  const held = share[0];
  // Settings are read only when there is a share to judge (as the deletion job does).
  const refundable =
    held !== undefined && membershipClassesOf(await loadSettings(db)).viewer.shareRefundableOnExit === true;
  const pending = unpaidCents(balances);
  return {
    graceDays: DELETION_GRACE_DAYS,
    ...subs,
    pendingPayout: pending > 0 ? { cents: pending, currency } : null,
    memberships: memberships.map((m) => ({
      class: m.class,
      // The share is the viewer class's buy-in; only that membership carries it.
      shareRefund:
        m.class === "viewer" && refundable && held ? { cents: held.amountCents, currency: held.currency } : null,
    })),
    legalHold: (holds[0]?.n ?? 0) > 0,
    scheduled: scheduled ? toDeletion(scheduled) : null,
  };
}
