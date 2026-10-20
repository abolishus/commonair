// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sample data for the Support board, matching the shipped dialog on the manual adapter: tiers,
 * gift presets, tip presets, the streamer/co-op split and the reference panel after checkout.
 * Money is integer cents.
 */

export const channel = { name: "rivertide", accent: "teal" as const };

export type SupportTab = "sub" | "gift" | "tip";

export const tiers = [
  { value: "1", title: "Tier 1", cents: 499, perks: "Sub badge, emotes, ad-free forever (there are no ads anyway)" },
  {
    value: "2",
    title: "Tier 2",
    cents: 999,
    perks: "Everything in Tier 1, bonus emotes, supporter role in the Discord",
  },
  { value: "3", title: "Tier 3", cents: 2499, perks: "Everything in Tier 2, name in the credits, monthly patch file" },
];

/** Gift presets (the count input below takes any value from 1 to `maxCount`). */
export const giftPresets = [1, 5, 10, 25];
export const recipients = [
  { value: "random", label: "Random community members" },
  { value: "viewer", label: "A specific viewer" },
];
export const gift = {
  defaultCount: "5",
  maxCount: 100,
  randomHint: "Recipients are drawn from people who chatted here in the last 30 days or follow the channel.",
};

/** Tip presets in cents; the story labels them with formatMoney. */
export const tipPresetCents = [200, 500, 1000, 2000];
export const tip = { cents: 500, minCents: 100, maxCents: 1_000_000, messageMaxLength: 300 };

/**
 * The split the co-op voted for: streamer and co-op shares only. Processing is the co-op's cost,
 * not a segment the supporter pays on top (the manual adapter has none).
 */
export const split = { creatorPercent: 90, coopPercent: 10 };

export const reasons = {
  noTiers: "This channel has not set up subscriptions yet, but it takes tips.",
};

/** What `money.subscribe` / `money.tip` return on the manual adapter (`kind: "instructions"`). */
export const instructions = {
  reference: "CA-7K2M9QXA",
  amount: { cents: 999, currency: "USD" },
  text: "Pay the co-op by bank transfer to the account listed on the transparency page.\nQuote the reference in the transfer so the treasurer can match it.",
  hint: "Quote the reference with your payment. It is confirmed once the co-op's treasurer receives it.",
};
