// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two `/transparency` bars (F4, coop-trust P3). The old single bar stacked the creators' share
 * of revenue beside the co-op's costs, two different wholes, so "Creators" read 27% instead of
 * 90%. Now (a) splits revenue only: creators, the co-op's cut net of card fees, and card fees
 * (which come out of the co-op's cut); (b) splits what the co-op spent by category. Integer cents.
 */
import type { BreakdownSegment, ChartColor } from "@commonair/ui/blocks/data";
import { t } from "../../i18n/index.ts";
import type { TransparencyMonthDto } from "../../lib/money.ts";

/** The card processor's fees: a co-op expense line paid from its cut (reserved category). */
export const PAYMENT_FEES = "payment-fees";
/** Split shortfalls written off (ADR 0013 decision 6): never folded into card fees. */
export const SPLIT_WRITEOFF = "split-shortfall-writeoff";

export interface RevenueSplit {
  revenue: number;
  creators: number;
  /** The co-op's cut minus the card fees it paid from it; never below zero. */
  coop: number;
  /** Card fees, at most the co-op's cut (any excess is in the spending bar, not here). */
  processing: number;
}

type SplitMonth = Pick<TransparencyMonthDto, "revenue" | "coopRetained" | "costs">;

function categoryCents(months: readonly Pick<TransparencyMonthDto, "costs">[], category: string): number {
  return months.reduce(
    (sum, m) => sum + m.costs.filter((c) => c.category === category).reduce((s, c) => s + c.amount.cents, 0),
    0,
  );
}

/**
 * Revenue for the months shown, by where it went. The three parts add up to revenue whenever the
 * co-op's cut is between zero and revenue (always, outside a month of refunds bigger than income).
 */
export function revenueSplit(months: readonly SplitMonth[]): RevenueSplit {
  const revenue = months.reduce((sum, m) => sum + m.revenue.cents, 0);
  const cut = Math.max(
    0,
    months.reduce((sum, m) => sum + m.coopRetained.cents, 0),
  );
  const fees = Math.max(0, categoryCents(months, PAYMENT_FEES));
  const processing = Math.min(fees, cut);
  return { revenue, creators: Math.max(0, revenue - cut), coop: cut - processing, processing };
}

/** Whole percent of revenue that went to creators; null with no revenue. */
export function creatorSharePercent(split: Pick<RevenueSplit, "revenue" | "creators">): number | null {
  if (split.revenue <= 0) return null;
  return Math.round((split.creators * 100) / split.revenue);
}

export function revenueSegments(split: RevenueSplit): BreakdownSegment[] {
  return [
    { id: "creators", label: t("fixWeb.transparency.split.creators"), value: split.creators, color: "--chart-1" },
    { id: "coop", label: t("fixWeb.transparency.split.coop"), value: split.coop, color: "--chart-2" },
    {
      id: "processing",
      label: t("fixWeb.transparency.split.processing"),
      value: split.processing,
      color: "--chart-8",
    },
  ];
}

/** A cost category in words: the reserved and common ones translated, any other slug as is. */
export function costCategoryLabel(category: string): string {
  switch (category) {
    case PAYMENT_FEES:
      return t("fixWeb.transparency.category.paymentFees");
    case SPLIT_WRITEOFF:
      return t("fixWeb.transparency.category.splitWriteOff");
    case "hosting":
      return t("fixWeb.transparency.category.hosting");
    case "bandwidth":
      return t("fixWeb.transparency.category.bandwidth");
    case "storage":
      return t("fixWeb.transparency.category.storage");
    default:
      return t("fixWeb.transparency.category.other", { category });
  }
}

/** Chart tokens for spending, skipping `--chart-3` (it reads as the brand amber, direction check). */
const SPENDING_COLORS: readonly ChartColor[] = [
  "--chart-4",
  "--chart-6",
  "--chart-7",
  "--chart-5",
  "--chart-1",
  "--chart-2",
  "--chart-8",
];

/** What the co-op spent for the months shown, by category, biggest first; empty when nothing was. */
export function spendingSegments(months: readonly Pick<TransparencyMonthDto, "costs">[]): BreakdownSegment[] {
  const byCategory = new Map<string, number>();
  for (const m of months)
    for (const c of m.costs) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + c.amount.cents);
  return [...byCategory]
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, cents], i) => ({
      id: category,
      label: costCategoryLabel(category),
      value: cents,
      color: SPENDING_COLORS[i % SPENDING_COLORS.length],
    }));
}

/** Members at the end of the newest month shown (months arrive newest first). */
export function latestMemberCount(months: readonly Pick<TransparencyMonthDto, "members">[]): number {
  const latest = months[0];
  return latest ? Object.values(latest.members).reduce((sum, n) => sum + n, 0) : 0;
}

/** The most recent decided proposal across the months shown, or null. */
export function lastDecision(
  months: readonly Pick<TransparencyMonthDto, "governance">[],
): { proposalId: string; title: string; decidedAt: string } | null {
  let best: { proposalId: string; title: string; decidedAt: string } | null = null;
  for (const m of months)
    for (const g of m.governance) {
      if (!g.decidedAt) continue;
      if (best === null || Date.parse(g.decidedAt) > Date.parse(best.decidedAt))
        best = { proposalId: g.proposalId, title: g.title, decidedAt: g.decidedAt };
    }
  return best;
}
