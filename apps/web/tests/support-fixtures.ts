// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample `SupportInfo` / `Subscription` DTOs for the support and subscriptions tests. */
import { MONEY_LIMITS } from "@commonair/contracts/currency";
import type { SubscriptionDto, SupportInfo } from "../src/lib/support.ts";

export const TIERS: SupportInfo["tiers"] = [
  { tier: 1, name: "Tier 1", price: { cents: 499, currency: "usd" }, benefits: "Badge and emotes" },
  { tier: 2, name: "Tier 2", price: { cents: 999, currency: "usd" }, benefits: "" },
  { tier: 3, name: "Tier 3", price: { cents: 2499, currency: "usd" }, benefits: "Credits" },
];

export function subscription(over: Partial<SubscriptionDto> = {}): SubscriptionDto {
  return {
    id: "0192f000-0000-7000-8000-000000000001",
    channelSlug: "rivertide",
    subscriber: { id: "u1", username: "fan", displayName: "Fan" },
    tier: 2,
    status: "active",
    provider: "manual",
    currentPeriodEnd: "2026-11-19T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    gifted: false,
    createdAt: "2026-10-19T12:00:00.000Z",
    ...over,
  };
}

export function supportInfo(over: Partial<SupportInfo> = {}): SupportInfo {
  return {
    provider: "manual",
    currency: "usd",
    tiers: TIERS,
    split: { streamerShare: 0.9, coopShare: 0.1 },
    tip: {
      minCents: MONEY_LIMITS.tipMinCents,
      maxCents: MONEY_LIMITS.tipMaxCents,
      messageMaxLength: MONEY_LIMITS.tipMessageMaxLength,
    },
    gift: { maxCount: MONEY_LIMITS.giftMaxCount },
    viewer: { subscription: null, isOwner: false },
    ...over,
  };
}
