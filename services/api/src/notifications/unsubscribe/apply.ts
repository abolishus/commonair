// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Applying an email unsubscribe link (ADR 0028 decision 4; RFC 8058). Shared by the one-click raw
 * route (`email-unsubscribe.ts`) and the web confirm page's `notifications.unsubscribe`. The token
 * is the only authority: no session is read. No audit row: it is a member's own preference.
 */
import { UNSUBSCRIBE_LISTS, type NOTIFICATION_TYPES } from "@commonair/contracts/enums";
import { schema, uuidv7, type Database } from "@commonair/db";
import { verifyUnsubscribeToken } from "@commonair/tokens";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

export type UnsubscribeList = (typeof UNSUBSCRIBE_LISTS)[number];
type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The notification types whose email each list turns off. */
export const UNSUBSCRIBE_LIST_TYPES: Readonly<Record<UnsubscribeList, readonly NotificationType[]>> = {
  go_live: ["go_live"],
  governance: ["proposal", "vote_open"],
};

/** Longest token accepted (the contract's input bound); real tokens are about 70 characters. */
export const MAX_UNSUBSCRIBE_TOKEN_LENGTH = 200;

export const isUnsubscribeList = (value: unknown): value is UnsubscribeList =>
  typeof value === "string" && (UNSUBSCRIBE_LISTS as readonly string[]).includes(value);

const np = schema.notificationPreferences;

/**
 * Verify `token` for `list` and turn that list's email off for its member: the member's default
 * row per type is upserted to `enabled = false`, and every email channel override of those types
 * is switched off too (an override left on would keep mailing after a one-click unsubscribe, which
 * RFC 8058 forbids). Idempotent. Returns the member's id, or null for a malformed, foreign-list or
 * forged token, or one whose member no longer exists. A deleted (pseudonymized) member's token
 * succeeds without writing: nothing is mailed to them anyway.
 */
export async function applyUnsubscribe(
  db: Database,
  authSecret: string,
  list: UnsubscribeList,
  token: string,
): Promise<string | null> {
  if (token.length === 0 || token.length > MAX_UNSUBSCRIBE_TOKEN_LENGTH) return null;
  const userId = await verifyUnsubscribeToken(authSecret, token, list);
  if (userId === null) return null;
  const [user] = await db
    .select({ deletedAt: schema.users.deletedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user) return null;
  if (user.deletedAt !== null) return userId;
  const types = UNSUBSCRIBE_LIST_TYPES[list];
  await db.transaction(async (tx) => {
    for (const type of types) {
      // `notification_prefs_uq` treats the null channel as equal, so this targets the one default row.
      await tx.execute(sql`
        insert into ${np} (id, user_id, type, channel_id, medium, enabled)
        values (${uuidv7()}, ${userId}, ${type}, null, 'email', false)
        on conflict on constraint notification_prefs_uq
        do update set enabled = false, updated_at = now()`);
    }
    await tx
      .update(np)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(
        and(
          eq(np.userId, userId),
          inArray(np.type, [...types]),
          eq(np.medium, "email"),
          isNotNull(np.channelId),
          eq(np.enabled, true),
        ),
      );
  });
  return userId;
}
