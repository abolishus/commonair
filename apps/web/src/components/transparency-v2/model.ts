// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transparency v2 (overhaul D6.1, coop-trust P3) as pure functions: the facts the numbers strip,
 * the fee promise, the deficit note and the capped governance list read from the books
 * (`coop.transparency`), the settings (`coop.settings`) and the fee schedule (`coop.feeSchedule`).
 * Every figure comes from those answers, never from a literal: the creator share is the
 * `platform.cut` setting's, so a member vote that changes it changes this page. Integer cents.
 */
import type { TransparencyMonthDto } from "../../lib/money.ts";

/** The parts of a governance setting this module reads (`coop.settings` rows). */
export interface SettingLike {
  key: string;
  value: unknown;
}

/** The parts of a fee schedule entry this module reads (`coop.feeSchedule`, newest first). */
export interface FeeEntryLike {
  key: string;
  changedAt: string | null;
}

export interface CutShares {
  /** Fractions of every sub and tip (0.9 and 0.1). */
  creator: number;
  coop: number;
}

const share = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;

/**
 * The `platform.cut` setting's shares; null when the setting is missing or not the shape we know
 * (the page then says the fee did not load instead of guessing a number).
 */
export function cutShares(settings: readonly SettingLike[] | null): CutShares | null {
  const value = settings?.find((s) => s.key === "platform.cut")?.value;
  if (typeof value !== "object" || value === null) return null;
  const creator = share((value as Record<string, unknown>).streamerShare);
  const coop = share((value as Record<string, unknown>).coopShare);
  if (creator === null || coop === null || creator <= 0) return null;
  return { creator, coop };
}

/** When the fee schedule last changed: a decided change's date, or only the founding values. */
export type FeeChange = { kind: "changed"; at: string } | { kind: "founding" };

/** The newest decided entry's date, `founding` when only the founding values exist, null without a schedule. */
export function feeLastChanged(schedule: readonly FeeEntryLike[] | null): FeeChange | null {
  if (schedule === null) return null;
  let newest: string | null = null;
  for (const e of schedule)
    if (e.changedAt !== null && (newest === null || Date.parse(e.changedAt) > Date.parse(newest))) newest = e.changedAt;
  if (newest !== null) return { kind: "changed", at: newest };
  return schedule.length > 0 ? { kind: "founding" } : null;
}

/** What creators were paid in the months shown. */
export function creatorsPaidCents(months: readonly Pick<TransparencyMonthDto, "streamerPayouts">[]): number {
  return months.reduce((sum, m) => sum + m.streamerPayouts.cents, 0);
}

export interface Deficit {
  months: number;
  costs: number;
  /** The co-op's share of revenue (its cut). */
  retained: number;
  /** costs − retained, always above zero. */
  gap: number;
  currency: string;
}

/**
 * The gap when the co-op's costs exceeded its share over the months shown (surplus is the cut less
 * costs, so the gap is minus the surplus); null when there is none.
 */
export function deficitOf(
  months: readonly Pick<TransparencyMonthDto, "revenue" | "coopRetained" | "costs" | "surplus">[],
): Deficit | null {
  const surplus = months.reduce((sum, m) => sum + m.surplus.cents, 0);
  if (months.length === 0 || surplus >= 0) return null;
  const costs = months.reduce((sum, m) => sum + m.costs.reduce((s, c) => s + c.amount.cents, 0), 0);
  const retained = months.reduce((sum, m) => sum + m.coopRetained.cents, 0);
  return { months: months.length, costs, retained, gap: -surplus, currency: months[0]?.revenue.currency ?? "usd" };
}

export interface NotedMonth {
  month: string;
  body: string;
  updatedAt: string;
}

/** The newest month shown that carries a treasurer's note (months arrive newest first), or null. */
export function latestNote(months: readonly Pick<TransparencyMonthDto, "month" | "note">[]): NotedMonth | null {
  const noted = months
    .flatMap((m) => (m.note ? [{ month: m.month, body: m.note.body, updatedAt: m.note.updatedAt }] : []))
    .sort((a, b) => b.month.localeCompare(a.month));
  return noted[0] ?? null;
}

/** How many decided proposals `/transparency` lists before "All decisions" (coop-trust P3.6). */
export const GOVERNANCE_CAP = 10;

type Governance = TransparencyMonthDto["governance"][number];

/**
 * The decided proposals across the months shown, newest decision first (undated ones last, by
 * month), capped at `cap`; `more` says whether any were left out.
 */
export function recentDecisions(
  months: readonly Pick<TransparencyMonthDto, "month" | "governance">[],
  cap: number = GOVERNANCE_CAP,
): { items: (Governance & { month: string })[]; more: boolean } {
  const all = months
    .flatMap((m) => m.governance.map((g) => ({ ...g, month: m.month })))
    .sort((a, b) => {
      const at = (x: { decidedAt: string | null }) =>
        x.decidedAt ? Date.parse(x.decidedAt) : Number.NEGATIVE_INFINITY;
      return at(b) - at(a) || b.month.localeCompare(a.month) || a.proposalId.localeCompare(b.proposalId);
    });
  return { items: all.slice(0, Math.max(0, cap)), more: all.length > cap };
}
