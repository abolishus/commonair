// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First-party growth counters (design overhaul wave 2, D2.8; growth-funnels.md P7). Daily totals
 * only: no user id, IP, user agent or free text ever lands here. Surfaces, actions, steps and
 * metrics are closed lists in `@commonair/contracts/enums`, checked by the API before writing.
 */
import { sql } from "drizzle-orm";
import { bigint, check, date, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type {
  GROWTH_METRICS,
  UI_METRIC_ACTIONS,
  UI_METRIC_STEPS,
  UI_METRIC_SURFACES,
} from "@commonair/contracts/enums";
import { updatedAt } from "./_shared.ts";

/** Client-reported views and clicks (`POST /metrics/ui`), one row per (UTC day, surface, action, step). */
export const uiCounters = pgTable(
  "ui_counters",
  {
    day: date({ mode: "string" }).notNull(),
    surface: text().$type<(typeof UI_METRIC_SURFACES)[number]>().notNull(),
    action: text().$type<(typeof UI_METRIC_ACTIONS)[number]>().notNull(),
    step: text().$type<(typeof UI_METRIC_STEPS)[number]>().notNull().default("none"),
    count: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.surface, t.action, t.step] }),
    check("ui_counters_count_nonneg", sql`${t.count} >= 0`),
  ],
);

/** Server-side funnel counts computed nightly from existing rows, one row per (UTC day, metric). */
export const growthDaily = pgTable(
  "growth_daily",
  {
    day: date({ mode: "string" }).notNull(),
    metric: text().$type<(typeof GROWTH_METRICS)[number]>().notNull(),
    value: bigint({ mode: "number" }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.day, t.metric] }), check("growth_daily_value_nonneg", sql`${t.value} >= 0`)],
);
