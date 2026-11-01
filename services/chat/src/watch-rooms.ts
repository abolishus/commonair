// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch rooms in chat (ADR 0017, decisions (q) and (r)): `room.join` / `room.part` / `room.send` /
 * `room.sync` frames, presence in Valkey, the 2 s sync target, and `BUS.roomControl` close and kick.
 * A room never touches channel fan-out (`rooms.ts`).
 *
 * Owned by W3-watch-rooms. The batch 7 contract step wired the seams: `server.ts` dispatches the
 * `room.*` frames here (a non-null result is sent back as a notice with the frame's nonce) and
 * calls `partAll` when a socket closes; it subscribes `BUS.roomControl` and hands each valid
 * message to `onControl`; `core.ts` builds this class with `WatchRoomDeps` (the filter pipeline,
 * the bus, Valkey). `ws.data.watchRooms` holds the room ids a socket joined.
 *
 * Until the unit lands this is a stub: every join and send is refused with `room_closed`, and
 * part, sync and control messages do nothing.
 */
import type { ClientFrame, RoomControlMessage } from "@commonair/contracts";
import type { WatchRoomDeps, WatchRoomHandler } from "./core.ts";
import type { ChatSocket } from "./socket.ts";
import type { Rejection } from "./types.ts";

type RoomFrame<Op extends ClientFrame["op"]> = Extract<ClientFrame, { op: Op }>;

const UNAVAILABLE: Rejection = { code: "room_closed", text: "Watch rooms are not available yet." };

export class WatchRooms implements WatchRoomHandler {
  constructor(private readonly d: WatchRoomDeps) {}

  async join(_ws: ChatSocket, _frame: RoomFrame<"room.join">): Promise<Rejection | null> {
    return UNAVAILABLE;
  }

  async part(_ws: ChatSocket, _frame: RoomFrame<"room.part">): Promise<Rejection | null> {
    return null;
  }

  async send(_ws: ChatSocket, _frame: RoomFrame<"room.send">): Promise<Rejection | null> {
    return UNAVAILABLE;
  }

  async sync(_ws: ChatSocket, _frame: RoomFrame<"room.sync">): Promise<Rejection | null> {
    return null;
  }

  onControl(msg: RoomControlMessage): void {
    this.d.logger.debug("watch-room control ignored (stub)", { op: msg.op, roomId: msg.roomId });
  }

  async partAll(ws: ChatSocket): Promise<void> {
    ws.data.watchRooms.clear();
  }
}
