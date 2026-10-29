// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Developer platform: OAuth apps, tokens, event subscriptions, the event outbox, webhook deliveries. */
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { EventCondition } from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import {
  appSuspensionReason,
  createdAt,
  deliveryStatus,
  deviceCodeStatus,
  eventTransport,
  id,
  oauthTokenKind,
  subscriptionState,
  ts,
} from "./_shared.ts";

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
    /** sha256 of the client secret; null for public clients (SPAs, CLIs, native apps). */
    clientSecretHash: text(),
    redirectUris: text().array().notNull(),
    /** Confidential apps also authenticate with a secret. Every app uses PKCE (ADR 0027 §1). */
    confidential: boolean().notNull().default(true),
    secretRotatedAt: ts(),
    suspendedAt: ts(),
    suspendedReason: appSuspensionReason(),
    suspendedById: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_apps_owner_idx").on(t.ownerId),
    check("oauth_apps_secret_ck", sql`${t.confidential} = (${t.clientSecretHash} is not null)`),
    check(
      "oauth_apps_suspension_ck",
      sql`(${t.suspendedAt} is null) = (${t.suspendedReason} is null) and (${t.suspendedAt} is null) = (${t.suspendedById} is null)`,
    ),
  ],
);

/** One-time authorization codes. Redeemed by CAS on `redeemed_at`; a second redemption revokes the family it issued. */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    codeHash: text().primaryKey(),
    appId: uuid()
      .notNull()
      .references(() => oauthApps.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text().array().notNull(),
    redirectUri: text().notNull(),
    codeChallenge: text().notNull(),
    codeChallengeMethod: text().notNull().default("S256"),
    expiresAt: ts().notNull(),
    redeemedAt: ts(),
    /** The token family the redemption started (reuse of the code revokes it, OAuth 2.1 §4.1.3). */
    familyId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_codes_expires_idx").on(t.expiresAt),
    check("oauth_codes_s256_ck", sql`${t.codeChallengeMethod} = 'S256'`),
    // The family exists exactly when the code was redeemed (reuse detection revokes it).
    check("oauth_codes_redeemed_ck", sql`(${t.redeemedAt} is null) = (${t.familyId} is null)`),
  ],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: id(),
    /** Null for personal tokens minted by a bot's owner (`me.bots.createToken`). */
    appId: uuid().references(() => oauthApps.id, { onDelete: "cascade" }),
    /** Null only for client-credentials (app-only) tokens, which carry no scopes. */
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    kind: oauthTokenKind().notNull().default("personal"),
    scopes: text().array().notNull(),
    accessTokenHash: text().notNull().unique(),
    refreshTokenHash: text().unique(),
    refreshExpiresAt: ts(),
    /** Every token descended from one authorization shares it; reuse of a rotated refresh token revokes them all. */
    familyId: uuid(),
    /** Set when its refresh token was exchanged (the row is revoked at the same moment). */
    rotatedAt: ts(),
    expiresAt: ts().notNull(),
    lastUsedAt: ts(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_tokens_user_idx").on(t.userId),
    index("oauth_tokens_app_user_idx").on(t.appId, t.userId),
    index("oauth_tokens_family_idx").on(t.familyId),
    // Both directions: an app-only token is exactly a client-credentials token, with no refresh
    // token and no scopes (its app is non-null through oauth_tokens_personal_ck).
    check(
      "oauth_tokens_app_only_ck",
      sql`(${t.userId} is null) = (${t.kind} = 'client_credentials') and (${t.userId} is not null or (${t.refreshTokenHash} is null and cardinality(${t.scopes}) = 0))`,
    ),
    check("oauth_tokens_family_ck", sql`(${t.refreshTokenHash} is null) = (${t.familyId} is null)`),
    check("oauth_tokens_refresh_expiry_ck", sql`(${t.refreshTokenHash} is null) = (${t.refreshExpiresAt} is null)`),
    check("oauth_tokens_personal_ck", sql`(${t.kind} = 'personal') = (${t.appId} is null)`),
  ],
);

/** RFC 8628 device authorizations. Codes are stored hashed; the user code is normalized (no dash, upper case). */
export const oauthDeviceCodes = pgTable(
  "oauth_device_codes",
  {
    id: id(),
    appId: uuid()
      .notNull()
      .references(() => oauthApps.id, { onDelete: "cascade" }),
    deviceCodeHash: text().notNull().unique(),
    userCodeHash: text().notNull(),
    scopes: text().array().notNull(),
    status: deviceCodeStatus().notNull().default("pending"),
    /** Who approved or denied it. */
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    intervalSeconds: integer().notNull().default(5),
    lastPolledAt: ts(),
    decidedAt: ts(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("oauth_device_codes_user_code_uq").on(t.userCodeHash),
    index("oauth_device_codes_expires_idx").on(t.expiresAt),
    check("oauth_device_codes_decided_ck", sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
    check("oauth_device_codes_user_ck", sql`(${t.status} = 'pending') = (${t.userId} is null)`),
  ],
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
    /** The user whose authorization backs this subscription (the app's owner for scope-less app subscriptions). */
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
    index("event_subscriptions_app_user_idx").on(t.appId, t.userId),
    index("event_subscriptions_ws_session_idx")
      .on(t.websocketSessionId)
      .where(sql`${t.websocketSessionId} is not null`),
    // A session id is part of the key: two WebSocket sessions may hold the same subscription.
    unique("event_subscriptions_dedupe_uq")
      .on(t.userId, t.appId, t.type, t.version, t.condition, t.transport, t.callbackUrl, t.websocketSessionId)
      .nullsNotDistinct(),
    check(
      "event_subscriptions_transport_ck",
      sql`(${t.transport} = 'webhook') = (${t.callbackUrl} is not null and ${t.secretCiphertext} is not null) and (${t.transport} = 'websocket') = (${t.websocketSessionId} is not null)`,
    ),
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
