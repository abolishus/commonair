// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch rooms in chat (ADR 0017, decisions (q) and (r)): `room.join` / `room.part` / `room.send` /
 * `room.sync` frames, presence in Valkey, the 2 s sync target, and `BUS.roomControl` close and kick.
 * A room never touches channel fan-out (`rooms.ts`): its frames go over `BUS.room(id)` to the
 * room's connected members only.
 *
 * - **Join.** `watchRooms.join` (API) admits a member and returns a chat token whose only scope is
 *   the room's audience. Chat then re-checks against Postgres at every (re)connect: an open room,
 *   an active membership, the band from the birth date on the database's day, mature content, and
 *   the platform and channel bans (blocks are checked once, at first join). A member who fails is removed
 *   (`left_at`, `room.kick`) and told why.
 * - **Send.** The member's platform standing, then the host channel's word filters (read only; a
 *   `hold` is a refusal, since nobody moderates a room), then `CHAT_LIMITS.room`. The message is
 *   inserted only while the room is open and the author an active member, then fanned out.
 * - **Sync.** Members report their playhead; every instance computes the target from the shared
 *   `KEYS.roomSync` hash and sends it to its own members every 2 s (no election needed).
 * - **Room state.** A watcher (`watch-rooms/watcher.ts`) ends rooms and removes members from bus
 *   events: the broadcast ends, the channel turns mature, a channel or platform ban.
 */
import { and, eq, isNull } from "drizzle-orm";
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import {
  CHAT_LIMITS,
  type ClientFrame,
  type RoomControlMessage,
  type ServerFrame,
  ServerFrame as ServerFrameSchema,
} from "@commonair/contracts";
import { KEYS, ROOM_PRESENCE_TTL_SECONDS, RoomSyncReport, type RoomPresence } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { verifyChatToken } from "@commonair/tokens";
import { sql } from "drizzle-orm";
import type { WatchRoomDeps, WatchRoomHandler } from "./core.ts";
import { errorFields } from "./errors.ts";
import { containsLink } from "./content.ts";
import { isPrivileged } from "./rules.ts";
import { type ChatSocket, sendFrame, sendNotice } from "./socket.ts";
import type { Rejection } from "./types.ts";
import { checkMember, endRoom, removeMember, type MemberCheck } from "./watch-rooms/db.ts";
import { EDGE_FIELD, parseEdge, parseSyncHash, SYNC_TICK_MS, syncState } from "./watch-rooms/sync.ts";
import { RoomWatcher } from "./watch-rooms/watcher.ts";

type RoomFrame<Op extends ClientFrame["op"]> = Extract<ClientFrame, { op: Op }>;

const { watchRoomMembers: wm } = schema;

/** How many recent messages a (re)joining member is sent. */
export const ROOM_BACKLOG = 50;

const CLOSED: Rejection = { code: "room_closed", text: "This watch room is not available." };
const REFUSALS: Record<Exclude<MemberCheck, "ok"> | "blocked", Rejection> = {
  closed: CLOSED,
  age_band: { code: "room_age_band", text: "This watch room is for another age group." },
  banned: { code: "room_banned", text: "You cannot join this watch room." },
  blocked: { code: "room_blocked", text: "You cannot join this watch room." },
};

/** Test-only knobs on top of `WatchRoomDeps`. */
interface ExtraDeps {
  /** Tests: a faster sync tick. */
  syncTickMs?: number;
  /** Tests: a shorter empty-room wait than `ROOM_LIMITS.emptyEndMinutes`. */
  emptyEndMs?: number;
}

interface LocalRoom {
  sockets: Set<ChatSocket>;
  hostId: string;
  ageBand: "minor" | "adult";
  channelId: string;
  slug: string;
}

const parseReport = (raw: unknown): RoomSyncReport | null => {
  const r = RoomSyncReport.safeParse(raw);
  return r.success ? r.data : null;
};

