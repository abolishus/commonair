// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Queries and row → DTO mapping shared by the checkout and treasurer handlers. */
import { type SQL, and, asc, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { type Executor, schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { emit, broadcasterFields, userFields } from "../events/outbox.ts";
import { publishControl } from "../lib/control.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { HOLDING_SUBSCRIPTION_STATUSES, type TierNumber, tierCode } from "./checkout-rules.ts";

const { subscriptions, users, channels, channelSubTiers } = schema;
type SubscriptionRow = typeof subscriptions.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

export type SubscriptionDto = z.infer<typeof dto.Subscription>;
export type SubTierDto = z.infer<typeof dto.SubTierInfo>;

/** The channel's tiers, or `[]` unless all three are set (subscriptions need all three). */
export async function loadTiers(db: Executor, channelId: string, currency: string): Promise<SubTierDto[]> {
  const rows = await db
    .select()
    .from(channelSubTiers)
    .where(eq(channelSubTiers.channelId, channelId))
    .orderBy(asc(channelSubTiers.tier));
  const complete = rows.length === 3 && rows.every((r, i) => r.tier === i + 1);
  if (!complete) return [];
  return rows.map((r) => ({
    tier: r.tier as TierNumber,
    name: r.name,
    price: { cents: r.priceCents, currency },
    benefits: r.benefits,
  }));
}

/** Subscriptions joined with their subscriber and channel slug, as DTOs. */
export async function subscriptionDtos(
  db: Executor,
  where: SQL | undefined,
  opts: { limit: number },
): Promise<SubscriptionDto[]> {
  const rows = await db
    .select({ s: subscriptions, slug: channels.slug, uid: users.id, username: users.username, name: users.name })
    .from(subscriptions)
    .innerJoin(channels, eq(channels.id, subscriptions.channelId))
    .innerJoin(users, eq(users.id, subscriptions.subscriberId))
    .where(where)
    .orderBy(desc(subscriptions.id))
    .limit(opts.limit);
  return rows.map((r) => toSubscriptionDto(r.s, r.slug, { id: r.uid, username: r.username, displayName: r.name }));
}

export function toSubscriptionDto(
  s: SubscriptionRow,
  channelSlug: string,
  subscriber: { id: string; username: string; displayName: string },
): SubscriptionDto {
  return {
    id: s.id,
    channelSlug,
    subscriber,
    tier: s.tier,
    status: s.status,
    provider: s.provider,
    currentPeriodEnd: isoOrNull(s.currentPeriodEnd),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    gifted: s.giftedById !== null || s.giftPaymentId !== null,
    createdAt: iso(s.createdAt),
  };
}

/** The caller's subscription that holds the channel slot (`active`, `past_due` or `incomplete`). */
export async function holdingSubscription(
  db: Executor,
  userId: string,
  channelId: string,
): Promise<SubscriptionDto | null> {
  const [s] = await subscriptionDtos(
    db,
    and(
      eq(subscriptions.subscriberId, userId),
      eq(subscriptions.channelId, channelId),
      inArray(subscriptions.status, [...HOLDING_SUBSCRIPTION_STATUSES]),
    ),
    { limit: 1 },
  );
  return s ?? null;
}

export async function userEventFields(db: Executor, userId: string | null) {
  if (!userId) return null;
  const [u] = await db
    .select({ id: users.id, username: users.username, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  return u ? userFields(u) : null;
}

/**
 * End subscriptions now (`canceled`) with `channel.subscription.end` each, compare-and-set on the
 * statuses that hold the slot. Returns the subscriber ids whose chat badge must be refreshed.
 */
export async function endSubscriptions(tx: Executor, channel: ChannelRow, where: SQL, now: Date): Promise<string[]> {
  const ended = await tx
    .update(subscriptions)
    .set({ status: "canceled", cancelAtPeriodEnd: false, updatedAt: now })
    .where(and(where, inArray(subscriptions.status, [...HOLDING_SUBSCRIPTION_STATUSES])))
    .returning();
  for (const s of ended) {
    const user = await userEventFields(tx, s.subscriberId);
    if (!user) continue;
    await emit(
      tx,
      "channel.subscription.end",
      channel.id,
      {
        ...broadcasterFields(channel),
        ...user,
        tier: tierCode(s.tier),
        is_gift: s.giftedById !== null || s.giftPaymentId !== null,
      },
      now,
    );
  }
  return ended.map((s) => s.subscriberId);
}

/** After commit: chat drops its cached badges for these users. */
export async function invalidateSubscribers(deps: Deps, channelId: string, userIds: readonly string[]) {
  for (const userId of new Set(userIds))
    await publishControl(deps, channelId, { op: "invalidate", scope: "user", userId });
}

/** SQLSTATE 23505 on a named constraint (drizzle wraps the driver error in `cause`). */
export function violatesConstraint(err: unknown, ...names: string[]): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const x = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    const name = typeof x.constraint_name === "string" ? x.constraint_name : x.constraint;
    if (x.code === "23505" && typeof name === "string" && names.includes(name)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
