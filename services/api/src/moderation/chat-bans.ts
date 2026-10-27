// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Lifting a channel chat ban or timeout, shared by `chat.bans.unban` and overturned moderation
 * appeals. The caller publishes `publishControl(… "invalidate", scope "user")` after commit.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit, moderatorFields, userFields } from "../events/outbox.ts";
import { notFound } from "../lib/errors.ts";

const { chatBans, modActions, users, channels } = schema;
type ChannelRow = typeof channels.$inferSelect;
export type ChatBanRow = typeof chatBans.$inferSelect;

export function isActiveBan(b: ChatBanRow, now: Date): boolean {
  return b.liftedAt === null && (b.expiresAt === null || b.expiresAt > now);
}

/**
 * Lift every unlifted ban of `target` in `channel` and, when one of them was still in force, record
 * the `unban`/`untimeout` mod action, the `chat.unban`/`chat.untimeout` audit row (with `appealId`
 * when an appeal caused it) and the `channel.unban` event. Returns the lifted active ban, or `null`
 * when the user was not banned (expired rows may still have been marked lifted: callers that treat
 * `null` as an error throw, which rolls that back).
 */
export async function liftChatBanInTx(
  tx: Executor,
  args: {
    channel: ChannelRow;
    target: { id: string; username: string; name: string };
    actor: { id: string; actorType: "moderator" | "admin" };
    now: Date;
    appealId?: string;
  },
): Promise<ChatBanRow | null> {
  const { channel, target, actor, now } = args;
  const lifted = await tx
    .update(chatBans)
    .set({ liftedAt: now, liftedBy: actor.id })
    .where(and(eq(chatBans.channelId, channel.id), eq(chatBans.userId, target.id), isNull(chatBans.liftedAt)))
    .returning();
  const active = lifted.find((b) => isActiveBan({ ...b, liftedAt: null }, now));
  if (!active) return null;
  await tx.insert(modActions).values({
    scope: "channel",
    channelId: channel.id,
    moderatorId: actor.id,
    targetUserId: target.id,
    action: active.expiresAt ? "untimeout" : "unban",
  });
  await audit(tx, {
    actorType: actor.actorType,
    actorId: actor.id,
    action: active.expiresAt ? "chat.untimeout" : "chat.unban",
    subjectType: "user",
    subjectId: target.id,
    channelId: channel.id,
    details: args.appealId ? { banId: active.id, appealId: args.appealId } : { banId: active.id },
  });
  const [moderator] = await tx
    .select({ id: users.id, username: users.username, name: users.name })
    .from(users)
    .where(eq(users.id, actor.id));
  if (!moderator) throw notFound("User not found");
  await emit(tx, "channel.unban", channel.id, {
    ...broadcasterFields(channel),
    ...userFields(target),
    ...moderatorFields(moderator),
  });
  return active;
}
