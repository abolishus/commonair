// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Creator Analytics' privacy rules as pure functions (batch 6 decision (k)): the 24 h display
 * delay, the small-group suppression and the delivery mix. A "group" is one exclusion category
 * within one broadcast (the group-appeal subject, decision (m)); groups are suppressed per
 * broadcast **before** anything is summed over a range, so comparing two ranges cannot reveal a
 * hidden group of one broadcast.
 */
import {
  ANALYTICS_RULES,
  DELIVERY_SOURCES,
  EXCLUSION_CATEGORIES,
  type ExclusionCategory,
} from "@commonair/contracts/enums";

type Source = (typeof DELIVERY_SOURCES)[number];
export type ByCategory = Partial<Record<ExclusionCategory, number>>;
export type BySource = Partial<Record<Source, number>>;

const DAY_MS = 86_400_000;
/** The longest `from`–`to` span the range reads accept. */
export const MAX_RANGE_DAYS = 400;
/** The default range when a caller gives none (`integrity.channelSummary`). */
export const DEFAULT_RANGE_DAYS = 30;

/** When an ended broadcast shows in analytics and share links. */
export const displayAvailableAt = (endedAt: Date): Date =>
  new Date(endedAt.getTime() + ANALYTICS_RULES.displayDelaySeconds * 1000);

/**
 * Whether a broadcast may be shown now: ended at least the display delay ago, or the harness's
 * bypass is set for its channel (only while `OPS_TEST_HOOKS` is on). A live broadcast never shows.
 */
export function displayable(endedAt: Date | null, now: Date, bypassed: boolean): boolean {
  if (endedAt === null) return false;
  return bypassed || displayAvailableAt(endedAt).getTime() <= now.getTime();
}

/** The latest `ended_at` a broadcast may have to be shown at `now` (no bypass). */
export const displayCutoff = (now: Date): Date => new Date(now.getTime() - ANALYTICS_RULES.displayDelaySeconds * 1000);

/**
 * Excluded follows in a period, as shown: a count under `ANALYTICS_RULES.minGroupSessions` shows as
 * 0, so the owner cannot tell that one particular follow was just excluded (the same threshold as
 * the exclusion groups; follows are one group with no category).
 */
export const shownFollowCount = (n: number, min: number = ANALYTICS_RULES.minGroupSessions): number =>
  n >= min ? n : 0;

export interface ExclusionGroup {
  category: ExclusionCategory;
  sessions: number;
  viewerSeconds: number;
}

/** One broadcast's excluded groups, in `EXCLUSION_CATEGORIES` order, empty categories left out. */
export function groupsOf(t: { excludedSessionsByCategory: ByCategory; excludedSecondsByCategory: ByCategory }) {
  const out: ExclusionGroup[] = [];
  for (const category of EXCLUSION_CATEGORIES) {
    const sessions = t.excludedSessionsByCategory[category] ?? 0;
    if (sessions <= 0) continue;
    out.push({ category, sessions, viewerSeconds: t.excludedSecondsByCategory[category] ?? 0 });
  }
  return out;
}

/**
 * Groups of fewer than `ANALYTICS_RULES.minGroupSessions` sessions are omitted and only counted:
 * a group of 4 is hidden, 5 and 6 are shown.
 */
export function suppressGroups<T extends { sessions: number }>(
  groups: readonly T[],
  min: number = ANALYTICS_RULES.minGroupSessions,
): { shown: T[]; hidden: number } {
  const shown = groups.filter((g) => g.sessions >= min);
  return { shown, hidden: groups.length - shown.length };
}

/** Sum shown groups by category (range views), in `EXCLUSION_CATEGORIES` order. */
export function sumGroups(groups: readonly ExclusionGroup[]): ExclusionGroup[] {
  const by = new Map<ExclusionCategory, ExclusionGroup>();
  for (const g of groups) {
    const cur = by.get(g.category) ?? { category: g.category, sessions: 0, viewerSeconds: 0 };
    cur.sessions += g.sessions;
    cur.viewerSeconds += g.viewerSeconds;
    by.set(g.category, cur);
  }
  return EXCLUSION_CATEGORIES.flatMap((c) => {
    const g = by.get(c);
    return g ? [g] : [];
  });
}

export interface DeliveryRow {
  source: Source;
  bytes: number;
  verifiedViewerSeconds: number;
}

/** Bytes and verified seconds by delivery source, in `DELIVERY_SOURCES` order, sources with neither left out. */
export function deliveryMix(bytes: BySource, verifiedSeconds: BySource): DeliveryRow[] {
  return DELIVERY_SOURCES.flatMap((source) => {
    const b = bytes[source] ?? 0;
    const s = verifiedSeconds[source] ?? 0;
    return b > 0 || s > 0 ? [{ source, bytes: b, verifiedViewerSeconds: s }] : [];
  });
}

/** Add one per-source (or per-category) map into another. */
export function addInto<K extends string>(into: Partial<Record<K, number>>, from: Partial<Record<K, number>>): void {
  for (const [k, v] of Object.entries(from) as [K, number | undefined][]) into[k] = (into[k] ?? 0) + (v ?? 0);
}

/**
 * A `[from, to)` period: both given, or the last `DEFAULT_RANGE_DAYS` up to `now`. Refuses an
 * empty or reversed period and one longer than `MAX_RANGE_DAYS` (null).
 */
export function periodOf(input: { from?: string | undefined; to?: string | undefined }, now: Date) {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (!(from.getTime() < to.getTime())) return null;
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) return null;
  return { from, to };
}
