// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-platform: OAuth apps and tokens, EventSub, webhooks, notifications, push and Discord. Brief: `.claude/briefs/seed-full/seed-platform.md`. */
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "oauth_apps",
  "oauth_codes",
  "oauth_tokens",
  "oauth_device_codes",
  "event_subscriptions",
  "webhook_deliveries",
  "notifications",
  "notification_preferences",
  "notification_go_live_sends",
  "notification_email_queue",
  "push_subscriptions",
  "discord_webhooks",
] as const;

export const unit: SeedUnit = {
  name: "platform",
  after: ["social"],
  tables: TABLES,
  pending: TABLES,
  async run() {
    return { rows: {}, notes: ["seed-platform: not implemented yet"] };
  },
};
