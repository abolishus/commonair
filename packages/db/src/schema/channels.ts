// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ChannelChatSettings, type ChannelTheme } from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import { cents, channelRole, createdAt, id, notificationType, raidPolicy, ts, updatedAt } from "./_shared.ts";

export const categories = pgTable("categories", {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  boxArtKey: text(),
  /** Categories marked mature force the mature label on streams in them. */
  mature: boolean().notNull().default(false),
  createdAt: createdAt(),
});

export const channels = pgTable(
  "channels",
  {
    id: id(),
    /** Restrict: accounts are pseudonymized, never hard-deleted while they own a channel. */
    ownerId: uuid()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Same as the owner's username. */
    slug: text().notNull(),
    displayName: text().notNull(),
    title: text().notNull().default(""),
    description: text().notNull().default(""),
    categoryId: uuid().references(() => categories.id, { onDelete: "set null" }),
    tags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    language: text().notNull().default("en"),
    mature: boolean().notNull().default(false),
    theme: jsonb().$type<ChannelTheme>().notNull().default({}),
    chatSettings: jsonb().$type<ChannelChatSettings>().notNull().default(ChannelChatSettings.parse({})),
    vodEnabled: boolean().notNull().default(false),
    vodRetentionDays: integer().notNull().default(14),
    /** ADR 0026 decision 4; checked at raid start and again at execute. */
    raidPolicy: raidPolicy().notNull().default("anyone"),
    /** Set while a broadcast is live; maintained by the ingest lifecycle hooks. */
    liveBroadcastId: uuid(),
    followerCount: integer().notNull().default(0),
    suspendedAt: ts(),
    suspendedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("channels_slug_uq").on(t.slug),
    index("channels_live_idx")
      .on(t.liveBroadcastId)
      .where(sql`${t.liveBroadcastId} is not null`),
    index("channels_category_idx").on(t.categoryId),
    index("channels_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${t.displayName} || ' ' || ${t.title} || ' ' || ${t.description})`,
    ),
  ],
);

export const channelPanels = pgTable(
  "channel_panels",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    position: smallint().notNull(),
    title: text().notNull().default(""),
    /** Markdown, rendered with a strict allowlist. */
    body: text().notNull().default(""),
    imageKey: text(),
    linkUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("channel_panels_channel_idx").on(t.channelId, t.position)],
);

export const streamKeys = pgTable(
  "stream_keys",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** SHA-256 of the key; the plaintext is shown once at creation. */
    keyHash: text().notNull().unique(),
    /** First characters, shown in the dashboard and used for leak-scan matching. */
    prefix: text().notNull(),
    lastUsedAt: ts(),
    lastUsedIpHash: text(),
    revokedAt: ts(),
    revokedReason: text(),
    createdAt: createdAt(),
  },
  (t) => [index("stream_keys_channel_idx").on(t.channelId)],
);

export const channelRoles = pgTable(
  "channel_roles",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: channelRole().notNull(),
    grantedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId, t.role] }), index("channel_roles_user_idx").on(t.userId)],
);

export const follows = pgTable(
  "follows",
  {
    followerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    notify: boolean().notNull().default(true),
    /** Set by the integrity system; excluded follows are kept but not counted. */
    excludedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.channelId] }),
    index("follows_channel_idx").on(t.channelId, t.createdAt),
  ],
);

export const channelSubTiers = pgTable(
  "channel_sub_tiers",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    tier: smallint().notNull(),
    name: text().notNull(),
    priceCents: cents().notNull(),
    benefits: text().notNull().default(""),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.tier] })],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationType().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    readAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);
