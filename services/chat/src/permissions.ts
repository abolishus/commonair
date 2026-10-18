// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who may moderate whom, per channel. Moderators act on VIPs and regular users only; the
 * broadcaster acts on everyone but themselves; role changes are the broadcaster's alone.
 */
import type { Command } from "./commands.ts";
import type { Standing } from "./types.ts";

export type ChannelRank = "broadcaster" | "moderator" | "vip" | "user";

export function rankOf(s: Standing): ChannelRank {
  if (s.isBroadcaster) return "broadcaster";
  if (s.isModerator) return "moderator";
  if (s.isVip) return "vip";
  return "user";
}

export const canModerate = (actor: ChannelRank): boolean => actor === "broadcaster" || actor === "moderator";

/** Whether `actor` may ban, time out or delete messages of `target`. */
export function canActOn(actor: ChannelRank, target: ChannelRank): boolean {
  if (actor === "broadcaster") return target !== "broadcaster";
  if (actor === "moderator") return target === "vip" || target === "user";
  return false;
}

export const canManageRoles = (actor: ChannelRank): boolean => actor === "broadcaster";

/** Commands that need a moderator (or the broadcaster); `me` needs only chat rights. */
export function requiredRank(kind: Command["kind"]): "chat" | "moderator" | "broadcaster" {
  switch (kind) {
    case "me":
      return "chat";
    case "mod":
    case "unmod":
    case "vip":
    case "unvip":
      return "broadcaster";
    default:
      return "moderator";
  }
}
