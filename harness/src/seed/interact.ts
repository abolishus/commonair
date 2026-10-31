// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-interact: bot, polls, predictions, raids, goals, alerts, overlays and channel points. Brief: `.claude/briefs/seed-full/seed-interact.md`. */
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "bot_configs",
  "bot_commands",
  "bot_timers",
  "bot_variables",
  "loyalty_balances",
  "loyalty_transactions",
  "loyalty_accruals",
  "loyalty_accrual_sessions",
  "song_requests",
  "polls",
  "poll_votes",
  "predictions",
  "prediction_bets",
  "raids",
  "alert_configs",
  "goals",
  "overlay_tokens",
] as const;

export const unit: SeedUnit = {
  name: "interact",
  after: ["social"],
  tables: TABLES,
  pending: TABLES,
  async run() {
    return { rows: {}, notes: ["seed-interact: not implemented yet"] };
  },
};
