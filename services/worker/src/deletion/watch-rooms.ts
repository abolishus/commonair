// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion's watch-room step (ADR 0017 decision 1): in the deletion transaction, end the
 * rooms the user hosts (`host_deleted`, invite cleared, every membership closed), then delete the
 * user's room messages and memberships. `completeDeletion` merges the returned counts into its own.
 *
 * The ended rooms stay until retention deletes them 30 days later, so the other members' messages
 * remain reportable. Chat learns of the end at the members' next send (the message insert needs an
 * open room) or join; the deleted user's own sockets close through `BUS.userControl`. A report
 * already filed keeps its own copy (`reports.evidence`), with the user by id only.
 */
import { schema, type Executor } from "@commonair/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

const { watchRooms: wr, watchRoomMembers: wm, watchRoomMessages: msgs } = schema;

export async function deleteRoomData(tx: Executor, userId: string): Promise<Record<string, number>> {
  const now = new Date();
  const ended = await tx
    .update(wr)
    .set({ endedAt: now, endReason: "host_deleted", inviteHash: null })
    .where(and(eq(wr.hostId, userId), isNull(wr.endedAt)))
    .returning({ id: wr.id });
  if (ended.length > 0)
    await tx
      .update(wm)
      .set({ leftAt: now })
      .where(
        and(
          inArray(
            wm.roomId,
            ended.map((r) => r.id),
          ),
          isNull(wm.leftAt),
        ),
      );
  const messages = await tx.delete(msgs).where(eq(msgs.authorId, userId)).returning({ id: msgs.id });
  const members = await tx.delete(wm).where(eq(wm.userId, userId)).returning({ id: wm.id });
  return {
    watch_rooms_ended: ended.length,
    watch_room_messages: messages.length,
    watch_room_members: members.length,
  };
}
