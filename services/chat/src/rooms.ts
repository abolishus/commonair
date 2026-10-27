// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local room membership. The first local member of a room subscribes this instance to the
 * room's chat and control channels; the last one to leave unsubscribes.
 */
import type { Bus } from "./bus.ts";
import { type ChatSocket, sendRaw, type Writer } from "./socket.ts";

/** "viewers" = everyone who is not a moderator (e.g. ban frames without the reason). */
export type Audience = "all" | "moderators" | "viewers";

interface Member {
  canModerate: boolean;
  userId: string | null;
  /** The socket's credentials carry moderator:manage:chat (a role alone is not enough). */
  modScope: boolean;
}

export interface Room {
  channelId: string;
  slug: string;
  members: Map<ChatSocket, Member>;
  /** Recent messages for reply lookups: id → author + body. Bounded. */
  recent: Map<string, { userId: string; username: string; body: string }>;
}

export interface RoomHandlers {
  onChat(channelId: string, raw: string): void;
  onControl(channelId: string, raw: string): void;
  /**
   * The last local member left: this instance stops hearing the room's control channel, so
   * whatever it cached about the room can no longer be invalidated and must be dropped.
   */
  onRelease?(channelId: string): void;
}

const RECENT_LIMIT = 500;

export class Rooms {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly bus: Bus,
    private readonly handlers: RoomHandlers,
    private readonly writer: Writer,
  ) {}

  get(channelId: string): Room | undefined {
    return this.rooms.get(channelId);
  }

  get size(): number {
    return this.rooms.size;
  }

  async join(ws: ChatSocket, channel: { id: string; slug: string }, member: Member): Promise<void> {
    let room = this.rooms.get(channel.id);
    if (!room) {
      room = { channelId: channel.id, slug: channel.slug, members: new Map(), recent: new Map() };
      this.rooms.set(channel.id, room);
    }
    if (room.members.has(ws)) {
      room.members.set(ws, member);
      return;
    }
    room.members.set(ws, member);
    try {
      await Promise.all([
        this.bus.acquire(this.bus.names.chat(channel.id), (raw) => this.handlers.onChat(channel.id, raw)),
        this.bus.acquire(this.bus.names.control(channel.id), (raw) => this.handlers.onControl(channel.id, raw)),
      ]);
    } catch (err) {
      await this.part(ws, channel.id);
      throw err;
    }
  }

  async part(ws: ChatSocket, channelId: string): Promise<void> {
    const room = this.rooms.get(channelId);
    if (!room?.members.delete(ws)) return;
    if (room.members.size === 0) {
      this.rooms.delete(channelId);
      this.handlers.onRelease?.(channelId);
    }
    await Promise.all([
      this.bus.release(this.bus.names.chat(channelId)),
      this.bus.release(this.bus.names.control(channelId)),
    ]);
  }

  /** Deliver one serialized frame to every local member (or only moderators). Returns sockets reached. */
  deliver(channelId: string, data: string, audience: Audience = "all"): number {
    const room = this.rooms.get(channelId);
    if (!room) return 0;
    let n = 0;
    for (const [ws, m] of room.members) {
      if (audience === "moderators" && !m.canModerate) continue;
      if (audience === "viewers" && m.canModerate) continue;
      if (sendRaw(ws, data, this.writer)) n++;
    }
    return n;
  }

  /** Update cached moderator flags after a role change. */
  setModeratorRole(channelId: string, userId: string, isModerator: boolean): void {
    const room = this.rooms.get(channelId);
    if (!room) return;
    for (const m of room.members.values()) if (m.userId === userId) m.canModerate = isModerator && m.modScope;
  }

  usersIn(channelId: string): Set<string> {
    const out = new Set<string>();
    for (const m of this.rooms.get(channelId)?.members.values() ?? []) if (m.userId) out.add(m.userId);
    return out;
  }

  remember(channelId: string, id: string, userId: string, username: string, body: string): void {
    const room = this.rooms.get(channelId);
    if (!room) return;
    room.recent.set(id, { userId, username, body });
    if (room.recent.size > RECENT_LIMIT) {
      const oldest = room.recent.keys().next();
      if (!oldest.done) room.recent.delete(oldest.value);
    }
  }

  /** Forget messages that must no longer be quoted in replies (deleted, cleared, author banned). */
  forget(channelId: string, what: { messageId?: string; userId?: string; all?: boolean }): void {
    const room = this.rooms.get(channelId);
    if (!room) return;
    if (what.all) room.recent.clear();
    if (what.messageId) room.recent.delete(what.messageId);
    if (what.userId) for (const [id, m] of room.recent) if (m.userId === what.userId) room.recent.delete(id);
  }

  all(): IterableIterator<Room> {
    return this.rooms.values();
  }
}
