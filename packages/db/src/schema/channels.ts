// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import {
  ChannelCaptionsSettings,
  ChannelChatSettings,
  type ChannelSocial,
  ChannelFederationSettings,
  type ChannelTheme,
} from "@commonair/contracts/shapes";
import type { StreamSetupMarkable } from "@commonair/contracts/enums";
import { users } from "./auth.ts";
import {
  cents,
  channelRole,
  createdAt,
  followSource,
  id,
  notificationType,
  raidPolicy,
  ts,
  updatedAt,
} from "./_shared.ts";

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
    /**
     * W2-captions (ADR 0011): the channel's captions choice, spoken language and mask list (jsonb,
     * parsed with `ChannelCaptionsSettings`). `enabled: null` follows `captions.defaultEnabled`.
     */
    captionsSettings: jsonb().$type<ChannelCaptionsSettings>().notNull().default(ChannelCaptionsSettings.parse({})),
    /** W2-dvr (ADR 0016, decision (b)): DVR needs VODs on; the effective window is capped by `DVR_MAX_WINDOW_SECONDS`. */
    dvrEnabled: boolean().notNull().default(true),
    dvrWindowSeconds: integer().notNull().default(1800),
    /** ADR 0026 decision 4; checked at raid start and again at execute. */
    raidPolicy: raidPolicy().notNull().default("anyone"),
    /**
     * Batch 7 (ADR 0030, decision (c)): `{enabled}` (jsonb, parsed with `ChannelFederationSettings`,
     * the chat and captions settings pattern). Off until the streamer turns it on.
     */
    federationSettings: jsonb()
      .$type<ChannelFederationSettings>()
      .notNull()
      .default(ChannelFederationSettings.parse({})),
    /** Set while a broadcast is live; maintained by the ingest lifecycle hooks. */
    liveBroadcastId: uuid(),
    /**
     * Non-excluded follows. Maintained only by the follows trigger (migration 0046, decision (aa));
     * a direct write is refused.
     */
    followerCount: integer().notNull().default(0),
    suspendedAt: ts(),
    suspendedReason: text(),
    /** About-tab links (jsonb array, parsed with `ChannelSocial`; at most `MAX_CHANNEL_SOCIALS`). */
    socials: jsonb().$type<ChannelSocial[]>().notNull().default([]),
    /** Batch 7 decision (l): where the channel says it moved (an https URL) and when. */
    movedTo: text(),
    movedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("channels_slug_uq").on(t.slug),
    check(
      "channels_moved_to_https",
      sql`(${t.movedTo} is null) = (${t.movedAt} is null) and (${t.movedTo} is null or (${t.movedTo} ~ '^https://' and length(${t.movedTo}) <= 500))`,
    ),
    index("channels_live_idx")
      .on(t.liveBroadcastId)
      .where(sql`${t.liveBroadcastId} is not null`),
    index("channels_category_idx").on(t.categoryId),
    check("channels_dvr_window_range", sql`${t.dvrWindowSeconds} between 60 and 86400`),
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
    /** Batch 7 decision (k): how the follow was made; `move_link` names the link. */
    source: followSource().notNull().default("direct"),
    moveLinkId: uuid().references(() => moveLinks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.channelId] }),
    index("follows_move_link_idx")
      .on(t.moveLinkId)
      .where(sql`${t.moveLinkId} is not null`),
    check("follows_move_link_source", sql`${t.moveLinkId} is null or ${t.source} = 'move_link'`),
    index("follows_channel_idx").on(t.channelId, t.createdAt),
    // The go-live fan-out pages a channel's notifying followers by follower id.
    index("follows_channel_notify_idx")
      .on(t.channelId, t.followerId)
      .where(sql`${t.notify}`),
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
    /** Set by writers that may run twice (go-live: `go-live-<eventId>`); unique per user. */
    dedupeKey: text(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("notifications_dedupe_uq")
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index("notifications_user_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
    // The `notify-prune` job deletes by age in batches.
    index("notifications_created_idx").on(t.createdAt),
    // Account deletion removes every follower's go_live rows about a deleted channel.
    index("notifications_go_live_channel_idx")
      .on(sql`(${t.payload}->>'channelId')`)
      .where(sql`${t.type} = 'go_live'`),
  ],
);

/**
 * Batch 7 move links (decision (k)): `/m/<slug>/<nonce>`, the nonce (128 random bits) stored as its
 * SHA-256 and checked by lookup. At most `MOVE_LINK_RULES.maxActive` unrevoked links per channel
 * (migration 0046).
 */
export const moveLinks = pgTable(
  "move_links",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the nonce. */
    nonceHash: text().notNull(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    revokedAt: ts(),
    expiresAt: ts(),
  },
  (t) => [
    uniqueIndex("move_links_nonce_hash_uq").on(t.nonceHash),
    index("move_links_channel_idx").on(t.channelId, t.createdAt),
    check("move_links_nonce_hash", sql`${t.nonceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Batch 7 decision (l): "tell me if they move". The worker sends one `channelMoved` email per row
 * when the channel sets `moved_to`, then deletes the rows. The streamer never sees them.
 */
export const followPortabilityGrants = pgTable(
  "follow_portability_grants",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.channelId] }),
    index("follow_portability_grants_channel_idx").on(t.channelId),
  ],
);

/**
 * Overhaul wave 3 (D5.1): checklist steps the owner marked done (`stream.setupMark`); the other
 * steps of `stream.setupState` are derived from existing rows. One row per (channel, step).
 */
export const channelSetupSteps = pgTable(
  "channel_setup_steps",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    step: text().$type<StreamSetupMarkable>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.step] }),
    check("channel_setup_steps_step", sql`${t.step} IN ('bring_your_audience', 'get_paid')`),
  ],
);
