// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EmoteRange } from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { createdAt, id, ts, wordFilterAction } from "./_shared.ts";

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    broadcastId: uuid(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text().notNull(),
    emotes: jsonb().$type<EmoteRange[]>().notNull().default([]),
    isAction: boolean().notNull().default(false),
    replyToId: uuid(),
    /** Client or bot that sent it (OAuth app id), for bot badging and rate limits. */
    viaAppId: uuid(),
    /** Held by a word filter, awaiting moderator review. */
    heldAt: ts(),
    deletedAt: ts(),
    deletedBy: uuid(),
    /** PDT under the sender's playhead, clamped (ADR 0012 amendment 1); null when not live, in DVR mode, or unknown. Receive time (`createdAt`) stays authoritative. */
    mediaTs: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index("chat_messages_channel_idx").on(t.channelId, t.createdAt),
    index("chat_messages_user_idx").on(t.userId, t.createdAt),
    // Chat replay in media-time order (ADR 0012 amendment 1 decision 1).
    index("chat_messages_broadcast_media_idx").on(t.broadcastId, t.mediaTs),
    // Retention (decision 6).
    index("chat_messages_created_idx").on(t.createdAt),
  ],
);

export const chatBans = pgTable(
  "chat_bans",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    moderatorId: uuid().references(() => users.id, { onDelete: "set null" }),
    reason: text().notNull().default(""),
    /** Null = permanent ban; otherwise a timeout. */
    expiresAt: ts(),
    liftedAt: ts(),
    liftedBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("chat_bans_lookup_idx").on(t.channelId, t.userId),
    uniqueIndex("chat_bans_active_uq")
      .on(t.channelId, t.userId)
      .where(sql`${t.liftedAt} is null`),
  ],
);

/**
 * User-to-user blocks (ADR 0012 amendment 1 decision 8; built in W1). Personal data: deleted with
 * either account (account deletion pseudonymizes users, so
 * `services/worker/src/deletion/account-deletion.ts` deletes these rows explicitly); never copied
 * into append-only columns.
 */
export const userBlocks = pgTable(
  "user_blocks",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.blockedUserId] }),
    index("user_blocks_blocked_idx").on(t.blockedUserId),
    check("user_blocks_not_self", sql`${t.userId} <> ${t.blockedUserId}`),
  ],
);

export const emotes = pgTable(
  "emotes",
  {
    id: id(),
    /** Null for global emotes. */
    channelId: uuid().references(() => channels.id, { onDelete: "cascade" }),
    code: text().notNull(),
    imageKey: text().notNull(),
    /** 0 = usable by everyone; 1–3 = subscriber tier required. */
    tier: smallint().notNull().default(0),
    animated: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("emotes_code_uq").on(
      sql`coalesce(${t.channelId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.code,
    ),
  ],
);

export const wordFilters = pgTable(
  "word_filters",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    pattern: text().notNull(),
    isRegex: boolean().notNull().default(false),
    action: wordFilterAction().notNull().default("block"),
    replacement: text(),
    createdAt: createdAt(),
  },
  (t) => [index("word_filters_channel_idx").on(t.channelId)],
);
