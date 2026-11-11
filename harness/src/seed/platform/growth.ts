// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-platform's growth tables (overhaul wave 2, D2.8): `growth_daily` for the 400 UTC days
 * before the run (more than the 12 months `/transparency` shows) and `ui_counters` for the last 30.
 * The values are planned, not counted from the seeded rows: a small seed has too few accounts for
 * any monthly figure to clear the k floor, and the pages need full and floored cells alike. Some
 * series stay small on purpose, so "fewer than 5" shows on both pages. Upserts, so a rerun is
 * harmless; the worker's nightly job later replaces the last days with real counts.
 */
import {
  GROWTH_METRICS,
  type GrowthMetric,
  type UI_METRIC_ACTIONS,
  type UI_METRIC_STEPS,
  type UI_METRIC_SURFACES,
} from "@commonair/contracts/enums";
import type { DbHandle } from "@commonair/db";
import type { Rng } from "../prng.ts";

const DAY_MS = 86_400_000;
/** Days of `growth_daily` before the run's day. */
export const GROWTH_DAYS = 400;
/** Days of `ui_counters` before (and including) the run's day. */
export const UI_DAYS = 30;

export interface GrowthDailyRow {
  day: string;
  metric: GrowthMetric;
  value: number;
}
export interface UiCounterRow {
  day: string;
  surface: (typeof UI_METRIC_SURFACES)[number];
  action: (typeof UI_METRIC_ACTIONS)[number];
  step: (typeof UI_METRIC_STEPS)[number];
  count: number;
}
export interface GrowthPlan {
  daily: GrowthDailyRow[];
  ui: UiCounterRow[];
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The counters the pages list: busy ones, quiet ones and some that stay under the floor. */
const UI_ROWS: readonly (Omit<UiCounterRow, "day" | "count"> & { perDay: [number, number] })[] = [
  { surface: "home.hero", action: "view", step: "none", perDay: [60, 140] },
  { surface: "home.hero", action: "click", step: "none", perDay: [6, 20] },
  { surface: "home.shelf", action: "click", step: "live", perDay: [10, 30] },
  { surface: "home.shelf", action: "click", step: "clips", perDay: [2, 9] },
  { surface: "authGate", action: "view", step: "follow", perDay: [8, 24] },
  { surface: "authGate", action: "create", step: "follow", perDay: [1, 5] },
  { surface: "authGate", action: "signin", step: "chat", perDay: [0, 2] },
  { surface: "signup", action: "view", step: "none", perDay: [10, 30] },
  { surface: "signup", action: "submit", step: "stream", perDay: [1, 4] },
  { surface: "signup", action: "error", step: "username_taken", perDay: [0, 1] },
  { surface: "creators.calc", action: "used", step: "none", perDay: [3, 12] },
  { surface: "coop.band", action: "click", step: "none", perDay: [1, 6] },
  { surface: "consent.banner", action: "click", step: "decline", perDay: [4, 15] },
];

/**
 * A slowly growing instance: flows grow with the day index, two stocks are carried forward from
 * them, and the creator steps stay low (so they show floored at `small`).
 */
export function planGrowth(rng: Rng, now: Date, factor: number): GrowthPlan {
  const today = Date.parse(`${utcDay(now.getTime())}T00:00:00Z`);
  const daily: GrowthDailyRow[] = [];
  let members = 3 * factor;
  for (let i = GROWTH_DAYS; i >= 1; i--) {
    const day = utcDay(today - i * DAY_MS);
    const age = GROWTH_DAYS - i; // 0 on the oldest day
    const scale = factor * (1 + age / 120);
    const created = Math.round(scale * rng.int(2, 6));
    const verified = Math.round(created * (0.7 + rng.next() * 0.2));
    const follow = Math.round(verified * (0.4 + rng.next() * 0.2));
    const chat = Math.round(follow * (0.3 + rng.next() * 0.2));
    const support = Math.round(chat * (0.1 + rng.next() * 0.1));
    const member = rng.chance(0.3) ? rng.int(0, 2) * factor : 0;
    members += member - (rng.chance(0.05) ? factor : 0);
    members = Math.max(0, members);
    const values: Record<GrowthMetric, number> = {
      accounts_created: created,
      accounts_verified: verified,
      first_follow_within_7d: follow,
      first_chat_within_7d: chat,
      first_support_within_30d: support,
      became_member: member,
      notify_optin: Math.round(follow * (0.2 + rng.next() * 0.2)),
      first_live: rng.chance(0.25) ? rng.int(1, 2) : 0,
      second_live_within_14d: rng.chance(0.15) ? 1 : 0,
      imports_finished: rng.chance(0.05) ? 1 : 0,
      active_streamers: Math.round(factor * (2 + age / 50)),
      members_total: members,
    };
    for (const metric of GROWTH_METRICS) daily.push({ day, metric, value: Math.max(0, values[metric]) });
  }
  const ui: UiCounterRow[] = [];
  for (let i = UI_DAYS - 1; i >= 0; i--) {
    const day = utcDay(today - i * DAY_MS);
    for (const row of UI_ROWS) {
      const count = rng.int(row.perDay[0], row.perDay[1]) * factor;
      if (count > 0) ui.push({ day, surface: row.surface, action: row.action, step: row.step, count });
    }
  }
  return { daily, ui };
}

/** Rows per insert (well under Postgres' bind parameter limit). */
const CHUNK = 1000;

export async function writeGrowth(
  h: DbHandle,
  plan: GrowthPlan,
): Promise<{ growth_daily: number; ui_counters: number }> {
  for (let i = 0; i < plan.daily.length; i += CHUNK) {
    const rows = plan.daily.slice(i, i + CHUNK);
    await h.sql`
      insert into growth_daily ${h.sql(rows, "day", "metric", "value")}
      on conflict (day, metric) do update set value = excluded.value, updated_at = now()`;
  }
  for (let i = 0; i < plan.ui.length; i += CHUNK) {
    const rows = plan.ui.slice(i, i + CHUNK);
    await h.sql`
      insert into ui_counters ${h.sql(rows, "day", "surface", "action", "step", "count")}
      on conflict (day, surface, action, step) do update set count = excluded.count, updated_at = now()`;
  }
  return { growth_daily: plan.daily.length, ui_counters: plan.ui.length };
}
