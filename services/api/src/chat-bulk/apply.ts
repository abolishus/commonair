// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chat.bans.bulk` (J5-d): time out every sender of a message wave, optionally deleting its
 * messages. One transaction for the whole wave, with the single-ban path's rows for each target
 * (the chat ban, the mod action, one audit row, one `channel.ban` outbox row) and the chat
 * service's `delete_message` rows for each deleted message. Never a permanent ban.
 *
 * Deletion writes the rows chat's `delete` command writes instead of relaying up to 50 commands
 * to chat one socket at a time; the control frames published after commit let every chat and
 * IRC instance drop the messages the same way.
 */
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { schema, uuidv7, type Executor } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit, moderatorFields, userFields } from "../events/outbox.ts";
import { publishControl } from "../lib/control.ts";
import { iso } from "../lib/dto.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { planBulkTimeout, type BulkPlan, type WaveMessage } from "./plan.ts";

const { chatMessages, chatBans, channelRoles, users, modActions } = schema;

/** The platform roles `chat.bans.bulk` never times out. */
export const STAFF_ROLES = ["moderator", "admin", "legal", "treasurer"] as const;

export interface BulkTimeoutInput {
  channel: { id: string; ownerId: string; slug: string; displayName: string };
  callerId: string;
  messageIds: readonly string[];
  durationSeconds: number;
  reason: string;
  deleteMessages: boolean;
}

export interface BulkTimeoutOutcome {
  timedOut: { userId: string; username: string; expiresAt: string }[];
  skipped: BulkPlan["skipped"];
  deletedMessages: number;
}

interface Person {
  id: string;
  username: string;
  name: string;
}

async function loadFacts(tx: Executor, input: BulkTimeoutInput, now: Date, expiresAt: Date) {
  const ids = [...new Set(input.messageIds)];
  const found = await tx
    .select({
      id: chatMessages.id,
      userId: chatMessages.userId,
      channelId: chatMessages.channelId,
      deletedAt: chatMessages.deletedAt,
    })
    .from(chatMessages)
    .where(inArray(chatMessages.id, ids));
  const byId = new Map(found.map((m) => [m.id, m]));
  const messages: WaveMessage[] = ids.flatMap((id) => {
    const m = byId.get(id);
    return m ? [{ id, userId: m.userId, channelId: m.channelId, deleted: m.deletedAt !== null }] : [];
  });
  if (!messages.some((m) => m.channelId === input.channel.id))
    throw badRequest("None of these messages are in this channel's chat");
  const senders = [...new Set(messages.map((m) => m.userId))];
  const [people, roles, bans] = await Promise.all([
    tx
      .select({ id: users.id, username: users.username, name: users.name, role: users.role })
      .from(users)
      .where(inArray(users.id, senders)),
    tx
      .select({ userId: channelRoles.userId })
      .from(channelRoles)
      .where(
        and(
          eq(channelRoles.channelId, input.channel.id),
          inArray(channelRoles.userId, senders),
          inArray(channelRoles.role, ["moderator", "editor"]),
        ),
      ),
    tx
      .select({ userId: chatBans.userId, expiresAt: chatBans.expiresAt })
      .from(chatBans)
      .where(
        and(
          eq(chatBans.channelId, input.channel.id),
          inArray(chatBans.userId, senders),
          isNull(chatBans.liftedAt),
          or(isNull(chatBans.expiresAt), gt(chatBans.expiresAt, now)),
        ),
      ),
  ]);
  const plan = planBulkTimeout({
    channelId: input.channel.id,
    ownerId: input.channel.ownerId,
    callerId: input.callerId,
    messages,
    staff: new Set(people.filter((p) => (STAFF_ROLES as readonly string[]).includes(p.role)).map((p) => p.id)),
    channelMods: new Set(roles.map((r) => r.userId)),
    activeBans: new Map(bans.map((b) => [b.userId, b.expiresAt])),
    expiresAt,
  });
  return { plan, people: new Map<string, Person>(people.map((p) => [p.id, p])) };
}

