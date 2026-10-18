// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { categories, channels } from "./channels.ts";
import {
  clipStatus,
  createdAt,
  deliverySource,
  id,
  ingestProtocol,
  simulcastPlatform,
  simulcastStatus,
  ts,
  updatedAt,
  visibility,
  vodStatus,
} from "./_shared.ts";

export const broadcasts = pgTable(
  "broadcasts",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    streamKeyId: uuid(),
    ingestProtocol: ingestProtocol().notNull(),
    /** MediaMTX path name (live/<channel slug>). */
    path: text().notNull(),
    title: text().notNull().default(""),
    categoryId: uuid().references(() => categories.id, { onDelete: "set null" }),
    mature: boolean().notNull().default(false),
    startedAt: ts().notNull().defaultNow(),
    endedAt: ts(),
    transcodeActive: boolean().notNull().default(false),
    thumbnailKey: text(),
    /** Aggregates from verified sessions only (maintained by the worker). */
    peakVerifiedViewers: integer().notNull().default(0),
    verifiedViewerSeconds: bigint({ mode: "number" }).notNull().default(0),
    excludedViewerSeconds: bigint({ mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("broadcasts_channel_idx").on(t.channelId, t.startedAt),
    index("broadcasts_live_idx")
      .on(t.channelId)
      .where(sql`${t.endedAt} is null`),
  ],
);

/**
 * Streaming hours that count toward membership eligibility and patronage:
 * one row per broadcast per clock hour, eligible only if it had at least one
 * verified viewer other than the streamer. The 8 h/day cap is applied when summing.
 */
export const streamHours = pgTable(
  "stream_hours",
  {
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "restrict" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    hourStart: ts().notNull(),
    liveSeconds: integer().notNull(),
    verifiedOtherViewers: integer().notNull().default(0),
    eligible: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.broadcastId, t.hourStart] }),
    index("stream_hours_channel_idx").on(t.channelId, t.hourStart),
  ],
);

export const broadcastHealthSamples = pgTable(
  "broadcast_health_samples",
  {
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    at: ts().notNull(),
    bitrateKbps: integer().notNull(),
    fps: real(),
    width: integer(),
    height: integer(),
    videoCodec: text(),
    audioCodec: text(),
    keyframeIntervalMs: integer(),
    droppedFrames: integer().notNull().default(0),
    warnings: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [primaryKey({ columns: [t.broadcastId, t.at] })],
);

/** Egress per broadcast per minute per delivery source: the cost model. */
export const egressSamples = pgTable(
  "egress_samples",
  {
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    bucketStart: ts().notNull(),
    source: deliverySource().notNull(),
    bytes: bigint({ mode: "number" }).notNull(),
    requests: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.broadcastId, t.bucketStart, t.source] }),
    index("egress_samples_bucket_idx").on(t.bucketStart),
  ],
);

export const vods = pgTable(
  "vods",
  {
    id: id(),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text().notNull(),
    status: vodStatus().notNull().default("recording"),
    visibility: visibility().notNull().default("public"),
    /** Object-storage prefix holding the HLS playlist and segments. */
    storagePrefix: text().notNull(),
    durationSeconds: doublePrecision().notNull().default(0),
    sizeBytes: bigint({ mode: "number" }).notNull().default(0),
    thumbnailKey: text(),
    expiresAt: ts(),
    removedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("vods_channel_idx").on(t.channelId, t.createdAt), index("vods_expiry_idx").on(t.expiresAt)],
);

export const clips = pgTable(
  "clips",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    broadcastId: uuid().references(() => broadcasts.id, { onDelete: "set null" }),
    vodId: uuid().references(() => vods.id, { onDelete: "set null" }),
    creatorId: uuid().references(() => users.id, { onDelete: "set null" }),
    title: text().notNull(),
    /** Seconds from the start of the broadcast. */
    startOffset: doublePrecision().notNull(),
    durationSeconds: doublePrecision().notNull(),
    status: clipStatus().notNull().default("processing"),
    storageKey: text(),
    thumbnailKey: text(),
    views: integer().notNull().default(0),
    removedReason: text(),
    createdAt: createdAt(),
  },
  (t) => [index("clips_channel_idx").on(t.channelId, t.createdAt)],
);

export const simulcastTargets = pgTable(
  "simulcast_targets",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    platform: simulcastPlatform().notNull(),
    name: text().notNull(),
    rtmpUrl: text().notNull(),
    /** AES-GCM encrypted with a key derived from AUTH_SECRET; never returned by the API. */
    streamKeyCiphertext: text().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("simulcast_targets_channel_idx").on(t.channelId)],
);

export const simulcastSessions = pgTable(
  "simulcast_sessions",
  {
    id: id(),
    targetId: uuid()
      .notNull()
      .references(() => simulcastTargets.id, { onDelete: "cascade" }),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    status: simulcastStatus().notNull().default("connecting"),
    lastError: text(),
    bytesSent: bigint({ mode: "number" }).notNull().default(0),
    startedAt: ts().notNull().defaultNow(),
    endedAt: ts(),
  },
  (t) => [index("simulcast_sessions_broadcast_idx").on(t.broadcastId)],
);

export const hashMatchResults = pgTable(
  "hash_match_results",
  {
    id: id(),
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),
    provider: text().notNull(),
    matched: boolean().notNull(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    checkedAt: ts().notNull().defaultNow(),
  },
  (t) => [index("hash_match_subject_idx").on(t.subjectType, t.subjectId)],
);
