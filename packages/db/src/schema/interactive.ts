// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Built-in channel bot, loyalty points, polls, predictions, raids, alerts, goals, overlays. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AlertTemplate, BotConfig, PollChoice, PredictionOutcome } from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { playbackSessions } from "./delivery.ts";
import {
  alertType,
  cents,
  createdAt,
  goalType,
  id,
  loyaltyReason,
  pollStatus,
  predictionStatus,
  raidCancelReason,
  raidStatus,
  songRequestStatus,
  ts,
  updatedAt,
  userLevel,
} from "./_shared.ts";

export const botConfigs = pgTable("bot_configs", {
  channelId: uuid()
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(false),
  config: jsonb().$type<BotConfig>().notNull(),
  /** The channel's bot account; null until the bot is first enabled. */
  botUserId: uuid()
    .unique()
    .references(() => users.id, { onDelete: "restrict" }),
  updatedAt: updatedAt(),
});

export const botCommands = pgTable(
  "bot_commands",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Without the leading "!". */
    name: text().notNull(),
    aliases: text().array().notNull().default([]),
    /** Template with variables, e.g. "Hi ${user}! Uptime: ${uptime}". */
    response: text().notNull(),
    userLevel: userLevel().notNull().default("everyone"),
    cooldownSeconds: integer().notNull().default(5),
    costPoints: integer().notNull().default(0),
    enabled: boolean().notNull().default(true),
    useCount: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bot_commands_name_uq").on(t.channelId, t.name)],
);

export const botTimers = pgTable(
  "bot_timers",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text().notNull(),
    message: text().notNull(),
    intervalMinutes: integer().notNull(),
    /** Only fire if at least this many chat lines arrived since the last firing. */
    minChatLines: integer().notNull().default(5),
    enabled: boolean().notNull().default(true),
    lastFiredAt: ts(),
  },
  (t) => [index("bot_timers_channel_idx").on(t.channelId)],
);

export const botVariables = pgTable(
  "bot_variables",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text().notNull(),
    value: text().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.name] })],
);

/**
 * Written only by the `loyalty_transactions` trigger (migration 0034); the CHECK makes an overdraw
 * fail the inserting transaction.
 */
export const loyaltyBalances = pgTable(
  "loyalty_balances",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    points: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    check("loyalty_balances_points_nonneg", sql`${t.points} >= 0`),
    index("loyalty_balances_leaderboard_idx").on(t.channelId, t.points),
  ],
);

/** The points ledger (ADR 0026 decision 2): append-only, balances follow by trigger (migration 0034). */
export const loyaltyTransactions = pgTable(
  "loyalty_transactions",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    delta: bigint({ mode: "number" }).notNull(),
    reason: loyaltyReason().notNull(),
    /** The poll, prediction, command or audit row. */
    refId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("loyalty_tx_user_idx").on(t.channelId, t.userId, t.createdAt),
    check("loyalty_tx_delta_nonzero", sql`${t.delta} <> 0`),
    check(
      "loyalty_tx_sign_ck",
      sql`(${t.reason} in ('watch', 'prediction_payout', 'prediction_refund') and ${t.delta} > 0)
       or (${t.reason} in ('command', 'prediction_bet', 'poll_vote') and ${t.delta} < 0)
       or ${t.reason} = 'moderator_adjust'`,
    ),
  ],
);

/** Points accrual state per viewer and channel (worker `points-accrue` only; mutable, no history). */
export const loyaltyAccruals = pgTable(
  "loyalty_accruals",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Gate-eligible seconds not yet worth a whole block. */
    carrySeconds: integer().notNull().default(0),
    /** The UTC day `dayPoints` counts. */
    day: date({ mode: "string" }).notNull(),
    dayPoints: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);

/** High-water mark per playback session: watch seconds already turned into carry or points. */
export const loyaltyAccrualSessions = pgTable("loyalty_accrual_sessions", {
  sessionId: uuid()
    .primaryKey()
    .references(() => playbackSessions.id, { onDelete: "cascade" }),
  countedSeconds: integer().notNull().default(0),
  updatedAt: updatedAt(),
});

export const songRequests = pgTable(
  "song_requests",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    requesterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A link; never fetched. */
    url: text().notNull(),
    status: songRequestStatus().notNull().default("queued"),
    createdAt: createdAt(),
  },
  (t) => [
    index("song_requests_channel_idx").on(t.channelId, t.status, t.createdAt),
    index("song_requests_requester_idx").on(t.channelId, t.requesterId, t.status),
  ],
);

