// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure rules behind checkout and the treasurer's payment actions (see README.md). */
import type { PAYMENT_STATUSES, SUBSCRIPTION_STATUSES } from "@commonair/contracts/enums";

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type TierNumber = 1 | 2 | 3;

export const TIER_NAME_MAX = 50;
export const TIER_BENEFITS_MAX = 500;
/** How far back a chat message counts toward a channel's gift community. */
export const GIFT_POOL_CHAT_DAYS = 30;

/** Subscriptions that hold the (subscriber, channel) slot: `subscriptions_active_uq`. */
export const HOLDING_SUBSCRIPTION_STATUSES = ["active", "past_due", "incomplete"] as const;
export const REFUNDABLE_PAYMENT_STATUSES = ["succeeded", "partially_refunded"] as const;

/** EventSub tier strings. */
export const tierCode = (tier: number): "1000" | "2000" | "3000" => {
  if (tier === 1) return "1000";
  if (tier === 2) return "2000";
  if (tier === 3) return "3000";
  throw new RangeError(`tier ${tier} is not 1–3`);
};

/**
 * One calendar month later in UTC, keeping the time of day. A day the next month lacks clamps to
 * its last day (Jan 31 → Feb 28, or Feb 29 in a leap year).
 */
export function addOneMonthUtc(d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const ty = y + Math.floor(m / 12);
  const tm = m % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      ty,
      tm,
      Math.min(d.getUTCDate(), lastDay),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}

export interface TierInput {
  tier: number;
  name: string;
  price: { cents: number; currency: string };
  benefits: string;
}
export interface TierRow {
  tier: TierNumber;
  name: string;
  priceCents: number;
  benefits: string;
}

/**
 * Exactly tiers 1, 2 and 3 once each, strictly increasing in price, in the instance currency, with
 * a non-empty name. Returns the rows to store (sorted, trimmed) or the reason they are refused.
 */
export function validateTiers(
  tiers: readonly TierInput[],
  currency: string,
): { ok: true; rows: TierRow[] } | { ok: false; reason: string } {
  if (tiers.length !== 3) return { ok: false, reason: "Set exactly three tiers" };
  const sorted = [...tiers].sort((a, b) => a.tier - b.tier);
  if (sorted.some((t, i) => t.tier !== i + 1)) return { ok: false, reason: "Tiers must be 1, 2 and 3, once each" };
  const rows: TierRow[] = [];
  for (const t of sorted) {
    if (t.price.currency.toLowerCase() !== currency)
      return { ok: false, reason: `Tier prices must be in ${currency.toUpperCase()}` };
    if (!Number.isSafeInteger(t.price.cents) || t.price.cents <= 0)
      return { ok: false, reason: "Tier prices must be whole cents" };
    const name = t.name.trim();
    if (name.length === 0 || name.length > TIER_NAME_MAX)
      return { ok: false, reason: `Tier names need 1–${TIER_NAME_MAX} characters` };
    const benefits = t.benefits.trim();
    if (benefits.length > TIER_BENEFITS_MAX)
      return { ok: false, reason: `Tier benefits are at most ${TIER_BENEFITS_MAX} characters` };
    rows.push({ tier: t.tier as TierNumber, name, priceCents: t.price.cents, benefits });
  }
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev && cur && cur.priceCents <= prev.priceCents)
      return { ok: false, reason: "Each tier must cost more than the one below it" };
  }
  return { ok: true, rows };
}

/** Gift input rules the contract cannot express (it already enforces `to` ⇒ `count: 1`). */
export function giftInputProblem(
  gift: { count: number; to?: string | undefined },
  callerUsername: string,
): string | null {
  if (gift.to !== undefined && gift.to.toLowerCase() === callerUsername.toLowerCase())
    return "You cannot gift a subscription to yourself";
  if (gift.to !== undefined && gift.count !== 1) return "A named recipient gets exactly one gift";
  return null;
}

/** Gift total in cents; `count × price` stays an exact integer. */
export function giftTotalCents(priceCents: number, count: number): number {
  const total = priceCents * count;
  if (!Number.isSafeInteger(total) || total <= 0) throw new RangeError("gift total out of range");
  return total;
}

/** What a refund or chargeback leaves behind, or why it is refused. */
export function disputeOutcome(
  kind: "refund" | "chargeback",
  payment: { status: PaymentStatus; amountCents: number; refundedCents: number },
  amountCents: number,
):
  | { ok: true; refundedCents: number; status: PaymentStatus; endsSubscriptions: boolean }
  | { ok: false; code: "CONFLICT" | "BAD_REQUEST"; reason: string } {
  if (!(REFUNDABLE_PAYMENT_STATUSES as readonly string[]).includes(payment.status))
    return {
      ok: false,
      code: "CONFLICT",
      reason: `A ${payment.status} payment cannot be ${kind === "refund" ? "refunded" : "charged back"}`,
    };
  const rest = payment.amountCents - payment.refundedCents;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
    return { ok: false, code: "BAD_REQUEST", reason: "The amount must be positive whole cents" };
  if (amountCents > rest)
    return { ok: false, code: "BAD_REQUEST", reason: `At most ${rest} cents of this payment can still be reversed` };
  const refundedCents = payment.refundedCents + amountCents;
  const full = refundedCents === payment.amountCents;
  if (kind === "chargeback") return { ok: true, refundedCents, status: "charged_back", endsSubscriptions: true };
  return { ok: true, refundedCents, status: full ? "refunded" : "partially_refunded", endsSubscriptions: full };
}

/**
 * The period a confirmed payment buys. A renewal (the subscription is `past_due` with a period on
 * record) continues from the previous period end; anything else starts when the money arrived.
 */
export function confirmedPeriod(
  sub: { status: SubscriptionStatus; currentPeriodEnd: Date | null },
  receivedAt: Date,
): { start: Date; end: Date; renewal: boolean } {
  const renewal = sub.status === "past_due" && sub.currentPeriodEnd !== null;
  const start = renewal && sub.currentPeriodEnd ? sub.currentPeriodEnd : receivedAt;
  return { start, end: addOneMonthUtc(start), renewal };
}

/** Recipient cancellation rules: own, not a gift, `active` or `past_due`; repeating it is a no-op. */
export function cancelProblem(sub: {
  status: SubscriptionStatus;
  gifted: boolean;
  cancelAtPeriodEnd: boolean;
}): { code: "PRECONDITION_FAILED" | "CONFLICT"; reason: string } | null {
  if (sub.gifted) return { code: "PRECONDITION_FAILED", reason: "Gifted subscriptions end on their own" };
  if (sub.status !== "active" && sub.status !== "past_due")
    return { code: "CONFLICT", reason: `A ${sub.status} subscription cannot be cancelled` };
  return null;
}
