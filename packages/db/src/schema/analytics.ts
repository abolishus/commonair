// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-broadcast audience rollup (W2-rollup-analytics, decision (k)) and signed audience
 * attestations (ADR 0014, W2b-attestations). The rollup is written once per broadcast after
 * verdicts settle (`AUDIENCE_SETTLE_SECONDS`) and replaced on a re-score; attestations read only
 * the rollup, so a sponsor's statement and the creator's chart cannot disagree. Counts, seconds,
 * bytes and categories only: never user ids, signal codes or thresholds.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DELIVERY_SOURCES, EXCLUSION_CATEGORIES } from "@commonair/contracts/enums";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { broadcasts } from "./media.ts";
import { attestationKind, createdAt, id, ts } from "./_shared.ts";

type ByCategory = Partial<Record<(typeof EXCLUSION_CATEGORIES)[number], number>>;
type BySource = Partial<Record<(typeof DELIVERY_SOURCES)[number], number>>;

/**
 * One row per broadcast minute: concurrent sessions by verdict (verified = gate-eligible;
 * unverified = pending and fetch-unjudged; excluded by category) and by delivery source. Kept
 * `ANALYTICS_RULES.minuteRetentionDays` (90), then deleted; the totals stay.
 */
export const broadcastAudienceMinutes = pgTable(
  "broadcast_audience_minutes",
  {
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    minute: ts().notNull(),
    verified: integer().notNull().default(0),
    unverified: integer().notNull().default(0),
    excluded: integer().notNull().default(0),
    excludedByCategory: jsonb().$type<ByCategory>().notNull().default({}),
    verifiedBySource: jsonb().$type<BySource>().notNull().default({}),
    rawBySource: jsonb().$type<BySource>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.broadcastId, t.minute] }),
    // The 90-day retention pass deletes by age.
    index("broadcast_audience_minutes_minute_idx").on(t.minute),
    check("broadcast_audience_minutes_counts", sql`${t.verified} >= 0 and ${t.unverified} >= 0 and ${t.excluded} >= 0`),
  ],
);

/** Per-broadcast totals of the rollup; never deleted by retention (attestations cite them). */
export const broadcastAudienceTotals = pgTable(
  "broadcast_audience_totals",
  {
    broadcastId: uuid()
      .primaryKey()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    durationSeconds: integer().notNull(),
    sessions: integer().notNull(),
    peakVerifiedConcurrent: integer().notNull(),
    verifiedViewerSeconds: bigint({ mode: "number" }).notNull(),
    unverifiedViewerSeconds: bigint({ mode: "number" }).notNull(),
    excludedViewerSeconds: bigint({ mode: "number" }).notNull(),
    /** Seconds and sessions by exclusion category (a session's category: its first reason's). */
    excludedSecondsByCategory: jsonb().$type<ByCategory>().notNull().default({}),
    excludedSessionsByCategory: jsonb().$type<ByCategory>().notNull().default({}),
    bytesBySource: jsonb().$type<BySource>().notNull().default({}),
    verifiedSecondsBySource: jsonb().$type<BySource>().notNull().default({}),
    /** When the rollup last ran, and when its per-minute rows were deleted (then it is final). */
    rolledUpAt: ts().notNull().defaultNow(),
    minutesPurgedAt: ts(),
  },
  (t) => [index("broadcast_audience_totals_channel_idx").on(t.channelId, t.rolledUpAt)],
);

/** Marginal serving cost of a broadcast: egress bytes by source × `INFRA_COST_MODEL`, rounded once. */
export const broadcastCosts = pgTable(
  "broadcast_costs",
  {
    broadcastId: uuid()
      .primaryKey()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    currency: text().notNull(),
    costCents: bigint({ mode: "number" }).notNull(),
    bytesBySource: jsonb().$type<BySource>().notNull().default({}),
    /** The cost model used (cents per GB by source), so the figure can be re-derived. */
    model: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    computedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    check("broadcast_costs_cents", sql`${t.costCents} >= 0`),
    check("broadcast_costs_currency", sql`${t.currency} ~ '^[a-z]{3}$'`),
  ],
);

