// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Go-live notifications, web push and the Discord adapter (N1, ADR 0028). Mutable working state: no history. */
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, discordWebhookError, id, notificationMedium, notificationType, ts, updatedAt } from "./_shared.ts";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { broadcasts } from "./media.ts";

/** type × channel × medium (ADR 0028 decision 4). A null channel is the member's default for the type and medium. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationType().notNull(),
    channelId: uuid().references(() => channels.id, { onDelete: "cascade" }),
    medium: notificationMedium().notNull(),
    enabled: boolean().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One default and one override per channel: nulls compare equal, so upserts can target it.
    // A constraint, not an index: drizzle's index builder has no NULLS NOT DISTINCT.
    unique("notification_prefs_uq").on(t.userId, t.type, t.medium, t.channelId).nullsNotDistinct(),
    index("notification_prefs_channel_idx")
      .on(t.channelId)
      .where(sql`${t.channelId} is not null`),
  ],
);

/**
 * The cooldown (ADR 0028 decision 3): one row per follower and channel, moved forward by one
 * conditional upsert, so several worker replicas cannot both send.
 */
export const notificationGoLiveSends = pgTable(
  "notification_go_live_sends",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    lastSentAt: ts().notNull(),
    /** The `stream.online` that last passed: a redelivered job for the same event passes again (idempotent sends). No FK: events are pruned. */
    eventId: uuid().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
);

/** Go-live emails waiting for the digest sweep (ADR 0028 decision 3). Deleted when sent. */
export const notificationEmailQueue = pgTable(
  "notification_email_queue",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid().notNull(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    queuedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] }), index("notification_email_queue_due_idx").on(t.queuedAt)],
);

/** One browser's push subscription (ADR 0028 decision 6): encrypted, found by an HMAC of its endpoint. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `hmacHex(AUTH_SECRET, "push-endpoint:" + endpoint)`: unique, so a browser belongs to the last member who subscribed it. */
    endpointHash: text().notNull().unique(),
    /** `encryptSecret(AUTH_SECRET, "push-subscription", JSON { endpoint, p256dh, auth })`; never logged. */
    subscription: text().notNull(),
    createdAt: createdAt(),
    lastSuccessAt: ts(),
    failures: integer().notNull().default(0),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId, t.createdAt)],
);

/** A channel's Discord webhook (ADR 0028 decision 5). The URL is a secret: encrypted, never returned. */
export const discordWebhooks = pgTable("discord_webhooks", {
  channelId: uuid()
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  /** `encryptSecret(AUTH_SECRET, "discord-webhook", url)`. */
  url: text().notNull(),
  setBy: uuid().references(() => users.id, { onDelete: "set null" }),
  setAt: createdAt(),
  /** The last go-live post (the per-channel cooldown); test posts do not set it. */
  lastPostedAt: ts(),
  /** Consecutive 401/404 answers; at `NOTIFY_RULES.discordFailureLimit` the row is deleted. */
  failures: integer().notNull().default(0),
  lastError: discordWebhookError(),
  updatedAt: updatedAt(),
});
