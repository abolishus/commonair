// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Range trends for analytics and revenue (F24): one row per UTC day of the period, and the
 * previous-period delta each `StatCard` shows. The API takes any `[from, to)`, so the previous
 * period is simply a second range call; nothing here invents a number the API did not return.
 * Pure, and the request time is always an argument (server render and hydration agree).
 */
import { formatPercent, monthNames } from "@commonair/ui";
import type { StatDelta } from "@commonair/ui/blocks/data";
import { t } from "../../i18n/index.ts";

const DAY_MS = 86_400_000;

/** The `[from, to)` period of the same length right before `[from, to)`. */
export function previousPeriod(period: { from: string; to: string }): { from: string; to: string } {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return { from: new Date(from - (to - from)).toISOString(), to: new Date(from).toISOString() };
}

/** `YYYY-MM-DD` (UTC) of an instant. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Every UTC day the period touches, oldest first (`to` is exclusive). */
export function periodDays(period: { from: string; to: string }): string[] {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  if (!(to > from)) return [];
  const days: string[] = [];
  let at = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate());
  for (; at < to; at += DAY_MS) days.push(utcDay(at));
  return days;
}

export interface AudienceDay {
  date: string;
  /** Verified watch hours of the broadcasts that started that day (one decimal). */
  hours: number;
  /** The highest verified peak of those broadcasts (0 with none). */
  peak: number;
  /** New follows that day (0 when the follower list was not loaded). */
  followers: number;
}

interface BroadcastTotals {
  startedAt: string;
  totals: { verifiedViewerSeconds: number; peakVerifiedConcurrent: number };
}

/**
 * Per day of the period: the verified hours and peak viewers of the broadcasts that started that
 * day, and the follows made that day. A broadcast or follow outside the period is ignored.
 */
export function audienceTrend(
  period: { from: string; to: string },
  broadcasts: readonly BroadcastTotals[],
  followedAt: readonly string[] = [],
): AudienceDay[] {
  const rows = new Map(periodDays(period).map((date) => [date, { date, seconds: 0, peak: 0, followers: 0 }]));
  for (const b of broadcasts) {
    const row = rows.get(utcDay(Date.parse(b.startedAt)));
    if (!row) continue;
    row.seconds += Math.max(0, b.totals.verifiedViewerSeconds);
    row.peak = Math.max(row.peak, b.totals.peakVerifiedConcurrent);
  }
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  for (const at of followedAt) {
    const ms = Date.parse(at);
    if (!(ms >= from && ms < to)) continue;
    const row = rows.get(utcDay(ms));
    if (row) row.followers += 1;
  }
  return [...rows.values()].map((r) => ({
    date: r.date,
    hours: Math.round(r.seconds / 360) / 10,
    peak: r.peak,
    followers: r.followers,
  }));
}

/** The revenue summary's `daily` rows filled to every day of the period (missing days are 0). */
export function revenueTrend(
  period: { from: string; to: string },
  daily: readonly { date: string; gross: number; net: number }[],
): { date: string; gross: number; net: number }[] {
  const byDate = new Map(daily.map((d) => [d.date.slice(0, 10), d]));
  return periodDays(period).map((date) => {
    const d = byDate.get(date);
    return { date, gross: d?.gross ?? 0, net: d?.net ?? 0 };
  });
}

/**
 * The previous-period delta for a `StatCard`: up or down by a whole percentage, "no change", or
 * "new" when the previous period had none. Undefined when the previous period is unknown (the
 * call failed or has not answered): no delta beats a made-up one.
 */
export function periodDelta(
  current: number,
  previous: number | null | undefined,
  locale: string,
  options: { higherIsBetter?: boolean } = {},
): StatDelta | undefined {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return undefined;
  const better = options.higherIsBetter ?? true;
  if (current === previous) return { direction: "flat", label: t("studio.delta.flat") };
  const direction = current > previous ? "up" : "down";
  const sentiment = (direction === "up") === better ? "positive" : "negative";
  if (previous === 0) return { direction, sentiment, label: t("studio.delta.new") };
  const percent = formatPercent(Math.abs(current - previous) / Math.abs(previous), locale, {
    maximumFractionDigits: 0,
  });
  return {
    direction,
    sentiment,
    label: direction === "up" ? t("studio.delta.up", { percent }) : t("studio.delta.down", { percent }),
  };
}

/** A chart's day label ("Nov 3", "3 nov"): the locale's short month, the order from the catalog. */
export function formatDayLabel(date: string, locale: string): string {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return t("studio.trend.dayLabel", { month: monthNames(locale, "short")[month - 1] ?? "", day: String(day) });
}
