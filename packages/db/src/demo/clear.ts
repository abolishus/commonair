// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Demo clear: deletes every user carrying BOTH fixture anchors (anchors.ts), the bots they own,
 * and everything hanging off them, children before parents, in one transaction. Several parents
 * are RESTRICT (channels.owner_id; playback sessions, stream hours and integrity flags on
 * channels and broadcasts), so those children go first. Append-only rows (audit_log) stay: they
 * reference ids only (ADR 0004). Money, co-op and relay rows are never touched: if an anchored
 * user has any, their RESTRICT keys make the transaction fail and nothing is deleted. The same
 * holds for channel points (ADR 0026): `loyalty_transactions` and `loyalty_balances` are RESTRICT
 * and append-only like money, so a demo user or channel with any points ledger row fails the
 * clear as a whole. The worker's `points-accrue` skips demo channels and viewers so watching the
 * demo never creates one; the accrual tables cascade and need no step here.
 */
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database, Executor } from "../client.ts";
import { accounts, sessions, users } from "../schema/auth.ts";
import { channelRoles, channels, follows, notifications, streamKeys } from "../schema/channels.ts";
import { chatBans, chatMessages } from "../schema/chat.ts";
import { playbackSessions } from "../schema/delivery.ts";
import { broadcasts, clips, streamHours, vods } from "../schema/media.ts";
import { oauthTokens } from "../schema/platform.ts";
import { integrityFlags, modActions, reports } from "../schema/safety.ts";
import { anchoredUser } from "./anchors.ts";

/** The ids one clear works on. */
export interface ClearScope {
  /** Users with both anchors. */
  anchored: string[];
  /** Anchored users plus the bots they own (bots hang off their owner). */
  subjects: string[];
  /** Bot accounts among `subjects` (deleted before their owners). */
  bots: string[];
  /** Channels owned by any subject. */
  channels: string[];
  /** Broadcasts on those channels. */
  broadcasts: string[];
}

export interface ClearStep {
  /** Table name (for the report and ordering tests). */
  table: string;
  /** What this step removes. */
  what: string;
  target: PgTable;
  where(s: ClearScope): SQL | undefined;
}

/** `col in (ids)`, or `false` for an empty set. */
const any = (col: AnyPgColumn, ids: string[]): SQL => (ids.length ? inArray(col, ids) : sql`false`);

/**
 * Deletion order: children before parents. `demo-clear.test.ts` checks the RESTRICT pairs; the
 * cascading children not listed (panels, emotes, polls, …) go with their channel.
 */
export const CLEAR_STEPS: readonly ClearStep[] = [
  {
    table: "playback_sessions",
    what: "viewing sessions on demo channels or by demo users",
    target: playbackSessions,
    where: (s) =>
      or(
        any(playbackSessions.channelId, s.channels),
        any(playbackSessions.broadcastId, s.broadcasts),
        any(playbackSessions.userId, s.subjects),
      ),
  },
  {
    table: "stream_hours",
    what: "streaming hours of demo broadcasts",
    target: streamHours,
    where: (s) => or(any(streamHours.channelId, s.channels), any(streamHours.broadcastId, s.broadcasts)),
  },
  {
    table: "integrity_flags",
    what: "integrity flags on demo channels",
    target: integrityFlags,
    where: (s) => any(integrityFlags.channelId, s.channels),
  },
  {
    table: "reports",
    what: "reports on demo channels or filed by demo users",
    target: reports,
    where: (s) => or(any(reports.channelId, s.channels), any(reports.reporterId, s.subjects)),
  },
  {
    table: "mod_actions",
    what: "moderation history of demo channels",
    target: modActions,
    where: (s) => any(modActions.channelId, s.channels),
  },
  {
    table: "chat_messages",
    what: "chat in demo channels or by demo users",
    target: chatMessages,
    where: (s) => or(any(chatMessages.channelId, s.channels), any(chatMessages.userId, s.subjects)),
  },
  {
    table: "chat_bans",
    what: "bans and timeouts in demo channels or of demo users",
    target: chatBans,
    where: (s) => or(any(chatBans.channelId, s.channels), any(chatBans.userId, s.subjects)),
  },
  {
    table: "follows",
    what: "follows of or by demo users",
    target: follows,
    where: (s) => or(any(follows.channelId, s.channels), any(follows.followerId, s.subjects)),
  },
  {
    table: "channel_roles",
    what: "channel roles in demo channels or held by demo users",
    target: channelRoles,
    where: (s) => or(any(channelRoles.channelId, s.channels), any(channelRoles.userId, s.subjects)),
  },
  {
    table: "clips",
    what: "clips of demo channels",
    target: clips,
    where: (s) => any(clips.channelId, s.channels),
  },
  {
    table: "vods",
    what: "VODs of demo channels",
    target: vods,
    where: (s) => or(any(vods.channelId, s.channels), any(vods.broadcastId, s.broadcasts)),
  },
  {
    table: "broadcasts",
    what: "broadcasts of demo channels",
    target: broadcasts,
    where: (s) => any(broadcasts.channelId, s.channels),
  },
  {
    table: "stream_keys",
    what: "stream keys of demo channels",
    target: streamKeys,
    where: (s) => any(streamKeys.channelId, s.channels),
  },
  {
    table: "channels",
    what: "demo channels",
    target: channels,
    where: (s) => any(channels.id, s.channels),
  },
  {
    table: "sessions",
    what: "sign-in sessions of demo users",
    target: sessions,
    where: (s) => any(sessions.userId, s.subjects),
  },
  {
    table: "accounts",
    what: "credential accounts of demo users",
    target: accounts,
    where: (s) => any(accounts.userId, s.subjects),
  },
  {
    table: "oauth_tokens",
    what: "tokens of demo users and bots",
    target: oauthTokens,
    where: (s) => any(oauthTokens.userId, s.subjects),
  },
  {
    table: "notifications",
    what: "notifications of demo users",
    target: notifications,
    where: (s) => any(notifications.userId, s.subjects),
  },
  {
    table: "users (bots)",
    what: "bot accounts owned by demo users",
    target: users,
    where: (s) => and(any(users.id, s.bots), isNotNull(users.botOwnerId)),
  },
  {
    table: "users",
    what: "demo users",
    target: users,
    where: (s) => any(users.id, s.anchored),
  },
];

