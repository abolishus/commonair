// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch rooms in the account export (ADR 0017): the member's own rooms and their own messages, while
 * they still exist (30 days after a room ends). Other members' messages and ids are theirs, so they
 * are not exported: a room shows its channel slug, the requester's band and times, and whether the
 * requester hosted it.
 */
import { schema as s } from "@commonair/db";
import { asc, eq, sql } from "drizzle-orm";
import type { ExportFile } from "./collectors.ts";

const roomFields = {
  roomId: s.watchRooms.id,
  channelSlug: s.channels.slug,
  hosted: sql<boolean>`${s.watchRooms.hostId} = ${s.watchRoomMembers.userId}`,
  ageBand: s.watchRooms.ageBand,
  roomCreatedAt: s.watchRooms.createdAt,
  roomEndedAt: s.watchRooms.endedAt,
  joinedAt: s.watchRoomMembers.joinedAt,
  leftAt: s.watchRoomMembers.leftAt,
};

const messageFields = {
  id: s.watchRoomMessages.id,
  roomId: s.watchRoomMessages.roomId,
  body: s.watchRoomMessages.body,
  createdAt: s.watchRoomMessages.createdAt,
};

export const WATCH_ROOM_EXPORT_FILES: readonly ExportFile[] = [
  {
    name: "watch-rooms.json",
    kind: "account",
    sections: {
      rooms: {
        fields: roomFields,
        query: (tx, { userId }) =>
          tx
            .select(roomFields)
            .from(s.watchRoomMembers)
            .innerJoin(s.watchRooms, eq(s.watchRooms.id, s.watchRoomMembers.roomId))
            .innerJoin(s.channels, eq(s.channels.id, s.watchRooms.channelId))
            .where(eq(s.watchRoomMembers.userId, userId))
            .orderBy(asc(s.watchRoomMembers.joinedAt)),
      },
      messages: {
        fields: messageFields,
        query: (tx, { userId }) =>
          tx
            .select(messageFields)
            .from(s.watchRoomMessages)
            .where(eq(s.watchRoomMessages.authorId, userId))
            .orderBy(asc(s.watchRoomMessages.createdAt), asc(s.watchRoomMessages.id)),
      },
    },
  },
];