/** Expiring analytics share links for one broadcast; the token is stored as its sha256 only. */
export const analyticsShareLinks = pgTable(
  "analytics_share_links",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("analytics_share_links_token_uq").on(t.tokenHash),
    index("analytics_share_links_channel_idx").on(t.channelId, t.createdAt),
    check("analytics_share_links_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * Attestation signing keys (ADR 0014 decision 1): the public history. Append-only except setting
 * `retired_at` and `compromised_at` once each (0043 trigger).
 */
export const integritySigningKeys = pgTable(
  "integrity_signing_keys",
  {
    /** First 16 bytes of SHA-256 over the raw public key, base64url (22 characters). */
    kid: text().primaryKey(),
    algorithm: text().notNull().default("Ed25519"),
    /** Raw 32-byte public key, base64url. */
    publicKey: text().notNull(),
    firstUsedAt: ts().notNull().defaultNow(),
    retiredAt: ts(),
    compromisedAt: ts(),
  },
  (t) => [
    uniqueIndex("integrity_signing_keys_public_key_uq").on(t.publicKey),
    check("integrity_signing_keys_algorithm", sql`${t.algorithm} = 'Ed25519'`),
    check("integrity_signing_keys_kid", sql`${t.kid} ~ '^[A-Za-z0-9_-]{22}$'`),
  ],
);

/**
 * A per-channel hash chain of signed statements (ADR 0014 decisions 2, 4, 5). Append-only; the
 * 0043 trigger refuses a `seq` that is not head + 1, a `prev_hash` that is not the head's
 * `entry_hash`, a retired or compromised `kid`, a second `broadcast` entry for one broadcast and a
 * rehearsal broadcast. `breakdown` and `salt` open the reasons commitment (owner and share links only).
 */
export const integrityAttestations = pgTable(
  "integrity_attestations",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "restrict" }),
    seq: integer().notNull(),
    kind: attestationKind().notNull(),
    kid: text()
      .notNull()
      .references(() => integritySigningKeys.kid, { onDelete: "restrict" }),
    /** The envelope: base64url signed payload bytes and base64url Ed25519 signature. */
    payload: text().notNull(),
    signature: text().notNull(),
    /** Hex SHA-256 of the signed payload bytes; `prev_hash` is the channel's previous entry's. */
    entryHash: text().notNull(),
    prevHash: text(),
    /** `supersede` / `reissue`: the entry hash this one replaces. */
    supersedes: text(),
    signedAt: ts().notNull(),
    breakdown: jsonb().$type<ByCategory>().notNull().default({}),
    salt: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("integrity_attestations_seq_uq").on(t.channelId, t.seq),
    uniqueIndex("integrity_attestations_entry_hash_uq").on(t.entryHash),
    uniqueIndex("integrity_attestations_broadcast_uq")
      .on(t.broadcastId)
      .where(sql`${t.kind} = 'broadcast'`),
    index("integrity_attestations_broadcast_idx").on(t.broadcastId, t.seq),
    check("integrity_attestations_seq", sql`${t.seq} > 0`),
    check("integrity_attestations_supersedes", sql`(${t.kind} = 'broadcast') = (${t.supersedes} is null)`),
  ],
);

/** Expiring share links revealing an attestation's breakdown; the token is stored as its sha256 only. */
export const attestationShareLinks = pgTable(
  "attestation_share_links",
  {
    id: id(),
    attestationId: uuid()
      .notNull()
      .references(() => integrityAttestations.id, { onDelete: "restrict" }),
    tokenHash: text().notNull(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("attestation_share_links_token_uq").on(t.tokenHash),
    index("attestation_share_links_attestation_idx").on(t.attestationId),
    check("attestation_share_links_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