export interface ClearReport {
  /** Users matching both anchors when the clear started. */
  anchoredUsers: number;
  /** Rows per step, in deletion order. */
  steps: { table: string; what: string; rows: number }[];
}

/** Collect the anchored users, their bots, channels and broadcasts. */
export async function clearScope(tx: Executor): Promise<ClearScope> {
  const anchored = (await tx.select({ id: users.id }).from(users).where(anchoredUser())).map((r) => r.id);
  const ownedBots = anchored.length
    ? (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.botOwnerId, anchored), notInArray(users.id, anchored)))
      ).map((r) => r.id)
    : [];
  const subjects = [...anchored, ...ownedBots];
  const anchoredBots = anchored.length
    ? (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, anchored), isNotNull(users.botOwnerId)))
      ).map((r) => r.id)
    : [];
  const channelIds = subjects.length
    ? (await tx.select({ id: channels.id }).from(channels).where(inArray(channels.ownerId, subjects))).map((r) => r.id)
    : [];
  const broadcastIds = channelIds.length
    ? (await tx.select({ id: broadcasts.id }).from(broadcasts).where(inArray(broadcasts.channelId, channelIds))).map(
        (r) => r.id,
      )
    : [];
  return {
    anchored,
    subjects,
    bots: [...ownedBots, ...anchoredBots],
    channels: channelIds,
    broadcasts: broadcastIds,
  };
}

/**
 * Delete all demo rows with `tx` (callers own the transaction). Follows by demo users on real
 * channels are removed too, so those channels' follower counts are lowered to match.
 */
export async function clearDemoRows(tx: Executor): Promise<ClearReport> {
  const scope = await clearScope(tx);
  const steps: ClearReport["steps"] = [];
  for (const step of CLEAR_STEPS) {
    if (step.table === "follows") await fixFollowerCounts(tx, scope);
    const where = step.where(scope);
    const deleted = await tx
      .delete(step.target)
      .where(where)
      .returning({ one: sql<number>`1` });
    steps.push({ table: step.table, what: step.what, rows: deleted.length });
  }
  return { anchoredUsers: scope.anchored.length, steps };
}

async function fixFollowerCounts(tx: Executor, scope: ClearScope): Promise<void> {
  if (scope.subjects.length === 0) return;
  const counted = await tx
    .select({ channelId: follows.channelId, n: sql<number>`count(*)::int` })
    .from(follows)
    .where(
      and(
        inArray(follows.followerId, scope.subjects),
        scope.channels.length ? notInArray(follows.channelId, scope.channels) : undefined,
        isNull(follows.excludedAt),
      ),
    )
    .groupBy(follows.channelId);
  for (const { channelId, n } of counted)
    await tx
      .update(channels)
      .set({ followerCount: sql`greatest(0, ${channels.followerCount} - ${n})` })
      .where(eq(channels.id, channelId));
}

class DryRun extends Error {
  constructor(readonly report: ClearReport) {
    super("dry run");
  }
}

/**
 * Clear demo data in one transaction. Without `execute` the deletes run and are rolled back, so
 * the counts are exact (and a blocked delete shows up) while nothing changes.
 */
export async function clearDemo(db: Database, opts: { execute: boolean }): Promise<ClearReport> {
  try {
    return await db.transaction(async (tx) => {
      const report = await clearDemoRows(tx);
      if (!opts.execute) throw new DryRun(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRun) return err.report;
    throw err;
  }
}
