// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The held-message queue: messages a `hold` word filter kept back, shown to moderators only until
 * one allows or denies them. The row is the truth (`held_at`, `deleted_at`); the fan-out after a
 * decision only updates open sockets.
 *
 * Allowing publishes exactly what chat publishes for a live message (a `message` frame to
 * everyone on BUS.chat and `channel.chat.message` on BUS.events, built with the shared
 * `chatMessageEventPayload`), so bots and EventSub cannot tell a released message from a live one.
 * Denying sends a `delete` frame to moderators only: viewers never saw the message.
 *
 * One difference stays: chat's middleware `onMessage` hooks ran (or not) when the message was
 * first received; they are not run again on release, because they live in the chat process.
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { BusEvent, dto } from "@commonair/contracts";
import { ChatFanout, chatMessageEventPayload } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { conflict, forbidden, notFound } from "../lib/errors.ts";
import { isActiveBan } from "../moderation/chat-bans.ts";
import { messageDtos } from "./messages.ts";

const { chatMessages, chatBans, users, modActions } = schema;
type ChannelRow = typeof schema.channels.$inferSelect;

/** At most this many held messages are listed (oldest first). */
export const HELD_LIST_LIMIT = 100;

export async function listHeld(deps: Pick<Deps, "db">, c: ChannelRow): Promise<dto.ChatMessage[]> {
  const rows = await deps.db
    .select({ m: chatMessages, u: users })
    .from(chatMessages)
    .innerJoin(users, eq(users.id, chatMessages.userId))
    .where(and(eq(chatMessages.channelId, c.id), isNotNull(chatMessages.heldAt), isNull(chatMessages.deletedAt)))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(HELD_LIST_LIMIT);
  return messageDtos(deps, c, rows);
}

/** The BUS.chat envelope that releases an allowed message to everyone. */
export function allowFanout(c: Pick<ChannelRow, "slug">, message: dto.ChatMessage, now = Date.now()): ChatFanout {
  return ChatFanout.parse({
    v: 1,
    audience: "all",
    sentAt: now,
    frame: { op: "message", channel: c.slug, message },
  });
}

/** The BUS.chat envelope that drops a denied message from moderators' queues. */
export function denyFanout(
  c: Pick<ChannelRow, "slug">,
  messageId: string,
  username: string,
  now = Date.now(),
): ChatFanout {
  return ChatFanout.parse({
    v: 1,
    audience: "moderators",
    sentAt: now,
    frame: { op: "delete", channel: c.slug, messageId, username },
  });
}

/** `channel.chat.message` for a released message, the envelope chat builds for a live one. */
export function releasedEvent(
  c: Pick<ChannelRow, "id" | "ownerId" | "slug" | "displayName">,
  message: dto.ChatMessage,
): BusEvent {
  return {
    id: uuidv7(),
    type: "channel.chat.message",
    version: "1",
    channelId: c.id,
    payload: chatMessageEventPayload(c, message),
    occurredAt: message.createdAt,
  };
}

export interface ResolveInput {
  channel: ChannelRow;
  messageId: string;
  allow: boolean;
  moderatorId: string;
}

/**
 * Allow or deny one held message of `channel`. A message not in the table yet (chat writes in
 * batches) or in another channel is NOT_FOUND; one already allowed or deleted is CONFLICT.
 */
export async function resolveHeld(deps: Pick<Deps, "db" | "valkey" | "logger" | "now">, i: ResolveInput) {
  const c = i.channel;
  const now = deps.now();
  const row = await deps.db.transaction(async (tx) => {
    // Set on deny, so the audit row names the mod action as chat's `/delete` does.
    let modActionId: string | undefined;
    const [found] = await tx
      .select({
        id: chatMessages.id,
        userId: chatMessages.userId,
        heldAt: chatMessages.heldAt,
        deletedAt: chatMessages.deletedAt,
      })
      .from(chatMessages)
      .where(and(eq(chatMessages.id, i.messageId), eq(chatMessages.channelId, c.id)))
      .for("update");
    if (!found) throw notFound("Held message not found");
    if (found.heldAt === null || found.deletedAt !== null) throw conflict("This message was already resolved");
    if (i.allow) {
      // A banned or timed-out author's message stays held: deny it or wait out the timeout.
      const bans = await tx
        .select()
        .from(chatBans)
        .where(and(eq(chatBans.channelId, c.id), eq(chatBans.userId, found.userId), isNull(chatBans.liftedAt)));
      if (bans.some((b) => isActiveBan(b, now))) throw forbidden("The author is banned from this channel");
      await tx.update(chatMessages).set({ heldAt: null }).where(eq(chatMessages.id, found.id));
    } else {
      modActionId = uuidv7();
      await tx
        .update(chatMessages)
        .set({ deletedAt: now, deletedBy: i.moderatorId })
        .where(eq(chatMessages.id, found.id));
      // MOD_ACTIONS has no "allow"; a denial is a message deletion like `/delete`.
      await tx.insert(modActions).values({
        id: modActionId,
        scope: "channel",
        channelId: c.id,
        moderatorId: i.moderatorId,
        targetUserId: found.userId,
        action: "delete_message",
        subjectType: "chat_message",
        subjectId: found.id,
      });
    }
    await audit(tx, {
      actorType: "moderator",
      actorId: i.moderatorId,
      action: i.allow ? "chat.held.allow" : "chat.held.deny",
      subjectType: "chat_message",
      subjectId: found.id,
      channelId: c.id,
      details: modActionId ? { modActionId, authorId: found.userId } : { authorId: found.userId },
    });
    return found;
  });
  await publishResolution(deps, c, row.id, i.allow);
}

async function publishResolution(
  deps: Pick<Deps, "db" | "valkey" | "logger">,
  c: ChannelRow,
  messageId: string,
  allow: boolean,
): Promise<void> {
  try {
    const rows = await deps.db
      .select({ m: chatMessages, u: users })
      .from(chatMessages)
      .innerJoin(users, eq(users.id, chatMessages.userId))
      .where(eq(chatMessages.id, messageId));
    const [message] = await messageDtos(deps, c, rows);
    if (!message) return;
    if (allow) {
      await deps.valkey.publish(BUS.chat(c.id), JSON.stringify(allowFanout(c, message)));
      await deps.valkey.publish(BUS.events, JSON.stringify(releasedEvent(c, message)));
    } else await deps.valkey.publish(BUS.chat(c.id), JSON.stringify(denyFanout(c, message.id, message.user.username)));
  } catch (err) {
    // Committed: late joiners read history, moderators reload the queue.
    deps.logger.warn("held message publish failed", { channelId: c.id, messageId, allow, err });
  }
}
