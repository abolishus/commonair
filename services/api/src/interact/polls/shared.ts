// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checks polls and predictions share: who may run them (the procedures addressed by a poll or
 * prediction id resolve the channel here, `lib/access.ts`), who may take part (not banned or timed
 * out in the channel), and whether the channel's points are on.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { BotConfig } from "@commonair/contracts/shapes";
import { schema, type Executor } from "@commonair/db";
import { channelAuthority, type Caller } from "../../lib/access.ts";
import { forbidden, notFound } from "../../lib/errors.ts";
import { isActiveBan } from "../../moderation/chat-bans.ts";

export type ChannelRow = typeof schema.channels.$inferSelect;
export type Authority = "owner" | "editor" | "moderator";

export async function channelById(db: Executor, channelId: string): Promise<ChannelRow> {
  const [c] = await db.select().from(schema.channels).where(eq(schema.channels.id, channelId));
  if (!c) throw notFound("Channel not found");
  return c;
}

export async function channelBySlug(db: Executor, slug: string): Promise<ChannelRow> {
  const [c] = await db.select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw notFound("Channel not found");
  return c;
}

/** The caller's authority on the channel: owner, editor or moderator; null for anyone else. */
export async function authorityOn(db: Executor, caller: Caller, channel: ChannelRow): Promise<Authority | null> {
  const roles = await db
    .select({ role: schema.channelRoles.role })
    .from(schema.channelRoles)
    .where(and(eq(schema.channelRoles.channelId, channel.id), eq(schema.channelRoles.userId, caller.user.id)));
  return channelAuthority(
    caller,
    channel,
    roles.map((r) => r.role),
  );
}

/** For the moderator procedures addressed by id: owner, editors and moderators only. */
export async function requireAuthority(db: Executor, caller: Caller, channel: ChannelRow): Promise<Authority> {
  const a = await authorityOn(db, caller, channel);
  if (a === null) throw forbidden("Moderators only");
  return a;
}

/** The audit actor type for a channel action. */
export const actorTypeOf = (a: Authority): "user" | "moderator" => (a === "owner" ? "user" : "moderator");

/** Voting and betting are refused while the caller is banned or timed out in the channel. */
export async function assertNotBanned(tx: Executor, channelId: string, userId: string, now: Date): Promise<void> {
  const bans = await tx
    .select()
    .from(schema.chatBans)
    .where(
      and(
        eq(schema.chatBans.channelId, channelId),
        eq(schema.chatBans.userId, userId),
        isNull(schema.chatBans.liftedAt),
      ),
    );
  if (bans.some((b) => isActiveBan(b, now))) throw forbidden("You are banned or timed out in this channel");
}

/** `bot_configs.config.loyalty.enabled`; on by default (no row, or a config without `loyalty`). */
export async function channelPointsEnabled(tx: Executor, channelId: string): Promise<boolean> {
  const [row] = await tx
    .select({ config: schema.botConfigs.config })
    .from(schema.botConfigs)
    .where(eq(schema.botConfigs.channelId, channelId));
  // Rows written before `loyalty` existed lack it; the contract's default is on.
  return (row?.config as Partial<BotConfig> | undefined)?.loyalty?.enabled ?? true;
}
