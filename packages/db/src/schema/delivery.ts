// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ReceiptPayload } from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { broadcasts } from "./media.ts";
import { createdAt, deliverySource, id, receiptStatus, relayStatus, sessionVerdict, ts, updatedAt } from "./_shared.ts";

export const relayNodes = pgTable(
  "relay_nodes",
  {
    id: id(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text().notNull(),
    publicUrl: text().notNull(),
    region: text().notNull().default(""),
    declaredCapacityMbps: integer().notNull(),
    /** Ed25519 public key (raw 32 bytes, base64url) the relay signs receipts with. */
    publicKey: text().notNull(),
    /** SHA-256 of the registration token. */
    tokenHash: text().notNull().unique(),
    version: text(),
    status: relayStatus().notNull().default("pending"),
    measuredCapacityMbps: integer(),
    lastHealthAt: ts(),
    lastHealthLatencyMs: integer(),
    consecutiveFailures: integer().notNull().default(0),
    suspendedAt: ts(),
    suspendedReason: text(),
    /**
     * Set when the owner retires the relay (its token hash is rotated so it never authenticates
     * again). `offline` alone means drained or timed out: such a relay may register again.
     */
    retiredAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("relay_nodes_owner_idx").on(t.ownerId), index("relay_nodes_status_idx").on(t.status)],
);

export const playbackSessions = pgTable(
  "playback_sessions",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    broadcastId: uuid().references(() => broadcasts.id, { onDelete: "restrict" }),
    /** Null for anonymous viewers. */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Salted hashes: integrity needs equality, never the raw values. */
    deviceHash: text().notNull(),
    ipHash: text().notNull(),
    /** Network classification at session start (ASN number and whether it is a hosting provider). */
    asn: integer(),
    datacenter: text(),
    userAgent: text(),
    fingerprint: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    assignedSource: deliverySource().notNull().default("origin"),
    relayId: uuid().references(() => relayNodes.id, { onDelete: "set null" }),
    startedAt: ts().notNull().defaultNow(),
    lastHeartbeatAt: ts(),
    endedAt: ts(),
    heartbeats: integer().notNull().default(0),
    watchSeconds: integer().notNull().default(0),
    segmentsFetched: integer().notNull().default(0),
    bytesHttp: bigint({ mode: "number" }).notNull().default(0),
    bytesP2p: bigint({ mode: "number" }).notNull().default(0),
    stalls: integer().notNull().default(0),
    ttffMs: integer(),
    latencyMs: doublePrecision(),
    verdict: sessionVerdict().notNull().default("pending"),
    verdictReasons: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    score: doublePrecision(),
    scoredAt: ts(),
  },
  (t) => [
    index("playback_sessions_broadcast_idx").on(t.broadcastId, t.verdict),
    index("playback_sessions_active_idx")
      .on(t.channelId)
      .where(sql`${t.endedAt} is null`),
    index("playback_sessions_device_idx").on(t.deviceHash, t.startedAt),
    index("playback_sessions_user_idx").on(t.userId, t.startedAt),
    index("playback_sessions_relay_idx").on(t.relayId, t.startedAt),
    // Integrity scans: sessions still to score, and live sessions by heartbeat age.
    index("playback_sessions_scoring_idx")
      .on(t.scoredAt.asc().nullsFirst())
      .where(sql`${t.endedAt} is null or ${t.verdict} = 'pending'`),
    index("playback_sessions_live_hb_idx")
      .on(t.lastHeartbeatAt)
      .where(sql`${t.endedAt} is null`),
  ],
);

/**
 * What the origin issued for each relay, per minute: the ground truth relay
 * receipts are checked against.
 */
export const relayIssuance = pgTable(
  "relay_issuance",
  {
    relayId: uuid()
      .notNull()
      .references(() => relayNodes.id, { onDelete: "restrict" }),
    bucketStart: ts().notNull(),
    sessions: integer().notNull().default(0),
    segmentTokens: integer().notNull().default(0),
    /** Upper bound of bytes the relay could legitimately serve for the issued tokens. */
    bytesIssued: bigint({ mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.relayId, t.bucketStart] })],
);

export const relayReceipts = pgTable(
  "relay_receipts",
  {
    id: id(),
    relayId: uuid()
      .notNull()
      .references(() => relayNodes.id, { onDelete: "restrict" }),
    /** Relay-chosen nonce; replays are rejected. */
    nonce: text().notNull(),
    periodStart: ts().notNull(),
    periodEnd: ts().notNull(),
    bytesReported: bigint({ mode: "number" }).notNull(),
    segmentsReported: integer().notNull(),
    tokensReported: integer().notNull(),
    payload: jsonb().$type<ReceiptPayload>().notNull(),
    signature: text().notNull(),
    status: receiptStatus().notNull().default("pending"),
    bytesVerified: bigint({ mode: "number" }).notNull().default(0),
    /** reported / issued − 1, when checked. */
    overReportRatio: doublePrecision(),
    checkedAt: ts(),
    rejectionReason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("relay_receipts_nonce_uq").on(t.relayId, t.nonce),
    index("relay_receipts_period_idx").on(t.relayId, t.periodStart),
    index("relay_receipts_status_idx").on(t.status),
  ],
);
