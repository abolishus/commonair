// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-money's fixed text and amounts. Nothing here names a person: tip messages are generic
 * cheers, reasons and references are seed markers, cost descriptions are line items.
 */

/** Tip amounts in integer cents, with relative weights (small tips are the common case). */
export const TIP_AMOUNTS: readonly { cents: number; weight: number }[] = [
  { cents: 100, weight: 8 },
  { cents: 200, weight: 7 },
  { cents: 300, weight: 6 },
  { cents: 500, weight: 8 },
  { cents: 700, weight: 3 },
  { cents: 1_000, weight: 5 },
  { cents: 1_500, weight: 2 },
  { cents: 2_000, weight: 2 },
  { cents: 2_500, weight: 1 },
  { cents: 5_000, weight: 1 },
];

export const TIP_MESSAGES = [
  "",
  "",
  "Great stream today!",
  "For the coffee fund",
  "That last round was amazing",
  "Thanks for the tutorial",
  "Keep it up",
  "Love the new overlay",
  "Happy streamiversary",
  "Hydrate!",
  "GG",
  "From the late-night crew",
] as const;

/** Share of tips sent anonymously. */
export const ANONYMOUS_TIP_SHARE = 0.15;

/** Tier picks for bulk subscriptions (1 is the common case). */
export const TIER_WEIGHTS: readonly { tier: 1 | 2 | 3; weight: number }[] = [
  { tier: 1, weight: 6 },
  { tier: 2, weight: 3 },
  { tier: 3, weight: 1 },
];

/** Monthly infrastructure costs: category slug, line item and a base amount in cents. */
export const COST_LINES: readonly { category: string; description: string; baseCents: number }[] = [
  { category: "hosting", description: "Application servers", baseCents: 42_000 },
  { category: "bandwidth", description: "Video egress", baseCents: 31_000 },
  { category: "storage", description: "Object storage for VODs and clips", baseCents: 9_500 },
  { category: "database", description: "Managed database and backups", baseCents: 12_000 },
  { category: "email", description: "Transactional email", baseCents: 1_500 },
];

export const REFUND_REASON = "seed: refund requested by the supporter";
export const PARTIAL_REFUND_REASON = "seed: partial refund of a duplicate amount";
export const CHARGEBACK_REASON = "seed: chargeback reported by the bank";
export const FRAUD_NOTE = "seed: payout pattern to review";
export const FRAUD_REVIEW_NOTE = "seed: first review";
export const FRAUD_DECISION_NOTE = "seed: second review";
export const PAYOUT_SENT_REFERENCE = "seed: bank transfer sent";
export const WRITE_OFF_NOTE = "seed: owner cannot cover the crew's charged-back share";
/** The treasurer's reference for a manual payout arrangement (never bank details). */
export const payoutReference = (handle: string): string => `seed-manual-${handle}`;
