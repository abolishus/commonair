// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * OAuth scopes for apps and bots. Names follow `resource:action` like Twitch's,
 * so existing bots map over with a lookup table (see TWITCH_SCOPE_MAP).
 */
export const SCOPES = {
  "chat:read": "Read chat messages in channels the user can see",
  "chat:edit": "Send chat messages as the user",
  "moderator:manage:chat": "Delete messages, ban and time out users, change chat modes, in channels the user moderates",
  "channel:manage": "Update channel title, category, tags, panels, and settings",
  "channel:read:subscriptions": "Read the channel's subscribers",
  "channel:read:tips": "Read tips received by the channel",
  "channel:manage:polls": "Create and end polls",
  "channel:manage:predictions": "Create, lock, resolve and cancel predictions",
  "channel:manage:raids": "Start and cancel raids",
  "channel:manage:bot": "Manage the built-in channel bot (commands, timers, variables, filters)",
  "channel:read:points": "Read loyalty point balances",
  "channel:manage:points": "Grant or deduct loyalty points",
  "user:read:email": "Read the user's email address",
  "user:read:follows": "Read the channels the user follows",
  "user:manage:follows": "Follow and unfollow channels",
  "clips:edit": "Create clips",
} as const;

export type Scope = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as [Scope, ...Scope[]];

/** Twitch scope → CommonAir scope, used by the IRC gateway and migration docs. */
export const TWITCH_SCOPE_MAP: Record<string, Scope> = {
  "chat:read": "chat:read",
  "chat:edit": "chat:edit",
  "moderator:manage:chat_messages": "moderator:manage:chat",
  "moderator:manage:banned_users": "moderator:manage:chat",
  "moderator:manage:chat_settings": "moderator:manage:chat",
  "channel:moderate": "moderator:manage:chat",
  "channel:manage:broadcast": "channel:manage",
  "channel:read:subscriptions": "channel:read:subscriptions",
  "channel:manage:polls": "channel:manage:polls",
  "channel:manage:predictions": "channel:manage:predictions",
  "channel:manage:raids": "channel:manage:raids",
  "user:read:email": "user:read:email",
  "user:read:follows": "user:read:follows",
  "clips:edit": "clips:edit",
};
