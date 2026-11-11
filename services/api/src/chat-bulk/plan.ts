// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who `chat.bans.bulk` times out (J5-d). Pure, so every skip rule is unit-tested; the route loads
 * the facts and applies the plan in one transaction.
 *
 * Message ids that are unknown are ignored (a message chat has not flushed yet, or one already
 * hard-deleted). A message from another channel never makes its sender a target: the sender is
 * skipped as `not_in_channel` unless they also wrote one of the wave's messages in this channel.
 */
import type { BULK_TIMEOUT_SKIPS } from "@commonair/contracts/enums";

export type BulkSkipReason = (typeof BULK_TIMEOUT_SKIPS)[number];

export interface WaveMessage {
  id: string;
  userId: string;
  channelId: string;
  deleted: boolean;
}

export interface BulkFacts {
  channelId: string;
  ownerId: string;
  callerId: string;
  /** The wave's messages that exist, in the order the caller sent their ids. */
  messages: readonly WaveMessage[];
  /** Senders whose platform role is staff (moderator, admin, legal, treasurer). */
  staff: ReadonlySet<string>;
  /** Senders holding the moderator or editor role on this channel. */
  channelMods: ReadonlySet<string>;
  /** Each sender's active ban or timeout in this channel: its end, or null for a permanent ban. */
  activeBans: ReadonlyMap<string, Date | null>;
  /** When the new timeout would end. */
  expiresAt: Date;
}

export interface BulkPlan {
  /** Senders to time out, in first-seen order. */
  targets: string[];
  skipped: { userId: string; reason: BulkSkipReason }[];
  /**
   * The wave's undeleted messages in this channel that "Delete all" removes: never one by the
   * owner, staff or a channel moderator (the single delete refuses those too).
   */
  deletable: string[];
}

/** Skips that also keep the sender's messages: people a moderator may not act on. */
const PROTECTED: ReadonlySet<BulkSkipReason> = new Set(["owner", "staff", "moderator"]);

/** The senders a bulk timeout reaches, why the others are left out, and what it may delete. */
export function planBulkTimeout(f: BulkFacts): BulkPlan {
  const inChannel = f.messages.filter((m) => m.channelId === f.channelId);
  const local = new Set(inChannel.map((m) => m.userId));
  const seen = new Set<string>();
  const targets: string[] = [];
  const skipped: BulkPlan["skipped"] = [];
  for (const m of f.messages) {
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    const reason = skipReason(f, m.userId, local.has(m.userId));
    if (reason) skipped.push({ userId: m.userId, reason });
    else targets.push(m.userId);
  }
  const protectedIds = new Set(skipped.filter((s) => PROTECTED.has(s.reason)).map((s) => s.userId));
  const deletable = [...new Set(inChannel.filter((m) => !m.deleted && !protectedIds.has(m.userId)).map((m) => m.id))];
  return { targets, skipped, deletable };
}

function skipReason(f: BulkFacts, userId: string, local: boolean): BulkSkipReason | null {
  if (!local) return "not_in_channel";
  if (userId === f.ownerId) return "owner";
  if (f.staff.has(userId)) return "staff";
  // The caller is the owner, a channel moderator or staff; their own message is never a target.
  if (userId === f.callerId || f.channelMods.has(userId)) return "moderator";
  if (f.activeBans.has(userId)) {
    const until = f.activeBans.get(userId) ?? null;
    // Never shorten a ban or a longer timeout: the bulk action only ever adds time.
    if (until === null || until.getTime() >= f.expiresAt.getTime()) return "already_banned";
  }
  return null;
}
