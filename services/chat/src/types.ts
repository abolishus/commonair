// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Internal domain types shared by the chat service modules. */
import type { ChannelChatSettings, NoticeCode } from "@commonair/contracts";
import type { ACCOUNT_TYPES, PLATFORM_ROLES, WORD_FILTER_ACTIONS } from "@commonair/contracts/enums";

export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** A user as the chat service needs them; refreshed from Postgres on a short TTL. */
export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  accountType: AccountType;
  /** Bot reviewed by platform staff: gets CHAT_LIMITS.botVerified across channels. */
  botVerified: boolean;
  platformRole: PlatformRole;
  emailVerified: boolean;
  createdAt: Date;
  /** Platform-wide suspension (better-auth admin `banned`). */
  banned: boolean;
  /** Null with `banned` = permanent. */
  banExpires: Date | null;
  deleted: boolean;
  /** Holds an active co-op membership (any class). */
  isMember: boolean;
}

export interface EmoteDef {
  id: string;
  code: string;
  /** 0 = everyone; 1–3 = subscriber tier required. */
  tier: number;
  channelId: string | null;
}

export interface WordFilterDef {
  id: string;
  pattern: string;
  isRegex: boolean;
  action: (typeof WORD_FILTER_ACTIONS)[number];
  replacement: string | null;
}

/** A channel as the chat service needs it; cached per instance, invalidated over BUS.chatControl. */
export interface ChannelState {
  id: string;
  slug: string;
  ownerId: string;
  displayName: string;
  settings: ChannelChatSettings;
  suspended: boolean;
  liveBroadcastId: string | null;
  /** The live broadcast's `started_at` (the clamp's lower bound); null when offline. */
  liveStartedAt: Date | null;
  /** Channel emotes override global emotes with the same code. */
  emotes: ReadonlyMap<string, EmoteDef>;
  filters: readonly WordFilterDef[];
}

/** One user's standing in one channel. */
export interface Standing {
  isBroadcaster: boolean;
  isModerator: boolean;
  isVip: boolean;
  followedAt: Date | null;
  /** Active subscription tier, or null. */
  subscriberTier: number | null;
  /** Active ban or timeout; `expiresAt` null = permanent. */
  ban: { expiresAt: Date | null; reason: string } | null;
  /** Set by core for the send path only; null when no gate applies (and on joins). */
  verifiedWatch: WatchGateState | null;
}

/** What the verified-watch gate needs for one sender (ADR 0015), loaded by `WatchGate.load`. */
export interface WatchGateState {
  /** Seconds required now: max(minVerifiedWatchSeconds, 60 while surge mode is on); 0 = no gate applies. */
  requiredSeconds: number;
  /** `KEYS.verifiedWatch` for the channel's live broadcast; null when absent or for another broadcast. */
  verified: { broadcastId: string; seconds: number; fallback: boolean } | null;
  /** Surge mode only: the sender had a non-deleted message in the channel before the surge began. */
  surgeExempt: boolean;
  /** `integrity.thresholds.gateFallbackAccountAgeDays`: the account age a `fallback` (privacy-relay) viewer also needs (decision 5). */
  fallbackAccountAgeDays: number;
  /** Valkey could not be read: fail open (decision 1). */
  unavailable: boolean;
}

export const NO_STANDING: Standing = {
  isBroadcaster: false,
  isModerator: false,
  isVip: false,
  followedAt: null,
  subscriberTier: null,
  ban: null,
  verifiedWatch: null,
};

/** Who is on the other end of a socket. */
export interface Identity {
  userId: string | null;
  scopes: readonly string[];
  /** OAuth app the connection acts for (bots, the IRC gateway's clients). */
  appId: string | null;
  via: "token" | "oauth" | "anonymous";
  /** When the credential stops being valid (epoch ms); the socket is closed then. */
  expiresAt: number | null;
  /** SHA-256 of the OAuth access token, for revocation checks and targeted disconnects. */
  tokenHash: string | null;
}

export interface Rejection {
  code: NoticeCode;
  text: string;
}
