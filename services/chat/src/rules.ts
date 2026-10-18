// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure send-gate rules, evaluated in the order the protocol documents. Each returns the
 * first rejection or null. Stateful rules (slow mode, rate limit, duplicates) live in
 * `limiter.ts`; content rules (links, word filters) in `content.ts`.
 */
import { CHAT_LIMITS } from "@commonair/contracts";
import type { ChannelState, Rejection, Standing, UserProfile } from "./types.ts";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface GateInput {
  user: UserProfile | null;
  scopes: readonly string[];
  channel: ChannelState;
  standing: Standing;
  /** The message consists only of emotes the user may use. */
  emoteOnly: boolean;
  now: Date;
}

/** Broadcaster and channel moderators bypass channel chat modes. */
export const isPrivileged = (s: Standing): boolean => s.isBroadcaster || s.isModerator;

export function platformBanActive(user: UserProfile, now: Date): boolean {
  if (user.deleted) return true;
  return user.banned && (user.banExpires === null || user.banExpires.getTime() > now.getTime());
}

/** Active channel ban/timeout: "banned" (permanent), "timedout", or null. */
export function channelBanState(standing: Standing, now: Date): "banned" | "timedout" | null {
  const ban = standing.ban;
  if (!ban) return null;
  if (ban.expiresAt === null) return "banned";
  return ban.expiresAt.getTime() > now.getTime() ? "timedout" : null;
}

export function checkGates(i: GateInput): Rejection | null {
  const { user, channel, standing, now } = i;
  const s = channel.settings;
  if (!user || !i.scopes.includes("chat:edit"))
    return { code: "msg_requires_login", text: "You must be logged in to chat." };
  if (platformBanActive(user, now)) return { code: "msg_banned", text: "Your account is suspended." };
  if (channel.suspended) return { code: "msg_channel_suspended", text: "This channel is suspended." };
  const ban = channelBanState(standing, now);
  if (ban === "banned") return { code: "msg_banned", text: "You are banned from talking in this channel." };
  if (ban === "timedout") {
    const secs = Math.ceil(((standing.ban?.expiresAt?.getTime() ?? 0) - now.getTime()) / 1000);
    return { code: "msg_timedout", text: `You are timed out for ${secs} more seconds.` };
  }
  const privileged = isPrivileged(standing);
  // Bot accounts are vouched for by their (verified) human owner.
  if (s.requireVerifiedEmail && !user.emailVerified && !privileged && user.accountType !== "bot")
    return { code: "msg_verified_email", text: "Verify your email address to chat in this channel." };
  if (s.minAccountAgeDays > 0 && !privileged && now.getTime() - user.createdAt.getTime() < s.minAccountAgeDays * DAY_MS)
    return {
      code: "msg_account_too_new",
      text: `Your account must be at least ${s.minAccountAgeDays} days old to chat here.`,
    };
  if (s.followersOnlyMinutes !== null && !privileged && !standing.isVip) {
    const followed = standing.followedAt;
    if (!followed || now.getTime() - followed.getTime() < s.followersOnlyMinutes * MINUTE_MS)
      return {
        code: "msg_followersonly",
        text:
          s.followersOnlyMinutes === 0
            ? "This room is in followers-only mode."
            : `This room is in ${s.followersOnlyMinutes}-minute followers-only mode.`,
      };
  }
  if (s.subscribersOnly && !privileged && !standing.isVip && standing.subscriberTier === null)
    return { code: "msg_subsonly", text: "This room is in subscribers-only mode." };
  if (s.emoteOnly && !privileged && !i.emoteOnly)
    return { code: "msg_emoteonly", text: "This room is in emote-only mode." };
  return null;
}

/** Slow mode applies to everyone below VIP. */
export const slowModeApplies = (channel: ChannelState, standing: Standing): boolean =>
  channel.settings.slowModeSeconds > 0 && !isPrivileged(standing) && !standing.isVip;

/** Rate-limit bucket key for "across channels" limits (verified bots). */
export const ALL_CHANNELS = "*";

/**
 * Messages allowed per CHAT_LIMITS.windowMs and the bucket they count against: per channel for
 * everyone, except verified bots, whose (much higher) limit is shared across all channels.
 */
export function rateLimitFor(
  user: UserProfile,
  standing: Standing,
  channelId: string,
): { limit: number; bucket: string } {
  if (user.accountType === "bot" && user.botVerified) return { limit: CHAT_LIMITS.botVerified, bucket: ALL_CHANNELS };
  const base = isPrivileged(standing) ? CHAT_LIMITS.moderator : CHAT_LIMITS.user;
  return { limit: user.accountType === "bot" ? Math.max(base, CHAT_LIMITS.bot) : base, bucket: channelId };
}

/** A user's messages across all channels may not exceed this multiple of their per-channel limit. */
export const GLOBAL_RATE_MULTIPLIER = 3;

/** Cross-channel cap per user, or null when the per-channel limit is already global (verified bots). */
export function globalRateLimitFor(user: UserProfile, standing: Standing): number | null {
  const rate = rateLimitFor(user, standing, "");
  return rate.bucket === ALL_CHANNELS ? null : rate.limit * GLOBAL_RATE_MULTIPLIER;
}

/** Whether the socket may send at all in this channel (the `joined.me.canChat` hint). */
export function canChatHint(
  user: UserProfile | null,
  scopes: readonly string[],
  channel: ChannelState,
  standing: Standing,
  now: Date,
): boolean {
  if (!user || !scopes.includes("chat:edit")) return false;
  if (platformBanActive(user, now) || channel.suspended) return false;
  return channelBanState(standing, now) === null;
}
