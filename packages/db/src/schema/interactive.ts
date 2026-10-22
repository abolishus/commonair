// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Built-in channel bot, loyalty points, polls, predictions, raids, alerts, goals, overlays. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import {
  alertType,
  cents,
  createdAt,
  goalType,
  id,
  pollStatus,
  predictionStatus,
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
  enabled: boolean().notNull().default(true),
  config: jsonb().$type<BotConfig>().notNull(),
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

export const loyaltyBalances = pgTable(
  "loyalty_balances",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    points: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);

export const loyaltyTransactions = pgTable(
  "loyalty_transactions",
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    delta: bigint({ mode: "number" }).notNull(),
    reason: text().notNull(),
    refId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index("loyalty_tx_user_idx").on(t.channelId, t.userId, t.createdAt)],
);

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
    query: text().notNull(),
    status: songRequestStatus().notNull().default("queued"),
    createdAt: createdAt(),
  },
  (t) => [index("song_requests_channel_idx").on(t.channelId, t.status, t.createdAt)],
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
  },
  (t) => [index("polls_channel_idx").on(t.channelId, t.startedAt)],
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
    resolvedAt: ts(),
  },
  (t) => [index("predictions_channel_idx").on(t.channelId, t.startedAt)],
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
  },
  (t) => [index("raids_to_idx").on(t.toChannelId, t.createdAt)],
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
  (t) => [index("goals_channel_idx").on(t.channelId)],
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
