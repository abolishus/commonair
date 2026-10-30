// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Reading and writing `notification_preferences` for one member (ADR 0028 decision 4). */
import { and, eq, isNull } from "drizzle-orm";
import type { NotifyMedium } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";
import { type FollowedChannel, type PreferenceType, type ResolvedPreferences, resolvePreferences } from "./resolve.ts";

const { channels, follows, notificationPreferences: prefs, users } = schema;

/** The member's resolved preferences for `type`. */
export async function loadPreferences(
  db: Executor,
  userId: string,
  type: PreferenceType,
): Promise<ResolvedPreferences> {
  const [defaults, overrides, user] = await Promise.all([
    db
      .select({ medium: prefs.medium, enabled: prefs.enabled })
      .from(prefs)
      .where(and(eq(prefs.userId, userId), eq(prefs.type, type), isNull(prefs.channelId))),
    // Only channels the member still follows: an unfollow keeps the row (a re-follow restores
    // it) but hides it.
    db
      .select({
        channelId: prefs.channelId,
        medium: prefs.medium,
        enabled: prefs.enabled,
        slug: channels.slug,
        displayName: channels.displayName,
      })
      .from(prefs)
      .innerJoin(channels, eq(channels.id, prefs.channelId))
      .innerJoin(follows, and(eq(follows.channelId, prefs.channelId), eq(follows.followerId, userId)))
      .where(and(eq(prefs.userId, userId), eq(prefs.type, type))),
    db.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  const followed = new Map<string, FollowedChannel>();
  const rows: { channelId: string | null; medium: NotifyMedium; enabled: boolean }[] = defaults.map((d) => ({
    channelId: null,
    medium: d.medium,
    enabled: d.enabled,
  }));
  for (const o of overrides) {
    // The inner join on channels guarantees a channel id.
    if (o.channelId === null) continue;
    followed.set(o.channelId, { id: o.channelId, slug: o.slug, displayName: o.displayName });
    rows.push({ channelId: o.channelId, medium: o.medium, enabled: o.enabled });
  }
  return resolvePreferences({ type, rows, followed, emailVerified: user[0]?.emailVerified ?? false });
}

export interface PreferenceKey {
  userId: string;
  type: PreferenceType;
  medium: NotifyMedium;
  /** null: the member's default. */
  channelId: string | null;
}

/** Upsert one row on `notification_prefs_uq` (nulls not distinct, so a default has one row too). */
export async function upsertPreference(db: Executor, key: PreferenceKey, enabled: boolean, now: Date): Promise<void> {
  await db
    .insert(prefs)
    .values({ ...key, enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: [prefs.userId, prefs.type, prefs.medium, prefs.channelId],
      set: { enabled, updatedAt: now },
    });
}

/** Remove a channel override (the member's default applies again). */
export async function deleteOverride(db: Executor, key: PreferenceKey & { channelId: string }): Promise<void> {
  await db
    .delete(prefs)
    .where(
      and(
        eq(prefs.userId, key.userId),
        eq(prefs.type, key.type),
        eq(prefs.medium, key.medium),
        eq(prefs.channelId, key.channelId),
      ),
    );
}
