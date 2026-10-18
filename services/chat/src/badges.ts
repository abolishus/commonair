// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Chat badges and name colors. Colors are design-token names, never hex, so contrast stays AA. */
import type { dto } from "@commonair/contracts";
import type { Standing, UserProfile } from "./types.ts";

export type Badge = dto.ChatMessage["user"]["badges"][number];

export const CHAT_COLOR_COUNT = 12;

export function badgesFor(user: UserProfile, standing: Standing): Badge[] {
  const out: Badge[] = [];
  if (user.platformRole === "admin") out.push({ type: "staff" });
  if (standing.isBroadcaster) out.push({ type: "broadcaster" });
  else if (standing.isModerator) out.push({ type: "moderator" });
  if (standing.isVip && !standing.isBroadcaster) out.push({ type: "vip" });
  if (standing.subscriberTier !== null) out.push({ type: "subscriber", tier: standing.subscriberTier });
  if (user.isMember) out.push({ type: "member" });
  if (user.accountType === "bot") out.push({ type: "bot" });
  return out;
}

/** FNV-1a (32-bit): stable across instances and restarts, cheap, well distributed for UUIDs. */
export function fnv1a(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** "chat-1" … "chat-12", stable per user. */
export const colorFor = (userId: string): string => `chat-${(fnv1a(userId) % CHAT_COLOR_COUNT) + 1}`;
