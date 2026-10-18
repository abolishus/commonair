// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Developer platform: OAuth apps, tokens, event subscriptions, the event outbox, webhook deliveries. */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import type { EventCondition } from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import { createdAt, deliveryStatus, eventTransport, id, subscriptionState, ts } from "./_shared.ts";

export const oauthApps = pgTable(
  "oauth_apps",
  {
    id: id(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    clientId: text().notNull().unique(),
    clientSecretHash: text().notNull(),
    redirectUris: text().array().notNull(),
    /** Confidential apps hold a secret; public apps (SPAs, CLIs) must use PKCE. */
    confidential: boolean().notNull().default(true),
    secretRotatedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_apps_owner_idx").on(t.ownerId)],
);

export const oauthCodes = pgTable("oauth_codes", {
  codeHash: text().primaryKey(),
  appId: uuid()
    .notNull()
    .references(() => oauthApps.id, { onDelete: "cascade" }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scopes: text().array().notNull(),
  redirectUri: text().notNull(),
  codeChallenge: text(),
  expiresAt: ts().notNull(),
  createdAt: createdAt(),
});

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: id(),
    /** Null for personal tokens minted by the owner in the developer console. */
    appId: uuid().references(() => oauthApps.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text().array().notNull(),
    accessTokenHash: text().notNull().unique(),
    refreshTokenHash: text().unique(),
    expiresAt: ts().notNull(),
    lastUsedAt: ts(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_tokens_user_idx").on(t.userId), index("oauth_tokens_app_idx").on(t.appId)],
);

/** Transactional outbox: written in the same transaction as the change; relayed to Valkey by the worker. */
export const events = pgTable(
  "events",
  {
    id: id(),
    type: text().notNull(),
    version: text().notNull().default("1"),
    /** The broadcaster the event concerns (most subscriptions filter on it). */
    channelId: uuid(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    occurredAt: ts().notNull().defaultNow(),
    publishedAt: ts(),
  },
  (t) => [
    index("events_unpublished_idx")
      .on(t.occurredAt)
      .where(sql`${t.publishedAt} is null`),
    index("events_channel_type_idx").on(t.channelId, t.type, t.occurredAt),
  ],
);

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: id(),
    appId: uuid().references(() => oauthApps.id, { onDelete: "cascade" }),
    /** The user whose authorization backs this subscription. */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    version: text().notNull().default("1"),
    condition: jsonb().$type<EventCondition>().notNull(),
    transport: eventTransport().notNull(),
    callbackUrl: text(),
    /** HMAC secret for webhook signatures, encrypted at rest. */
    secretCiphertext: text(),
    websocketSessionId: text(),
    status: subscriptionState().notNull().default("verification_pending"),
    failureCount: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("event_subscriptions_type_idx").on(t.type, t.status),
    unique("event_subscriptions_dedupe_uq")
      .on(t.userId, t.appId, t.type, t.version, t.condition, t.transport, t.callbackUrl)
      .nullsNotDistinct(),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    subscriptionId: uuid()
      .notNull()
      .references(() => eventSubscriptions.id, { onDelete: "cascade" }),
    eventId: uuid().notNull(),
    /** The webhook message id (stable across retries for receiver-side dedupe). */
    messageId: text().notNull(),
    messageType: text().notNull().default("notification"),
    attempt: integer().notNull().default(1),
    status: deliveryStatus().notNull().default("pending"),
    responseStatus: integer(),
    responseBody: text(),
    error: text(),
    latencyMs: integer(),
    nextAttemptAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_deliveries_sub_idx").on(t.subscriptionId, t.createdAt)],
);
