// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.growth` and `transparency.numbers` (overhaul wave 2, D2.8; growth-funnels.md P7 C). Both
 * read daily totals (`growth_daily`, `ui_counters`) or a grouped count, never a row about one
 * person, and every value below `GROWTH_K_FLOOR` goes out as null.
 *
 * Two metrics are stocks, not flows: `members_total` (members at the end of the day) and
 * `active_streamers` (channels live at least once in the 30 days up to the day). A window or a
 * month reports their last day's value; every other metric is summed.
 */
import {
  GROWTH_K_FLOOR,
  GROWTH_METRICS,
  SIGNUP_INTENTS,
  type GrowthMetric,
  type SignupIntent,
} from "@commonair/contracts/enums";
import type { GrowthNumbers, GrowthReport } from "@commonair/contracts/dto";
import { schema, type Database } from "@commonair/db";
import { and, asc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { utcDay } from "./ingest.ts";

const DAY_MS = 86_400_000;

/** Metrics whose value is a level on the day, so a period reports its last day instead of a sum. */
export const STOCK_METRICS: ReadonlySet<GrowthMetric> = new Set(["members_total", "active_streamers"]);

/** The k floor: a count below it is null, so no small group can be singled out. */
export const floorK = (n: number): number | null => (n >= GROWTH_K_FLOOR ? n : null);

/** Every UTC day from `from` to `to`, both included, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY_MS)
    out.push(utcDay(new Date(at)));
  return out;
}

/** The report window: `days` UTC days ending yesterday (today's totals are not computed yet). */
export function growthWindow(now: Date, days: number): { from: string; to: string } {
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
  return { from: utcDay(new Date(today - days * DAY_MS)), to: utcDay(new Date(today - DAY_MS)) };
}

/** One metric's value over a period: the sum of a flow, the last known day of a stock. */
export function periodValue(metric: GrowthMetric, points: readonly { day: string; value: number }[]): number {
  if (!STOCK_METRICS.has(metric)) return points.reduce((a, p) => a + p.value, 0);
  let last: { day: string; value: number } | null = null;
  for (const p of points) if (!last || p.day > last.day) last = p;
  return last?.value ?? 0;
}

type DailyRow = { day: string; metric: GrowthMetric; value: number };

async function dailyRows(db: Database, from: string, to: string): Promise<DailyRow[]> {
  const g = schema.growthDaily;
  return db
    .select({ day: g.day, metric: g.metric, value: g.value })
    .from(g)
    .where(and(gte(g.day, from), lte(g.day, to)))
    .orderBy(asc(g.day));
}

export async function growthReport(db: Database, now: Date, days: number): Promise<GrowthReport> {
  const { from, to } = growthWindow(now, days);
  const rows = await dailyRows(db, from, to);
  const byMetric = new Map<GrowthMetric, Map<string, number>>();
  for (const r of rows) {
    const m = byMetric.get(r.metric) ?? new Map<string, number>();
    m.set(r.day, Number(r.value));
    byMetric.set(r.metric, m);
  }
  const window = daysBetween(from, to);
  const series = GROWTH_METRICS.map((metric) => {
    const known = byMetric.get(metric) ?? new Map<string, number>();
    return { metric, points: window.map((day) => ({ day, value: floorK(known.get(day) ?? 0) })) };
  });
  const totals = GROWTH_METRICS.map((metric) => {
    const known = [...(byMetric.get(metric) ?? new Map<string, number>())].map(([day, value]) => ({ day, value }));
    return { metric, value: floorK(periodValue(metric, known)) };
  });

  const u = schema.users;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS);
  const intents = await db
    .select({ intent: u.signupIntent, n: sql<number>`count(*)::int` })
    .from(u)
    .where(and(gte(u.createdAt, start), lt(u.createdAt, end), eq(u.accountType, "human")))
    .groupBy(u.signupIntent);
  const intentCounts = new Map<SignupIntent, number>();
  // An account made before intents were recorded (or with none) counts as "none".
  for (const r of intents) {
    const key = r.intent ?? "none";
    intentCounts.set(key, (intentCounts.get(key) ?? 0) + Number(r.n));
  }
  const signupsByIntent = SIGNUP_INTENTS.map((intent) => ({ intent, value: floorK(intentCounts.get(intent) ?? 0) }));

  const c = schema.uiCounters;
  const total = sql<number>`sum(${c.count})::bigint`;
  const uiRows = await db
    .select({ surface: c.surface, action: c.action, step: c.step, n: total })
    .from(c)
    .where(and(gte(c.day, from), lte(c.day, to)))
    .groupBy(c.surface, c.action, c.step)
    .orderBy(sql`sum(${c.count}) desc`, asc(c.surface), asc(c.action), asc(c.step));
  const ui = uiRows.map((r) => ({ surface: r.surface, action: r.action, step: r.step, value: floorK(Number(r.n)) }));

  return { from, to, totals, series, signupsByIntent, ui };
}

/** The last `count` UTC months, oldest first, ending with the current one (`YYYY-MM`). */
export function lastMonths(now: Date, count: number): string[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(y, m - (count - 1) + i, 1)).toISOString().slice(0, 7),
  );
}

/** Months shown on `/transparency`. */
export const NUMBERS_MONTHS = 12;

export async function growthNumbers(db: Database, now: Date): Promise<GrowthNumbers> {
  const months = lastMonths(now, NUMBERS_MONTHS);
  const first = months[0] ?? utcDay(now).slice(0, 7);
  const rows = await dailyRows(db, `${first}-01`, utcDay(now));
  const pick = (month: string, metric: GrowthMetric) =>
    floorK(
      periodValue(
        metric,
        rows
          .filter((r) => r.metric === metric && r.day.startsWith(month))
          .map((r) => ({ day: r.day, value: Number(r.value) })),
      ),
    );
  return {
    months: months.map((month) => ({
      month,
      accountsCreated: pick(month, "accounts_created"),
      membersTotal: pick(month, "members_total"),
      activeStreamers: pick(month, "active_streamers"),
    })),
  };
}