export const polls = pgTable(
  "polls",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text().notNull(),
    choices: jsonb().$type<PollChoice[]>().notNull(),
    status: pollStatus().notNull().default("active"),
    durationSeconds: integer().notNull(),
    /** Extra votes may be bought with channel points; 0 disables. */
    pointsPerExtraVote: integer().notNull().default(0),
    createdById: uuid(),
    startedAt: ts().notNull().defaultNow(),
    endsAt: ts().notNull(),
    endedAt: ts(),
    /** Last vote. */
    changedAt: ts(),
    /** Last `channel.poll.progress`. */
    progressAt: ts(),
  },
  (t) => [
    index("polls_channel_idx").on(t.channelId, t.startedAt),
    uniqueIndex("polls_channel_active_uq")
      .on(t.channelId)
      .where(sql`${t.status} = 'active'`),
    index("polls_due_idx")
      .on(t.endsAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const pollVotes = pgTable(
  "poll_votes",
  {
    pollId: uuid()
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    choiceId: text().notNull(),
    votes: integer().notNull().default(1),
    pointsSpent: integer().notNull().default(0),
    castAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.userId] })],
);

export const predictions = pgTable(
  "predictions",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text().notNull(),
    outcomes: jsonb().$type<PredictionOutcome[]>().notNull(),
    status: predictionStatus().notNull().default("active"),
    windowSeconds: integer().notNull(),
    winningOutcomeId: text(),
    createdById: uuid(),
    startedAt: ts().notNull().defaultNow(),
    locksAt: ts().notNull(),
    lockedAt: ts(),
    resolvedAt: ts(),
    /** Last bet. */
    changedAt: ts(),
    /** Last `channel.prediction.progress`. */
    progressAt: ts(),
  },
  (t) => [
    index("predictions_channel_idx").on(t.channelId, t.startedAt),
    uniqueIndex("predictions_channel_open_uq")
      .on(t.channelId)
      .where(sql`${t.status} in ('active', 'locked')`),
    index("predictions_due_idx")
      .on(t.locksAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const predictionBets = pgTable(
  "prediction_bets",
  {
    predictionId: uuid()
      .notNull()
      .references(() => predictions.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    outcomeId: text().notNull(),
    points: bigint({ mode: "number" }).notNull(),
    payout: bigint({ mode: "number" }),
    placedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.predictionId, t.userId] })],
);

export const raids = pgTable(
  "raids",
  {
    id: id(),
    fromChannelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    toChannelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Verified viewers carried over (integrity-filtered). */
    viewerCount: integer().notNull().default(0),
    status: raidStatus().notNull().default("pending"),
    createdById: uuid(),
    createdAt: createdAt(),
    executeAt: ts().notNull(),
    executedAt: ts(),
    canceledAt: ts(),
    cancelReason: raidCancelReason(),
  },
  (t) => [
    index("raids_to_idx").on(t.toChannelId, t.createdAt),
    // One pending raid per source channel at a time.
    uniqueIndex("raids_from_pending_uq")
      .on(t.fromChannelId)
      .where(sql`${t.status} = 'pending'`),
    // The cooldown reads the source's last raid.
    index("raids_from_idx").on(t.fromChannelId, t.createdAt),
    index("raids_due_idx")
      .on(t.executeAt)
      .where(sql`${t.status} = 'pending'`),
    check("raids_cancel_ck", sql`(${t.status} = 'canceled') = (${t.cancelReason} is not null)`),
  ],
);

export const alertConfigs = pgTable(
  "alert_configs",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    type: alertType().notNull(),
    enabled: boolean().notNull().default(true),
    template: jsonb().$type<AlertTemplate>().notNull(),
    minAmountCents: cents().notNull().default(0),
    durationMs: integer().notNull().default(6000),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("alert_configs_uq").on(t.channelId, t.type)],
);

export const goals = pgTable(
  "goals",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    type: goalType().notNull(),
    title: text().notNull(),
    target: bigint({ mode: "number" }).notNull(),
    current: bigint({ mode: "number" }).notNull().default(0),
    startedAt: ts().notNull().defaultNow(),
    endedAt: ts(),
  },
  (t) => [
    index("goals_channel_idx").on(t.channelId),
    // The outbox hook advances "the channel's open goal of the matching type".
    uniqueIndex("goals_channel_open_uq")
      .on(t.channelId, t.type)
      .where(sql`${t.endedAt} is null`),
  ],
);

/**
 * Secret URLs for OBS browser sources; scoped to one channel's overlay state and alert stream
 * (ADR 0021). One unrevoked token per channel: creating a new one revokes the old in the same
 * transaction. `expiresAt` null means no expiry (the streamer's choice).
 */
export const overlayTokens = pgTable(
  "overlay_tokens",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    createdAt: createdAt(),
    expiresAt: ts(),
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex("overlay_tokens_active_uq")
      .on(t.channelId)
      .where(sql`${t.revokedAt} is null`),
  ],
);
