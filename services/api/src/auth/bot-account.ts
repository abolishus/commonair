// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bot accounts (`users.account_type = 'bot'`, always attributed to a human owner). `me.bots.create`
 * and the channel bot (E8-bot-api) insert them the same way; the callers check ownership and
 * limits and map the unique violation on the username.
 */
import { schema, uuidv7, type Executor } from "@commonair/db";

const { users } = schema;

export type UserRow = typeof users.$inferSelect;

/** Bots never sign in with email; this reserved, undeliverable domain keeps the column unique. */
export const BOT_EMAIL_DOMAIN = "bots.invalid";

/** Insert a bot owned by `ownerId`. Throws the database's unique violation when the username is taken. */
export async function insertBotAccount(
  tx: Executor,
  p: { ownerId: string; username: string; displayName: string },
): Promise<UserRow> {
  const id = uuidv7();
  const [bot] = await tx
    .insert(users)
    .values({
      id,
      name: p.displayName.trim() || p.username,
      username: p.username,
      displayUsername: p.username,
      email: `bot+${id}@${BOT_EMAIL_DOMAIN}`,
      emailVerified: false,
      accountType: "bot",
      botOwnerId: p.ownerId,
    })
    .returning();
  if (!bot) throw new Error("bot insert returned no row");
  return bot;
}
