// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel role changes inside a caller's transaction: the role row, the moderation action, the
 * audit row and the `channel.moderator.*` event, together. `channels.roles.grant`/`revoke` check
 * who may do it and publish the chat invalidation after commit; the channel bot (E8-bot-api) is
 * made a moderator with the same function.
 */
import { and, eq } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit, userFields } from "../events/outbox.ts";

const { channelRoles, modActions } = schema;

export type ChannelRole = "moderator" | "vip" | "editor";

const ROLE_ACTIONS = {
  moderator: { add: "add_moderator", remove: "remove_moderator" },
  vip: { add: "add_vip", remove: "remove_vip" },
  editor: { add: null, remove: null },
} as const;

/** Grant or revoke `role`; false when nothing changed (already held, or not held). */
export async function changeRoleInTx(
  tx: Executor,
  p: {
    channel: { id: string; ownerId: string; slug: string; displayName: string };
    target: { id: string; username: string; name: string };
    role: ChannelRole;
    op: "add" | "remove";
    actorId: string;
  },
): Promise<boolean> {
  const { channel: c, target, role, op, actorId } = p;
  const rows =
    op === "add"
      ? await tx
          .insert(channelRoles)
          .values({ channelId: c.id, userId: target.id, role, grantedBy: actorId })
          .onConflictDoNothing()
          .returning()
      : await tx
          .delete(channelRoles)
          .where(and(eq(channelRoles.channelId, c.id), eq(channelRoles.userId, target.id), eq(channelRoles.role, role)))
          .returning();
  if (rows.length === 0) return false;
  const action = ROLE_ACTIONS[role][op];
  if (action)
    await tx.insert(modActions).values({
      scope: "channel",
      channelId: c.id,
      moderatorId: actorId,
      targetUserId: target.id,
      action,
    });
  await audit(tx, {
    actorType: "user",
    actorId,
    action: `channel.role.${op}`,
    subjectType: "user",
    subjectId: target.id,
    channelId: c.id,
    details: { role },
  });
  if (role === "moderator")
    await emit(tx, op === "add" ? "channel.moderator.add" : "channel.moderator.remove", c.id, {
      ...broadcasterFields(c),
      ...userFields(target),
    });
  return true;
}
