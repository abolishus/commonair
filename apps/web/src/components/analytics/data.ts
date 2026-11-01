// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for the studio analytics page (W2-rollup-analytics): the period options, delivery
 * shares in basis points, viewer hours, the per-minute chart rows. Everything here takes the
 * request time as an argument, so the server render and hydration agree.
 */
import type { AnalyticsRange, BroadcastAnalytics } from "@commonair/contracts/dto";
import { formatDuration, formatNumber } from "@commonair/ui";

export type DeliveryRow = BroadcastAnalytics["delivery"][number];
export type RangeBroadcast = AnalyticsRange["broadcasts"][number];

const DAY_MS = 86_400_000;
/** The period picker's choices, in days back from the request time. */
export const RANGE_DAYS = [7, 30, 90] as const;
export const DEFAULT_RANGE_DAYS = 30;

/** `[from, to)` for "the last `days` days" at `now` (ISO, as the API takes it). */
export function rangeFor(days: number, now: number): { from: string; to: string } {
  return { from: new Date(now - days * DAY_MS).toISOString(), to: new Date(now).toISOString() };
}

/** A picker value back to its days, falling back to the default for anything unknown. */
export function parseRangeDays(value: string): number {
  const n = Number(value);
  return (RANGE_DAYS as readonly number[]).includes(n) ? n : DEFAULT_RANGE_DAYS;
}

/**
 * Each source's share of the delivered bytes in basis points, summing to exactly 10,000 when any
 * bytes were delivered (largest remainder), all 0 otherwise.
 */
export function deliveryShares(rows: readonly DeliveryRow[]): number[] {
  const total = rows.reduce((a, r) => a + Math.max(0, r.bytes), 0);
  if (total === 0) return rows.map(() => 0);
  const raw = rows.map((r) => (Math.max(0, r.bytes) / total) * 10_000);
  const shares = raw.map(Math.floor);
  const order = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || a.i - b.i);
  let remaining = 10_000 - shares.reduce((a, b) => a + b, 0);
  for (const { i } of order) {
    if (remaining <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
    remaining--;
  }
  return shares;
}

/** Viewer seconds as a localized number of hours, one decimal ("12.5"). */
export const hoursOf = (seconds: number, locale: string): string =>
  formatNumber(Math.round(Math.max(0, seconds) / 360) / 10, locale);

/** Chart and table rows: time into the broadcast (h:mm:ss) and the three counts per minute. */
export function minuteRows(a: Pick<BroadcastAnalytics, "startedAt" | "minutes">) {
  const start = Date.parse(a.startedAt);
  return a.minutes.map((m) => ({
    at: m.at,
    offset: formatDuration(Math.max(0, (Date.parse(m.at) - start) / 1000)),
    verified: m.verified,
    unverified: m.unverified,
    excluded: m.excluded,
  }));
}

/** The broadcast to show: the requested one if listed, else the newest. */
export function pickBroadcast(list: readonly RangeBroadcast[], wanted: string | null): string | null {
  if (wanted && list.some((b) => b.broadcastId === wanted)) return wanted;
  return list[0]?.broadcastId ?? null;
}
