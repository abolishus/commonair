// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.moderates` (overhaul wave 3, ux-journeys J5-a): the channels a member can open the mod view
 * of, so a moderator never has to type `/mod/<channel>`. A role is a `channel_roles` row, so a
 * revoked role (its row deleted) is gone at once. Never the caller's own channel (the studio links
 * that already), never a suspended channel. Live channels first, then by name.
 */
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { ModeratedChannel } from "@commonair/contracts/dto";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { channelAvatar, channelTheme } from "../lib/dto.ts";

const { channelRoles, channels, users } = schema;

/** The roles that open the mod view; a VIP does not. */
export const MOD_VIEW_ROLES = ["moderator", "editor"] as const;
export type ModViewRole = (typeof MOD_VIEW_ROLES)[number];

/** An editor can do everything a moderator can and more, so one row per channel says editor. */
export function strongerRole(a: ModViewRole, b: ModViewRole): ModViewRole {
  return a === "editor" || b === "editor" ? "editor" : "moderator";
}

/** Live first, then by display name (case-insensitive), then slug, so the order is stable. */
export function compareModerated(a: ModeratedChannel, b: ModeratedChannel): number {
  if (a.live !== b.live) return a.live ? -1 : 1;
  const byName = a.channel.displayName.localeCompare(b.channel.displayName, "en", { sensitivity: "base" });
  return byName !== 0 ? byName : a.channel.slug.localeCompare(b.channel.slug);
}

const isModViewRole = (role: string): role is ModViewRole => role === "moderator" || role === "editor";

export async function listModerated(deps: Deps, userId: string): Promise<ModeratedChannel[]> {
  const rows = await deps.db
    .select({ role: channelRoles.role, c: channels, ownerImage: users.image })
    .from(channelRoles)
    .innerJoin(channels, eq(channels.id, channelRoles.channelId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .where(
      and(
        eq(channelRoles.userId, userId),
        inArray(channelRoles.role, [...MOD_VIEW_ROLES]),
        ne(channels.ownerId, userId),
        isNull(channels.suspendedAt),
      ),
    )
    .orderBy(asc(channels.id));
  const byChannel = new Map<string, ModeratedChannel>();
  for (const r of rows) {
    if (!isModViewRole(r.role)) continue;
    const seen = byChannel.get(r.c.id);
    if (seen) {
      seen.role = strongerRole(seen.role, r.role);
      continue;
    }
    byChannel.set(r.c.id, {
      channel: {
        id: r.c.id,
        slug: r.c.slug,
        displayName: r.c.displayName,
        avatarUrl: channelAvatar(deps, r.c, r.ownerImage),
        accent: channelTheme(r.c).accent,
      },
      role: r.role,
      live: r.c.liveBroadcastId !== null,
    });
  }
  return [...byChannel.values()].sort(compareModerated);
}
