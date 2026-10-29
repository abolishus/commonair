// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Raid rules shared by the API (`interact.raids.*`) and the worker (`raids-execute`), ADR 0026
 * decision 4: who may raid whom, the cooldown, the re-checks at execute, the verified viewer count
 * a raid carries, and the payload and frame builders. Owned by E8-raids-goals.
 */
import { sql, type SQL } from "drizzle-orm";
import type { ChatControlMessage } from "@commonair/contracts/chat";
import { RAID_RULES, type RAID_CANCEL_REASONS, type RAID_POLICIES } from "@commonair/contracts/enums";
import type { EventPayload } from "@commonair/contracts/events";
import { GATE_ELIGIBLE, raidIntegrity } from "@commonair/integrity";

export type RaidPolicy = (typeof RAID_POLICIES)[number];
export type RaidCancelReason = (typeof RAID_CANCEL_REASONS)[number];

/** `PRECONDITION_FAILED` requirement codes of `interact.raids.start` (the studio shows them as `data-code`). */
export const RAID_REFUSALS = {
  sourceOffline: "raid_source_offline",
  targetOffline: "raid_target_offline",
  suspended: "raid_suspended",
  refused: "raid_refused",
  cooldown: "raid_cooldown",
} as const;
export type RaidRefusal = (typeof RAID_REFUSALS)[keyof typeof RAID_REFUSALS];

/** A playback session counts toward a raid while its last heartbeat is this recent. */
export const RAID_HEARTBEAT_WINDOW_MS = 60_000;

/** The channel facts the raid rules look at. */
export interface RaidSide {
  liveBroadcastId: string | null;
  suspendedAt: Date | null;
}

/** Does the target's policy accept a raid from a source its owner does (or does not) follow? */
export function raidPolicyAllows(policy: RaidPolicy, targetOwnerFollowsSource: boolean): boolean {
  if (policy === "off") return false;
  if (policy === "followed") return targetOwnerFollowsSource;
  return true;
}

/** When the next raid may start, or null when the source is not cooling down at `now`. */
export function raidCooldownEndsAt(lastEndedAt: Date | null, now: Date): Date | null {
  if (!lastEndedAt) return null;
  const ends = new Date(lastEndedAt.getTime() + RAID_RULES.cooldownSeconds * 1000);
  return ends.getTime() > now.getTime() ? ends : null;
}

/**
 * Why `start` refuses, in the contract's order (offline before suspended before the policy before
 * the cooldown), or null when it may go ahead. Self-raids, a missing target and a pending raid are
 * the caller's (different error codes).
 */
export function raidStartRefusal(p: {
  source: RaidSide;
  target: RaidSide & { raidPolicy: RaidPolicy };
  targetOwnerFollowsSource: boolean;
  lastEndedAt: Date | null;
  now: Date;
}): { code: RaidRefusal; cooldownEndsAt?: Date } | null {
  if (!p.source.liveBroadcastId) return { code: RAID_REFUSALS.sourceOffline };
  if (!p.target.liveBroadcastId) return { code: RAID_REFUSALS.targetOffline };
  if (p.source.suspendedAt || p.target.suspendedAt) return { code: RAID_REFUSALS.suspended };
  if (!raidPolicyAllows(p.target.raidPolicy, p.targetOwnerFollowsSource)) return { code: RAID_REFUSALS.refused };
  const until = raidCooldownEndsAt(p.lastEndedAt, p.now);
  if (until) return { code: RAID_REFUSALS.cooldown, cooldownEndsAt: until };
  return null;
}

/** Seconds left on a cooldown, rounded up (never 0 while it runs). */
export const cooldownSecondsLeft = (until: Date, now: Date) =>
  Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));

/**
 * Re-check at execute (ADR 0026: either side or the target's setting can change during the
 * countdown). Null means execute. Suspension first, then the source, then the target.
 */
export function raidExecuteCancelReason(p: {
  source: RaidSide;
  target: RaidSide & { raidPolicy: RaidPolicy };
  targetOwnerFollowsSource: boolean;
}): RaidCancelReason | null {
  if (p.source.suspendedAt || p.target.suspendedAt) return "suspended";
  if (!p.source.liveBroadcastId) return "source_offline";
  if (!p.target.liveBroadcastId) return "target_offline";
  if (!raidPolicyAllows(p.target.raidPolicy, p.targetOwnerFollowsSource)) return "target_refused";
  return null;
}

/** postgres.js cannot bind a Date inside a raw `sql` fragment: ISO text with a cast. */
const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/**
 * The source's audience at `now`: `live` open sessions with a recent heartbeat, and `verified`
 * distinct viewers (account, else device) among them that are gate-eligible (`GATE_ELIGIBLE`).
 * Columns `live` and `verified` (int).
 */
export function raidViewersQuery(channelId: string, now: Date): SQL {
  const since = new Date(now.getTime() - RAID_HEARTBEAT_WINDOW_MS);
  return sql`
    select count(*)::int as live,
           (count(distinct coalesce(ps.user_id::text, 'device:' || ps.device_hash)) filter (where ${GATE_ELIGIBLE}))::int as verified
      from playback_sessions ps
     where ps.channel_id = ${channelId}
       and ps.ended_at is null
       and ps.last_heartbeat_at > ${tsz(since)}`;
}

/** The count a raid carries: never more than the verified viewers (`raidIntegrity`), never a raw count. */
export const raidViewerCount = (live: number, verified: number) => raidIntegrity(live, verified).allowedViewers;

export interface RaidChannel {
  id: string;
  ownerId: string;
  slug: string;
  displayName: string;
}

/** `channel.raid` (outbox `channelId` = the target). */
export const raidEventPayload = (
  from: RaidChannel,
  to: RaidChannel,
  viewers: number,
): EventPayload<"channel.raid"> => ({
  from_broadcaster_user_id: from.ownerId,
  from_broadcaster_user_login: from.slug,
  from_broadcaster_user_name: from.displayName,
  to_broadcaster_user_id: to.ownerId,
  to_broadcaster_user_login: to.slug,
  to_broadcaster_user_name: to.displayName,
  viewers,
});

/** The `raid` control frame for the source's room (`BUS.chatControl(<source id>)`). */
export const raidFrame = (
  raid: { id: string; status: "pending" | "completed" | "canceled"; executeAt: Date },
  from: Pick<RaidChannel, "slug">,
  to: Pick<RaidChannel, "slug" | "displayName">,
): ChatControlMessage => ({
  op: "raid",
  channel: from.slug,
  raidId: raid.id,
  status: raid.status,
  to: to.slug,
  toDisplayName: to.displayName,
  executeAt: raid.executeAt.toISOString(),
});

export interface RaidRowLike {
  id: string;
  viewerCount: number;
  status: "pending" | "completed" | "canceled";
  cancelReason: RaidCancelReason | null;
  createdAt: Date;
  executeAt: Date;
}

/** `RaidView` DTO. */
export const toRaidView = (
  r: RaidRowLike,
  from: Pick<RaidChannel, "slug">,
  to: Pick<RaidChannel, "slug" | "displayName">,
) => ({
  id: r.id,
  from: from.slug,
  to: to.slug,
  toDisplayName: to.displayName,
  viewerCount: r.viewerCount,
  status: r.status,
  cancelReason: r.cancelReason,
  createdAt: r.createdAt.toISOString(),
  executeAt: r.executeAt.toISOString(),
});