export class WatchRooms implements WatchRoomHandler {
  private readonly local = new Map<string, LocalRoom>();
  private readonly instance = crypto.randomUUID();
  private readonly tick: ReturnType<typeof setInterval>;
  private readonly watcher: RoomWatcher;
  private readonly extra: ExtraDeps;
  /** Rooms this instance last saw empty, waiting `emptyEndMinutes` before ending them. */
  private readonly emptyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly d: WatchRoomDeps) {
    this.extra = d as WatchRoomDeps & ExtraDeps;
    this.tick = setInterval(() => void this.onTick(), this.extra.syncTickMs ?? SYNC_TICK_MS);
    this.watcher = new RoomWatcher(d, (msg) => this.publishControl(msg));
    this.watcher.start().catch((err: unknown) => d.logger.warn("room watcher start failed", errorFields(err)));
  }

  // ── frames ─────────────────────────────────────────────────────────────────

  async join(ws: ChatSocket, frame: RoomFrame<"room.join">): Promise<Rejection | null> {
    const userId = ws.data.identity.userId;
    if (!userId) return CLOSED;
    if (!(await this.tokenOk(frame.token, userId, frame.roomId))) return CLOSED;
    const check = await checkMember(this.d.db, frame.roomId, userId);
    if (check.result !== "ok") {
      if (check.result !== "closed" && check.member) {
        // Standing changed since the API admitted them: removed everywhere (the host's room ends).
        const changed = await removeMember(this.d.db, frame.roomId, userId);
        if (changed === "ended")
          await this.publishControl({ op: "room.close", roomId: frame.roomId, reason: "moderation" });
        else if (changed === "kicked")
          await this.publishControl({
            op: "room.kick",
            roomId: frame.roomId,
            userId,
            reason: check.result === "banned" ? "banned" : "age_band",
          });
      }
      this.d.logger.info("watch room join refused", { roomId: frame.roomId, userId, code: check.result });
      return REFUSALS[check.result];
    }
    const room = check.room;
    let entry = this.local.get(frame.roomId);
    if (!entry) {
      entry = {
        sockets: new Set(),
        hostId: room.hostId,
        ageBand: room.ageBand,
        channelId: room.channelId,
        slug: room.slug,
      };
      this.local.set(frame.roomId, entry);
      await this.d.bus.acquire(this.d.bus.names.room(frame.roomId), (raw) => this.onRoomFrame(frame.roomId, raw));
    }
    this.clearEmptyTimer(frame.roomId);
    entry.sockets.add(ws);
    ws.data.watchRooms.add(frame.roomId);
    await this.markPresent(frame.roomId, [userId]);
    await this.sendBacklog(ws, frame.roomId);
    await this.publishState(frame.roomId);
    return null;
  }

  async part(ws: ChatSocket, frame: RoomFrame<"room.part">): Promise<Rejection | null> {
    await this.leaveLocal(ws, frame.roomId);
    return null;
  }

  async send(ws: ChatSocket, frame: RoomFrame<"room.send">): Promise<Rejection | null> {
    const userId = ws.data.identity.userId;
    const entry = this.local.get(frame.roomId);
    if (!userId || !entry || !ws.data.watchRooms.has(frame.roomId)) return CLOSED;
    if (!ws.data.identity.scopes.includes("chat:edit"))
      return { code: "msg_requires_login", text: "You must be logged in to chat." };
    const now = Date.now();

    // The platform filter: platform standing first.
    const profile = await this.d.directory.profile(userId);
    if (!profile || profile.deleted) return CLOSED;
    if (profile.banned && (profile.banExpires === null || profile.banExpires.getTime() > now)) return REFUSALS.banned;
    // The host channel's bans and word filters, read only.
    const loaded = await this.d.directory.channel(entry.slug);
    if (!loaded) return CLOSED;
    const standing = await this.d.directory.standing(loaded.state, userId);
    if (standing.ban && (standing.ban.expiresAt === null || standing.ban.expiresAt.getTime() > now))
      return REFUSALS.banned;
    if (
      !(await this.d.limiter.hit(`room:${frame.roomId}`, userId, CHAT_LIMITS.room.perWindow, CHAT_LIMITS.windowMs, now))
    )
      return { code: "msg_ratelimit", text: "You are sending messages too quickly." };
    // The channel's link rule applies, as in channel chat (its broadcaster and moderators may post
    // links). The rest of the
    // channel pipeline (`pipeline.ts`) deliberately does not: its middleware (the channel bot,
    // giveaway entries) acts for the channel's audience. No stream-key-leak scanner is registered
    // (`plugins/index.ts`); if one is added, run it here too.
    if (!loaded.state.settings.linksAllowed && !isPrivileged(standing) && containsLink(frame.body))
      return { code: "msg_links_blocked", text: "Links are not allowed in this channel." };
    const outcome = await this.d.filterRunner.run(frame.body, loaded.filters);
    // Nobody moderates a room, so a held message is refused like a blocked one.
    if (outcome.action !== "pass") {
      this.d.metrics.dropped("rejected", { code: "msg_rejected" });
      return { code: "msg_rejected", text: "Your message was not sent because it matched a channel filter." };
    }
    const body = outcome.body.trim().slice(0, CHAT_LIMITS.room.maxBodyLength);
    if (body.length === 0) return { code: "msg_rejected", text: "Your message was not sent." };

    const id = uuidv7(now);
    const rows = await this.d.db.execute<{ created_at: string | Date }>(sql`
      insert into watch_room_messages (id, room_id, author_id, body)
      select ${id}::uuid, ${frame.roomId}::uuid, ${userId}::uuid, ${body}
       where exists (select 1 from watch_rooms r where r.id = ${frame.roomId}::uuid and r.ended_at is null)
         and exists (select 1 from watch_room_members m
                      where m.room_id = ${frame.roomId}::uuid and m.user_id = ${userId}::uuid and m.left_at is null)
      returning created_at`);
    const created = rows[0];
    if (!created) {
      await this.leaveLocal(ws, frame.roomId);
      return CLOSED;
    }
    const message: Extract<ServerFrame, { op: "room.message" }> = {
      op: "room.message",
      roomId: frame.roomId,
      message: {
        id,
        user: { id: userId, username: profile.username, displayName: profile.displayName },
        body,
        createdAt: new Date(created.created_at).toISOString(),
      },
    };
    await this.publishFrame(frame.roomId, message);
    return null;
  }

  async sync(ws: ChatSocket, frame: RoomFrame<"room.sync">): Promise<Rejection | null> {
    const userId = ws.data.identity.userId;
    if (!userId || !ws.data.watchRooms.has(frame.roomId)) return null;
    const report: RoomSyncReport = {
      playheadWallclock: frame.playheadWallclock,
      mode: frame.mode,
      at: Date.now(),
      // The member's live edge (batch 8); never kept for a DVR report, absent from older clients.
      ...(frame.edgeWallclock !== undefined
        ? { edgeWallclock: frame.mode === "live" ? frame.edgeWallclock : null }
        : {}),
    };
    const key = KEYS.roomSync(frame.roomId);
    await this.d.valkey.multi().hset(key, userId, JSON.stringify(report)).expire(key, ROOM_PRESENCE_TTL_SECONDS).exec();
    return null;
  }

  onControl(msg: RoomControlMessage): void {
    const entry = this.local.get(msg.roomId);
    if (!entry) return;
    if (msg.op === "room.close") {
      for (const ws of entry.sockets) {
        sendFrame(ws, { op: "room.closed", roomId: msg.roomId, reason: msg.reason }, this.d.frameWriter);
        ws.data.watchRooms.delete(msg.roomId);
      }
      entry.sockets.clear();
      void this.dropLocal(msg.roomId);
      return;
    }
    const kicked = [...entry.sockets].filter((ws) => ws.data.identity.userId === msg.userId);
    if (kicked.length === 0) return;
    const notice =
      msg.reason === "banned" || msg.reason === "suspended"
        ? REFUSALS.banned
        : msg.reason === "blocked"
          ? REFUSALS.blocked
          : msg.reason === "age_band"
            ? REFUSALS.age_band
            : null;
    for (const ws of kicked) {
      // A member who left on their own (another tab) just stops getting the room; a removal says why.
      if (notice) {
        sendNotice(ws, { channel: null, ...notice }, this.d.frameWriter);
        sendFrame(ws, { op: "room.closed", roomId: msg.roomId, reason: "moderation" }, this.d.frameWriter);
      }
      entry.sockets.delete(ws);
      ws.data.watchRooms.delete(msg.roomId);
    }
    void (async () => {
      await this.d.valkey.hdel(KEYS.roomPresence(msg.roomId), msg.userId);
      await this.d.valkey.hdel(KEYS.roomSync(msg.roomId), msg.userId);
      if (entry.sockets.size === 0) {
        await this.dropLocal(msg.roomId);
        this.scheduleEmptyCheck(msg.roomId);
      }
      await this.publishState(msg.roomId);
    })().catch((err: unknown) => this.d.logger.warn("room kick cleanup failed", errorFields(err)));
  }

  async partAll(ws: ChatSocket): Promise<void> {
    for (const roomId of Array.from(ws.data.watchRooms)) await this.leaveLocal(ws, roomId);
    ws.data.watchRooms.clear();
  }

  async close(): Promise<void> {
    clearInterval(this.tick);
    for (const timer of this.emptyTimers.values()) clearTimeout(timer);
    this.emptyTimers.clear();
    await this.watcher.stop();
    for (const roomId of Array.from(this.local.keys())) await this.dropLocal(roomId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The token's signature, owner and audience. */
  private async tokenOk(token: string, userId: string, roomId: string): Promise<boolean> {
    const claims = await verifyChatToken(this.d.internalSecret, token);
    return claims !== null && claims.uid === userId && claims.scopes.includes(`room:${roomId}`);
  }

  private async leaveLocal(ws: ChatSocket, roomId: string): Promise<void> {
    ws.data.watchRooms.delete(roomId);
    const entry = this.local.get(roomId);
    if (!entry || !entry.sockets.delete(ws)) return;
    const userId = ws.data.identity.userId;
    const stillHere = userId !== null && [...entry.sockets].some((s) => s.data.identity.userId === userId);
    if (userId && !stillHere) {
      await this.d.valkey.hdel(KEYS.roomPresence(roomId), userId);
      await this.d.valkey.hdel(KEYS.roomSync(roomId), userId);
    }
    if (entry.sockets.size === 0) {
      await this.dropLocal(roomId);
      this.scheduleEmptyCheck(roomId);
    }
    await this.publishState(roomId);
  }

  /**
   * ADR 0017: a room nobody is connected to ends after `ROOM_LIMITS.emptyEndMinutes`. A closed tab
   * never sets `left_at`, so "empty" is the shared presence hash, not membership. The instance that
   * dropped the room's last local socket waits, then ends it if no instance has a member present.
   * Several instances racing are fine: `endRoom` is conditional. A restart loses the timer; the
   * retention job is the backstop.
   */
  private scheduleEmptyCheck(roomId: string): void {
    this.clearEmptyTimer(roomId);
    const wait = this.extra.emptyEndMs ?? ROOM_LIMITS.emptyEndMinutes * 60_000;
    const timer = setTimeout(() => {
      this.emptyTimers.delete(roomId);
      void this.endIfEmpty(roomId).catch((err: unknown) =>
        this.d.logger.warn("room empty check failed", { ...errorFields(err), roomId }),
      );
    }, wait);
    timer.unref?.();
    this.emptyTimers.set(roomId, timer);
  }

  private clearEmptyTimer(roomId: string): void {
    const timer = this.emptyTimers.get(roomId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.emptyTimers.delete(roomId);
  }

  private async endIfEmpty(roomId: string): Promise<void> {
    if (this.local.has(roomId)) return;
    if ((await this.d.valkey.hlen(KEYS.roomPresence(roomId))) > 0) return;
    if (await endRoom(this.d.db, roomId, "empty")) {
      this.d.logger.info("watch room ended", { roomId, reason: "empty" });
      await this.publishControl({ op: "room.close", roomId, reason: "empty" });
    }
  }

  private async dropLocal(roomId: string): Promise<void> {
    if (!this.local.delete(roomId)) return;
    await this.d.bus.release(this.d.bus.names.room(roomId));
  }

  private async markPresent(roomId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    const key = KEYS.roomPresence(roomId);
    const value: RoomPresence = { instance: this.instance, since: new Date().toISOString() };
    const m = this.d.valkey.multi();
    for (const u of userIds) m.hset(key, u, JSON.stringify(value));
    m.expire(key, ROOM_PRESENCE_TTL_SECONDS);
    await m.exec();
  }

  private async sendBacklog(ws: ChatSocket, roomId: string): Promise<void> {
    const rows = await this.d.db.execute<{
      id: string;
      author_id: string;
      body: string;
      created_at: string | Date;
      username: string;
      display: string;
    }>(sql`
      select m.id, m.author_id, m.body, m.created_at, u.username, coalesce(u.display_username, u.name) as display
        from (select * from watch_room_messages where room_id = ${roomId}::uuid
               order by created_at desc, id desc limit ${ROOM_BACKLOG}) m
        join users u on u.id = m.author_id
       order by m.created_at asc, m.id asc`);
    for (const r of rows)
      sendFrame(
        ws,
        {
          op: "room.message",
          roomId,
          message: {
            id: r.id,
            user: { id: r.author_id, username: r.username, displayName: r.display },
            body: r.body,
            createdAt: new Date(r.created_at).toISOString(),
          },
        },
        this.d.frameWriter,
      );
  }

  /** `room.state` with the members connected now (any instance), to every connected member. */
  private async publishState(roomId: string): Promise<void> {
    const entry = this.local.get(roomId);
    const present = Object.keys(await this.d.valkey.hgetall(KEYS.roomPresence(roomId)));
    const [room] = entry
      ? [{ hostId: entry.hostId, ageBand: entry.ageBand }]
      : await this.d.db
          .select({ hostId: schema.watchRooms.hostId, ageBand: schema.watchRooms.ageBand })
          .from(schema.watchRooms)
          .where(eq(schema.watchRooms.id, roomId));
    if (!room) return;
    // Only active members are shown, whatever presence says (a kicked member's field may linger).
    const active = present.length
      ? await this.d.db
          .select({ userId: wm.userId })
          .from(wm)
          .where(and(eq(wm.roomId, roomId), isNull(wm.leftAt)))
      : [];
    const activeIds = new Set(active.map((a) => a.userId));
    const members = [];
    for (const id of present.filter((p) => activeIds.has(p)).slice(0, 8)) {
      const p = await this.d.directory.profile(id);
      if (p) members.push({ id, username: p.username, displayName: p.displayName, avatarUrl: null });
    }
    await this.publishFrame(roomId, { op: "room.state", roomId, hostId: room.hostId, ageBand: room.ageBand, members });
  }

  private async publishFrame(roomId: string, frame: ServerFrame): Promise<void> {
    await this.d.bus.publish(this.d.bus.names.room(roomId), JSON.stringify(frame));
  }

  private async publishControl(msg: RoomControlMessage): Promise<void> {
    await this.d.bus.publish(this.d.bus.names.roomControl(), JSON.stringify(msg));
  }

  /** A frame from `BUS.room(id)`: forward it to this instance's members of the room. */
  private onRoomFrame(roomId: string, raw: string): void {
    const entry = this.local.get(roomId);
    if (!entry) return;
    let frame: ServerFrame;
    try {
      const parsed = ServerFrameSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    if (!("roomId" in frame) || frame.roomId !== roomId) return;
    for (const ws of entry.sockets) sendFrame(ws, frame, this.d.frameWriter);
  }

  /** Every `SYNC_TICK_MS`: refresh presence and send each local room its sync target. */
  private async onTick(): Promise<void> {
    const now = Date.now();
    for (const [roomId, entry] of this.local) {
      try {
        const users = [...new Set([...entry.sockets].map((s) => s.data.identity.userId).filter((u) => u !== null))];
        await this.markPresent(roomId, users);
        const key = KEYS.roomSync(roomId);
        const hash = await this.d.valkey.hgetall(key);
        const state = syncState({
          reports: parseSyncHash(hash, parseReport),
          now,
          prevEdge: parseEdge(hash[EDGE_FIELD]),
        });
        if (state === null) continue;
        await this.d.valkey
          .multi()
          .hset(key, EDGE_FIELD, JSON.stringify(state.edge))
          .expire(key, ROOM_PRESENCE_TTL_SECONDS)
          .exec();
        const frame: ServerFrame = { op: "room.sync", roomId, target: new Date(state.target).toISOString() };
        for (const ws of entry.sockets) sendFrame(ws, frame, this.d.frameWriter);
      } catch (err) {
        this.d.logger.warn("room sync tick failed", { ...errorFields(err), roomId });
      }
    }
  }
}