/** Apply a bulk timeout; the chat control frames go out after the transaction commits. */
export async function bulkTimeout(deps: Deps, input: BulkTimeoutInput): Promise<BulkTimeoutOutcome> {
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + input.durationSeconds * 1000);
  const c = input.channel;
  const result = await deps.db.transaction(async (tx) => {
    const { plan, people } = await loadFacts(tx, input, now, expiresAt);
    const [actor] = await tx
      .select({ id: users.id, username: users.username, name: users.name })
      .from(users)
      .where(eq(users.id, input.callerId));
    if (!actor) throw notFound("User not found");
    const timedOut: Person[] = [];
    for (const userId of plan.targets) {
      const target = people.get(userId);
      if (!target) continue;
      // A new timeout replaces any previous row (an expired, unlifted timeout or a shorter one).
      await tx
        .update(chatBans)
        .set({ liftedAt: now, liftedBy: actor.id })
        .where(and(eq(chatBans.channelId, c.id), eq(chatBans.userId, userId), isNull(chatBans.liftedAt)));
      const banId = uuidv7(now.getTime());
      await tx.insert(chatBans).values({
        id: banId,
        channelId: c.id,
        userId,
        moderatorId: actor.id,
        reason: input.reason,
        expiresAt,
        createdAt: now,
      });
      await tx.insert(modActions).values({
        scope: "channel",
        channelId: c.id,
        moderatorId: actor.id,
        targetUserId: userId,
        action: "timeout",
        reason: input.reason,
        durationSeconds: input.durationSeconds,
      });
      await audit(tx, {
        actorType: "moderator",
        actorId: actor.id,
        action: "chat.timeout",
        subjectType: "user",
        subjectId: userId,
        channelId: c.id,
        reason: input.reason,
        details: { banId, durationSeconds: input.durationSeconds, bulk: true },
      });
      await emit(tx, "channel.ban", c.id, {
        ...broadcasterFields(c),
        ...userFields(target),
        ...moderatorFields(actor),
        reason: input.reason,
        banned_at: iso(now),
        ends_at: iso(expiresAt),
        is_permanent: false,
      });
      timedOut.push(target);
    }
    const deleted: { id: string; userId: string }[] =
      input.deleteMessages && plan.deletable.length > 0
        ? await tx
            .update(chatMessages)
            .set({ deletedAt: now, deletedBy: actor.id })
            .where(
              and(
                inArray(chatMessages.id, plan.deletable),
                eq(chatMessages.channelId, c.id),
                isNull(chatMessages.deletedAt),
              ),
            )
            .returning({ id: chatMessages.id, userId: chatMessages.userId })
        : [];
    for (const m of deleted) {
      const author = people.get(m.userId);
      if (!author) continue;
      const modActionId = uuidv7(now.getTime());
      await tx.insert(modActions).values({
        id: modActionId,
        scope: "channel",
        channelId: c.id,
        moderatorId: actor.id,
        targetUserId: m.userId,
        action: "delete_message",
        subjectType: "chat_message",
        subjectId: m.id,
      });
      await audit(tx, {
        actorType: "moderator",
        actorId: actor.id,
        action: "chat.delete_message",
        subjectType: "chat_message",
        subjectId: m.id,
        channelId: c.id,
        details: { modActionId, bulk: true },
      });
      await emit(tx, "channel.chat.message_delete", c.id, {
        ...broadcasterFields(c),
        target_user_id: author.id,
        target_user_login: author.username,
        target_user_name: author.name,
        message_id: m.id,
      });
    }
    return { plan, timedOut, deleted: deleted.map((m) => ({ id: m.id, username: people.get(m.userId)?.username })) };
  });
  for (const t of result.timedOut)
    await publishControl(deps, c.id, {
      op: "ban",
      channel: c.slug,
      userId: t.id,
      username: t.username,
      expiresAt: iso(expiresAt),
      reason: input.reason,
    });
  for (const m of result.deleted)
    if (m.username)
      await publishControl(deps, c.id, { op: "delete", channel: c.slug, messageId: m.id, username: m.username });
  return {
    timedOut: result.timedOut.map((t) => ({ userId: t.id, username: t.username, expiresAt: iso(expiresAt) })),
    skipped: result.plan.skipped,
    deletedMessages: result.deleted.length,
  };
}
