// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/creators` fee calculator (overhaul D2.4, market-research P1). Competitor rates are a
 * dated, sourced table kept in the repo, never fetched: each row names the condition its rate
 * needs, its source page and the day we last read it (`docs/design/2026-11-overhaul/market-research.md`
 * §6). Assumptions (round 2, open question 3): Patreon and Ko-fi card processing at 2.9% + 30¢ a
 * payment, a $10 average tip, and Twitch Bits left out. All money is integer cents.
 */

/** The day the competitor figures were last read on their source pages. */
export const RATES_CHECKED = "2026-11-06";

/** The average tip used to count tip payments for per-payment card fees. */
export const AVERAGE_TIP_CENTS = 1000;

/** The card processing the calculator charges where the creator pays it. */
export const CARD_PROCESSING = { rate: 0.029, fixedCents: 30 } as const;

export type CompetitorId = "kick" | "youtube" | "twitch" | "patreon" | "kofi";
export type PlatformId = "commonair" | CompetitorId;

export interface PlatformRate {
  id: PlatformId;
  /** Share of each sub the creator keeps (before card fees they pay). */
  subShare: number;
  /** Share of each tip; null when the platform's tips are not counted (Twitch Bits). */
  tipShare: number | null;
  /** The sub price is fixed by the platform (Kick's $5), whatever the creator would charge. */
  fixedSubPriceCents?: number;
  /** Card processing the creator pays per payment. */
  card?: { rate: number; fixedCents: number };
  /** A higher sub share the platform offers after a status condition (Twitch's 70%). */
  altSubShare?: number;
  source: { url: string; label: string; secondary?: boolean } | null;
}

/** Competitors, in the order the table lists them (market-research §6 "Fee sources"). */
export const COMPETITOR_RATES: readonly PlatformRate[] = [
  {
    id: "kick",
    subShare: 0.95,
    tipShare: 1,
    fixedSubPriceCents: 500,
    source: { url: "https://help.kick.com/", label: "Kick Help Center" },
  },
  {
    id: "youtube",
    subShare: 0.7,
    tipShare: 0.7,
    source: { url: "https://support.google.com/youtube/answer/72902", label: "YouTube Help" },
  },
  {
    id: "twitch",
    subShare: 0.5,
    tipShare: null,
    altSubShare: 0.7,
    source: { url: "https://help.twitch.tv/s/article/plus-program", label: "Twitch Help" },
  },
  {
    id: "patreon",
    subShare: 0.9,
    tipShare: 0.9,
    card: CARD_PROCESSING,
    source: { url: "https://support.patreon.com/hc/en-us/articles/36426991446797", label: "Patreon Help Center" },
  },
  {
    id: "kofi",
    subShare: 0.95,
    tipShare: 1,
    card: CARD_PROCESSING,
    source: { url: "https://help.ko-fi.com/", label: "Ko-fi Help", secondary: true },
  },
];

/** CommonAir's row: the member-voted `platform.cut`; card fees come out of the co-op's share. */
export function commonAirRate(creatorShare: number): PlatformRate {
  return { id: "commonair", subShare: creatorShare, tipShare: creatorShare, source: null };
}

export interface CalcInput {
  subscribers: number;
  /** The creator's average sub price. */
  subPriceCents: number;
  /** Tips in a month, in total. */
  tipsCents: number;
}

export interface CalcRow {
  id: PlatformId;
  /** What the creator takes home in a month, never below zero. */
  netCents: number;
  /** At the platform's higher conditional sub share, when it has one. */
  altNetCents: number | null;
  /** What the month grossed on this platform (a fixed sub price changes it). */
  grossCents: number;
}

/** How many tip payments make up `tipsCents`, at the average tip (at least one when there are tips). */
export function tipPayments(tipsCents: number): number {
  if (tipsCents <= 0) return 0;
  return Math.max(1, Math.round(tipsCents / AVERAGE_TIP_CENTS));
}

const whole = (n: number) => Math.max(0, Math.floor(n));

/** One platform's month. Each product rounds to whole cents; the net never goes negative. */
export function calculateRow(rate: PlatformRate, input: CalcInput): CalcRow {
  const subscribers = whole(input.subscribers);
  const price = rate.fixedSubPriceCents ?? whole(input.subPriceCents);
  const tips = whole(input.tipsCents);
  const subGross = subscribers * price;
  const tipShare = rate.tipShare;
  const countedTips = tipShare === null ? 0 : tips;
  let net = Math.round(subGross * rate.subShare) + (tipShare === null ? 0 : Math.round(tips * tipShare));
  if (rate.card) {
    const payments = subscribers + (tipShare === null ? 0 : tipPayments(tips));
    net -= Math.round((subGross + countedTips) * rate.card.rate) + payments * rate.card.fixedCents;
  }
  return {
    id: rate.id,
    netCents: Math.max(0, net),
    altNetCents: rate.altSubShare === undefined ? null : Math.round(subGross * rate.altSubShare),
    grossCents: subGross + countedTips,
  };
}

/** Every row: CommonAir first, then the competitors in table order. */
export function calculate(creatorShare: number, input: CalcInput): CalcRow[] {
  return [commonAirRate(creatorShare), ...COMPETITOR_RATES].map((rate) => calculateRow(rate, input));
}

/** A bar's width as a share of the largest figure on the table (0 when every figure is 0). */
export function barShare(cents: number, rows: readonly CalcRow[]): number {
  const max = Math.max(0, ...rows.map((r) => Math.max(r.netCents, r.altNetCents ?? 0)));
  return max === 0 ? 0 : Math.min(1, Math.max(0, cents / max));
}

/** Slider bounds and defaults (the mockup's ranges). */
export const CALC_LIMITS = {
  subscribers: { min: 0, max: 2000, step: 10, initial: 100 },
  subPriceCents: { min: 100, max: 2500, step: 50, initial: 500 },
  tipsCents: { min: 0, max: 500_000, step: 2500, initial: 20_000 },
} as const;

/** The "typical sizes" shortcuts for subscribers. */
export const SUBSCRIBER_PRESETS = [10, 100, 500, 1500] as const;
