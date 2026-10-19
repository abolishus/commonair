// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Support board (subscribe / gift / tip dialog). Money is integer cents. */
import type { BreakdownSegment } from "@commonair/ui/blocks/data";

export const channel = { name: "rivertide", accent: "teal" as const };

export type SupportTab = "sub" | "gift" | "tip";

export const tiers = [
  { value: "1", title: "Tier 1", cents: 499, perks: "Sub badge, emotes, ad-free forever (there are no ads anyway)" },
  { value: "2", title: "Tier 2", cents: 999, perks: "Everything in Tier 1, bonus emotes, supporter role in the Discord" },
  { value: "3", title: "Tier 3", cents: 2499, perks: "Everything in Tier 2, name in the credits, monthly patch file" },
];

export const giftCounts = ["1", "5", "10", "25", "Custom"].map((value) => ({ value, label: value }));
export const recipients = [
  { value: "random", label: "Random active chatters" },
  { value: "viewer", label: "A specific viewer" },
];
export const gift = { count: "5", label: "5 × Tier 1", cents: 2495 };

export const tipPresets = [200, 500, 1000, 2000].map((value) => ({ value, label: `$${value / 100}` }));
export const tip = { cents: 500 };

/** Where $5.00 goes; split set by member vote (proposal #41). */
export const split: BreakdownSegment[] = [
  { id: "creator", label: "Creator", value: 355, color: "--chart-1" },
  { id: "ops", label: "Co-op operations & infrastructure", value: 70, color: "--chart-2" },
  { id: "patronage", label: "Patronage pool (returned to members)", value: 45, color: "--chart-3" },
  { id: "processing", label: "Payment processing", value: 30, color: "--chart-4" },
];

export const paymentMethods = [
  { value: "card", label: "Card ending 4242" },
  { value: "add", label: "Add a payment method" },
];

export const smallPrint = "Cancel any time from Settings › Subscriptions. Prices include tax where applicable.";
