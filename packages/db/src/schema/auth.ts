// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Identity tables. Column sets match better-auth's core schema plus the
 * username, admin, two-factor and passkey plugins (mapped to plural table names
 * in services/api's auth config). Extra columns are CommonAir's.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accountType, createdAt, id, platformRole, ts, updatedAt } from "./_shared.ts";

export const users = pgTable(
  "users",
  {
    id: id(),
    /** Display name. */
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    /** Lowercase login handle; also the channel slug. */
    username: text().notNull(),
    displayUsername: text(),
    role: platformRole().notNull().default("user"),
    banned: boolean().notNull().default(false),
    banReason: text(),
    banExpires: ts(),
    twoFactorEnabled: boolean().notNull().default(false),
    accountType: accountType().notNull().default("human"),
    /** For bot accounts: the human member who owns and answers for the bot. */
    /** Verified bots (reviewed by platform staff) get the higher chat rate limits. */
    botVerified: boolean().notNull().default(false),
    botOwnerId: uuid().references((): AnyPgColumn => users.id, { onDelete: "cascade" }),
    /** Collected at signup for the 13+ gate and to know when 18+ content may be shown. */
    birthDate: date({ mode: "string" }),
    /** Consent-respecting contact: may this user's email be included in a streamer's follower export? */
    shareEmailWithFollowedChannels: boolean().notNull().default(false),
    /** When an adult confirmed they want to see mature (18+) streams. */
    matureConfirmedAt: ts(),
    /** Chosen language (BCP 47); null = never chosen: the web negotiates, mail uses INSTANCE_DEFAULT_LOCALE (ADR 0029). */
    locale: text(),
    /** Set when deletion completes; the row is pseudonymized, not dropped, if retention requires it. */
    deletedAt: ts(),
    pseudonymizedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_username_uq").on(t.username),
    index("users_bot_owner_idx").on(t.botOwnerId),
    check("users_locale_format", sql`${t.locale} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$'`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: ts().notNull(),
    ipAddress: text(),
    userAgent: text(),
    impersonatedBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: ts(),
    refreshTokenExpiresAt: ts(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_idx").on(t.userId), uniqueIndex("accounts_provider_uq").on(t.providerId, t.accountId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const twoFactors = pgTable("two_factors", {
  id: id(),
  userId: uuid()
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text().notNull(),
  backupCodes: text().notNull(),
  /** better-auth 1.7 two-factor plugin: enrollment verified, and brute-force lockout. */
  verified: boolean().notNull().default(true),
  failedVerificationCount: integer().notNull().default(0),
  lockedUntil: ts(),
});

export const passkeys = pgTable(
  "passkeys",
  {
    id: id(),
    name: text(),
    publicKey: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialID: text().notNull().unique(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    aaguid: text(),
    createdAt: createdAt(),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);
