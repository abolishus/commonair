// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Command user levels: `everyone < follower < subscriber < vip < moderator < broadcaster`. */
import { USER_LEVELS } from "@commonair/contracts/enums";
import type { Standing } from "../../types.ts";

export type UserLevel = (typeof USER_LEVELS)[number];

const RANK: ReadonlyMap<UserLevel, number> = new Map(USER_LEVELS.map((level, i) => [level, i]));

/** The highest level a standing reaches; each level includes every level below it. */
export function levelOf(s: Standing): UserLevel {
  if (s.isBroadcaster) return "broadcaster";
  if (s.isModerator) return "moderator";
  if (s.isVip) return "vip";
  if (s.subscriberTier !== null) return "subscriber";
  if (s.followedAt !== null) return "follower";
  return "everyone";
}

export const rankOfLevel = (level: UserLevel): number => RANK.get(level) ?? 0;

export const meetsLevel = (s: Standing, required: UserLevel): boolean =>
  rankOfLevel(levelOf(s)) >= rankOfLevel(required);

/** The broadcaster and moderators skip command cooldowns. */
export const bypassesCooldown = (s: Standing): boolean => s.isBroadcaster || s.isModerator;

/** The broadcaster, moderators and VIPs are never filtered. */
export const exemptFromFilters = (s: Standing): boolean => s.isBroadcaster || s.isModerator || s.isVip;
