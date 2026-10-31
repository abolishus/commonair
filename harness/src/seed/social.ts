// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-social: accounts, channels, follows, chat and the rows every other unit builds on. Brief: `.claude/briefs/seed-full/seed-social.md`. */
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "users",
  "accounts",
  "sessions",
  "two_factors",
  "passkeys",
  "categories",
  "channels",
  "channel_panels",
  "channel_roles",
  "channel_sub_tiers",
  "follows",
  "stream_keys",
  "chat_messages",
  "chat_bans",
  "user_blocks",
  "emotes",
  "word_filters",
  "legal_acceptances",
  "consent_records",
  "events",
  "audit_log",
] as const;

export const unit: SeedUnit = {
  name: "social",
  after: [],
  tables: TABLES,
  pending: TABLES,
  async run() {
    return { rows: {}, notes: ["seed-social: not implemented yet"] };
  },
};
