// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch rooms (ADR 0017, decisions (q) and (r)): create, invite, join, leave, close and list.
 *
 * Every room is invite-only in v1: create returns a nonce shown once and stored as its SHA-256
 * (`watch_rooms.invite_hash`, cleared when the room ends). Join takes the nonce and checks, in
 * order: the room is open and on a live broadcast, the person (platform ban or suspension, channel
 * ban, birth date, band, mature content and confirmation), blocks in either direction with any
 * current member, and capacity. Each refusal is a `PRECONDITION_FAILED` whose `requirement` is a
 * `WATCH_ROOM_REFUSALS` code the web translates. The 0046 trigger enforces band, mature and
 * capacity again on insert; its refusals map to the same codes, never a 500.
 *
 * Ending a room (host closes or leaves) clears the invite, sets `left_at` on every open membership
 * and tells the chat instances over `BUS.roomControl`. Refusals are logged with ids and codes only.
 */
import { ORPCError } from "@orpc/server";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { dto } from "@commonair/contracts";
import type * as dtoSchemas from "@commonair/contracts/dto";
import type { z } from "zod";
import { BUS, RoomControlMessage } from "@commonair/contracts";
import type { RoomAgeBand, RoomEndReason } from "@commonair/contracts/enums";
import { CHAT_TOKEN_TTL_SECONDS } from "@commonair/contracts/internal";
import { schema, type Executor } from "@commonair/db";
import { randomSecret, sha256Hex, signChatToken } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { channelTheme, iso, isoOrNull, mediaUrl } from "../lib/dto.ts";
import { forbidden, notFound, precondition } from "../lib/errors.ts";
import type { Caller } from "../lib/access.ts";
import {
  ageBandOn,
  hasPlace,
  personRefusal,
  platformBanOf,
  roomAudience,
  triggerRefusal,
  type PersonFacts,
  type RoomRefusal,
} from "./rules.ts";

const { watchRooms: wr, watchRoomMembers: wm, users, channels, broadcasts, chatBans, userBlocks } = schema;

type RoomRow = typeof wr.$inferSelect;
type WatchRoomInvite = z.infer<typeof dtoSchemas.WatchRoomInvite>;
type WatchRoomJoined = z.infer<typeof dtoSchemas.WatchRoomJoined>;
type ChannelRow = typeof channels.$inferSelect;

/** A refusal the web translates (`watch-room-join-refused` `data-code`). */
export function refuse(deps: Pick<Deps, "logger">, code: RoomRefusal, ids: Record<string, string>): never {
  deps.logger.info("watch room refused", { code, ...ids });
  throw precondition(code, `Watch room refused: ${code}`);
}

/** Whether the room's broadcast (channel, broadcast or either category) is mature-labelled. */
async function roomMature(db: Executor, broadcastId: string): Promise<boolean> {
  const rows = await db.execute<{ mature: boolean }>(
    sql`select public.commonair_room_mature(${broadcastId}::uuid) as mature`,
  );
  return Boolean(rows[0]?.mature);
}

/** The person facts for `userId` on `channelId` at `now`. */
async function personFacts(db: Executor, userId: string, channelId: string, now: Date): Promise<PersonFacts | null> {
  const [u] = await db
    .select({
      birthDate: users.birthDate,
      matureConfirmedAt: users.matureConfirmedAt,
      banned: users.banned,
      banExpires: users.banExpires,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.deletedAt) return null;
  const [ban] = await db
    .select({ id: chatBans.id })
    .from(chatBans)
    .where(
      and(
        eq(chatBans.channelId, channelId),
        eq(chatBans.userId, userId),
        isNull(chatBans.liftedAt),
        or(isNull(chatBans.expiresAt), gt(chatBans.expiresAt, now)),
      ),
    )
    .limit(1);
  return {
    birthDate: u.birthDate,
    matureConfirmed: u.matureConfirmedAt !== null,
    platformBan: platformBanOf(u.banned, u.banExpires, now),
    channelBanned: ban !== undefined,
  };
}

/** The live (`kind = 'live'`, not ended, the channel's current) broadcast of a channel, or null. */
async function liveBroadcast(db: Executor, channel: ChannelRow): Promise<{ id: string } | null> {
  if (!channel.liveBroadcastId || channel.suspendedAt) return null;
  const [b] = await db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.id, channel.liveBroadcastId),
        eq(broadcasts.channelId, channel.id),
        eq(broadcasts.kind, "live"),
        isNull(broadcasts.endedAt),
      ),
    );
  return b ?? null;
}

async function activeMemberIds(db: Executor, roomId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: wm.userId })
    .from(wm)
    .where(and(eq(wm.roomId, roomId), isNull(wm.leftAt)));
  return rows.map((r) => r.userId);
}

/** Whether `userId` and any of `others` blocked each other, in either direction. */
async function blockedWithAny(db: Executor, userId: string, others: readonly string[]): Promise<boolean> {
  const ids = others.filter((o) => o !== userId);
  if (ids.length === 0) return false;
  const [row] = await db
    .select({ u: userBlocks.userId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.userId, userId), inArray(userBlocks.blockedUserId, ids)),
        and(inArray(userBlocks.userId, ids), eq(userBlocks.blockedUserId, userId)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** End an open room (idempotent): clear the invite and close every open membership. True if it ended now. */
export async function endRoomInTx(tx: Executor, roomId: string, reason: RoomEndReason, now: Date): Promise<boolean> {
  const ended = await tx
    .update(wr)
    .set({ endedAt: now, endReason: reason, inviteHash: null })
    .where(and(eq(wr.id, roomId), isNull(wr.endedAt)))
    .returning({ id: wr.id });
  if (ended.length === 0) return false;
  await tx
    .update(wm)
    .set({ leftAt: now })
    .where(and(eq(wm.roomId, roomId), isNull(wm.leftAt)));
  return true;
}

/** Tell every chat instance (ids and enums only). A lost message is caught at the next send or join. */
export async function publishRoomControl(deps: Pick<Deps, "valkey" | "logger">, msg: RoomControlMessage) {
  const parsed = RoomControlMessage.parse(msg);
  try {
    await deps.valkey.publish(BUS.roomControl, JSON.stringify(parsed));
  } catch (err) {
    deps.logger.warn("room control publish failed", { op: parsed.op, roomId: parsed.roomId, err });
  }
}

/** The invite link: the channel page with `?room=<id>&invite=<nonce>` (the drawer's join landing). */
function inviteOf(deps: Pick<Deps, "env">, slug: string, roomId: string, nonce: string): WatchRoomInvite {
  const url = new URL(`/${encodeURIComponent(slug)}`, deps.env.PUBLIC_URL);
  url.searchParams.set("room", roomId);
  url.searchParams.set("invite", nonce);
  return { nonce, url: url.toString(), expiresAt: null };
}

/** The API view of a room: its channel, host and active members (`ChannelAvatar` data). */
export async function roomView(deps: Deps, room: RoomRow): Promise<dto.WatchRoom> {
  const db = deps.db;
  const [[channel], members, mature] = await Promise.all([
    db
      .select({ c: channels, ownerImage: users.image })
      .from(channels)
      .innerJoin(users, eq(users.id, channels.ownerId))
      .where(eq(channels.id, room.channelId)),
    db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        image: users.image,
        joinedAt: wm.joinedAt,
      })
      .from(wm)
      .innerJoin(users, eq(users.id, wm.userId))
      .where(and(eq(wm.roomId, room.id), isNull(wm.leftAt)))
      .orderBy(asc(wm.joinedAt)),
    roomMature(db, room.broadcastId),
  ]);
  if (!channel) throw notFound("Room not found");
  const [host] = await db
    .select({ id: users.id, username: users.username, name: users.name, image: users.image })
    .from(users)
    .where(eq(users.id, room.hostId));
  if (!host) throw notFound("Room not found");
  const avatar = (u: { id: string; username: string; name: string; image: string | null }) => ({
    id: u.id,
    username: u.username,
    displayName: u.name,
    avatarUrl: mediaUrl(deps, u.image),
  });
  const c = channel.c;
  return {
    id: room.id,
    channel: {
      id: c.id,
      slug: c.slug,
      displayName: c.displayName,
      avatarUrl: mediaUrl(deps, channelTheme(c).avatarKey) ?? mediaUrl(deps, channel.ownerImage),
    },
    broadcastId: room.broadcastId,
    host: avatar(host),
    ageBand: room.ageBand,
    mature,
    members: members.map((m) => ({ user: avatar(m), joinedAt: iso(m.joinedAt), host: m.id === room.hostId })),
    createdAt: iso(room.createdAt),
    endedAt: isoOrNull(room.endedAt),
    endReason: room.endReason,
    chatAudience: roomAudience(room.id),
  };
}

async function loadRoom(db: Executor, id: string): Promise<RoomRow | null> {
  const [room] = await db.select().from(wr).where(eq(wr.id, id));
  return room ?? null;
}

async function isActiveMember(db: Executor, roomId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: wm.id })
    .from(wm)
    .where(and(eq(wm.roomId, roomId), eq(wm.userId, userId), isNull(wm.leftAt)))
    .limit(1);
  return row !== undefined;
}

/** Run `fn` and turn the trigger's refusal into the API's code (never a 500). */
async function underTrigger<T>(
  deps: Deps,
  band: RoomAgeBand | null,
  ids: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ORPCError) throw err;
    const code = triggerRefusal(err, band);
    if (code) refuse(deps, code, { ...ids, by: "trigger" });
    throw err;
  }
}

/** `watchRooms.create`: open a room on the channel's live broadcast; the host is its first member. */
export async function createRoom(
  deps: Deps,
  caller: Caller,
  slug: string,
): Promise<dto.WatchRoom & { invite: WatchRoomInvite }> {
  const now = deps.now();
  const userId = caller.user.id;
  const [channel] = await deps.db.select().from(channels).where(eq(channels.slug, slug.toLowerCase()));
  if (!channel) throw notFound("Channel not found");
  const ids = { userId, channelId: channel.id };
  if (caller.user.suspended) refuse(deps, "room_suspended", ids);
  const live = await liveBroadcast(deps.db, channel);
  if (!live) refuse(deps, "room_not_live", ids);
  const facts = await personFacts(deps.db, userId, channel.id, now);
  if (!facts) throw notFound("User not found");
  const mature = await roomMature(deps.db, live.id);
  const refusal = personRefusal(facts, { band: null, mature }, now);
  if (refusal) refuse(deps, refusal, ids);
  // personRefusal returned null, so the band is known.
  const band = ageBandOn(facts.birthDate, now) ?? "minor";

  const nonce = randomSecret("", 24);
  const inviteHash = await sha256Hex(nonce);
  const { room, previous } = await underTrigger(deps, band, ids, () =>
    deps.db.transaction(async (tx) => {
      // One open room per host: a new room ends the previous one.
      const open = await tx
        .select({ id: wr.id })
        .from(wr)
        .where(and(eq(wr.hostId, userId), isNull(wr.endedAt)));
      for (const o of open) await endRoomInTx(tx, o.id, "host_left", now);
      const [created] = await tx
        .insert(wr)
        .values({
          hostId: userId,
          channelId: channel.id,
          broadcastId: live.id,
          ageBand: band,
          inviteHash,
          createdAt: now,
        })
        .returning();
      if (!created) throw new Error("watch_rooms insert returned nothing");
      await tx.insert(wm).values({ roomId: created.id, userId, joinedAt: now });
      return { room: created, previous: open.map((o) => o.id) };
    }),
  );
  for (const id of previous) await publishRoomControl(deps, { op: "room.close", roomId: id, reason: "host_left" });
  deps.logger.info("watch room created", { roomId: room.id, channelId: channel.id, band });
  return { ...(await roomView(deps, room)), invite: inviteOf(deps, channel.slug, room.id, nonce) };
}

/** `watchRooms.get`: a room the caller is an active member of. */
export async function getRoom(deps: Deps, caller: Caller, id: string): Promise<dto.WatchRoom> {
  const room = await loadRoom(deps.db, id);
  if (!room || !(await isActiveMember(deps.db, id, caller.user.id))) throw notFound("Room not found");
  return roomView(deps, room);
}

/** `watchRooms.invite`: the host replaces the invite (the old link stops working). */
export async function newInvite(deps: Deps, caller: Caller, id: string): Promise<WatchRoomInvite> {
  const room = await loadRoom(deps.db, id);
  if (!room || room.hostId !== caller.user.id) throw notFound("Room not found");
  if (room.endedAt) refuse(deps, "room_closed", { roomId: id, userId: caller.user.id });
  const nonce = randomSecret("", 24);
  const updated = await deps.db
    .update(wr)
    .set({ inviteHash: await sha256Hex(nonce) })
    .where(and(eq(wr.id, id), isNull(wr.endedAt)))
    .returning({ id: wr.id });
  if (updated.length === 0) refuse(deps, "room_closed", { roomId: id, userId: caller.user.id });
  const [channel] = await deps.db.select({ slug: channels.slug }).from(channels).where(eq(channels.id, room.channelId));
  if (!channel) throw notFound("Room not found");
  return inviteOf(deps, channel.slug, id, nonce);
}

/** A room chat token: the caller's id with the room's audience as its only scope. */
async function roomToken(deps: Deps, userId: string, roomId: string): Promise<{ token: string; expiresAt: string }> {
  const exp = Math.floor(deps.now().getTime() / 1000) + CHAT_TOKEN_TTL_SECONDS;
  const token = await signChatToken(deps.env.INTERNAL_API_SECRET, {
    v: 1,
    uid: userId,
    app: null,
    scopes: [roomAudience(roomId)],
    exp,
  });
  return { token, expiresAt: iso(new Date(exp * 1000)) };
}

/**
 * `watchRooms.join`: an active member gets a fresh chat token (reconnects); anyone else needs the
 * current invite and passes every check.
 */
export async function joinRoom(deps: Deps, caller: Caller, id: string, nonce: string): Promise<WatchRoomJoined> {
  const now = deps.now();
  const userId = caller.user.id;
  const ids = { roomId: id, userId };
  const room = await loadRoom(deps.db, id);
  if (!room) refuse(deps, "room_invite_invalid", ids);
  const joined = async (): Promise<WatchRoomJoined> => {
    const fresh = (await loadRoom(deps.db, id)) ?? room;
    const t = await roomToken(deps, userId, id);
    return {
      room: await roomView(deps, fresh),
      chatToken: t.token,
      chatUrl: deps.env.CHAT_PUBLIC_URL,
      expiresAt: t.expiresAt,
    };
  };
  if (room.endedAt) refuse(deps, "room_closed", ids);
  const member = await isActiveMember(deps.db, id, userId);
  if (!member && room.inviteHash !== (await sha256Hex(nonce))) refuse(deps, "room_invite_invalid", ids);
  if (caller.user.suspended) refuse(deps, "room_suspended", ids);

  // The broadcast ended without the room hearing of it: end it now.
  const [channel] = await deps.db.select().from(channels).where(eq(channels.id, room.channelId));
  const live = channel ? await liveBroadcast(deps.db, channel) : null;
  if (!live || live.id !== room.broadcastId) {
    if (await deps.db.transaction((tx) => endRoomInTx(tx, id, "broadcast_ended", now)))
      await publishRoomControl(deps, { op: "room.close", roomId: id, reason: "broadcast_ended" });
    refuse(deps, "room_closed", ids);
  }

  // Re-checked for members too: a member whose band or standing changed is removed.
  const facts = await personFacts(deps.db, userId, room.channelId, now);
  if (!facts) throw notFound("User not found");
  const mature = await roomMature(deps.db, room.broadcastId);
  const refusal = personRefusal(facts, { band: room.ageBand, mature }, now);
  if (refusal) {
    if (member) await removeMember(deps, room, userId, refusal, now);
    refuse(deps, refusal, ids);
  }
  if (member) return joined();

  const members = await activeMemberIds(deps.db, id);
  if (await blockedWithAny(deps.db, userId, members)) refuse(deps, "room_blocked", ids);
  if (!hasPlace(members.length)) refuse(deps, "room_full", ids);

  const band = ageBandOn(facts.birthDate, now);
  await underTrigger(deps, band, ids, () =>
    deps.db.transaction(async (tx) => {
      // The trigger locks the room row; re-check blocks under it so a racing join cannot slip past.
      await tx.execute(sql`select 1 from ${wr} where ${wr.id} = ${id} for update`);
      if (await blockedWithAny(tx, userId, await activeMemberIds(tx, id))) refuse(deps, "room_blocked", ids);
      await tx.insert(wm).values({ roomId: id, userId, joinedAt: now });
    }),
  );
  deps.logger.info("watch room joined", ids);
  return joined();
}

/** Remove a member whose standing changed (or end the room when it is the host). */
async function removeMember(deps: Deps, room: RoomRow, userId: string, why: RoomRefusal, now: Date) {
  if (room.hostId === userId) {
    if (await deps.db.transaction((tx) => endRoomInTx(tx, room.id, "moderation", now)))
      await publishRoomControl(deps, { op: "room.close", roomId: room.id, reason: "moderation" });
    return;
  }
  await deps.db
    .update(wm)
    .set({ leftAt: now })
    .where(and(eq(wm.roomId, room.id), eq(wm.userId, userId), isNull(wm.leftAt)));
  const reason =
    why === "room_suspended"
      ? "suspended"
      : why === "room_banned"
        ? "banned"
        : why === "room_blocked"
          ? "blocked"
          : "age_band";
  await publishRoomControl(deps, { op: "room.kick", roomId: room.id, userId, reason });
}

/** `watchRooms.leave`: a member leaves; the host leaving ends the room. */
export async function leaveRoom(deps: Deps, caller: Caller, id: string): Promise<void> {
  const now = deps.now();
  const room = await loadRoom(deps.db, id);
  if (!room || !(await isActiveMember(deps.db, id, caller.user.id))) throw notFound("Room not found");
  if (room.hostId === caller.user.id) {
    if (await deps.db.transaction((tx) => endRoomInTx(tx, id, "host_left", now)))
      await publishRoomControl(deps, { op: "room.close", roomId: id, reason: "host_left" });
    return;
  }
  await deps.db
    .update(wm)
    .set({ leftAt: now })
    .where(and(eq(wm.roomId, id), eq(wm.userId, caller.user.id), isNull(wm.leftAt)));
  await publishRoomControl(deps, { op: "room.kick", roomId: id, userId: caller.user.id, reason: "left" });
}

/** `watchRooms.close`: the host ends the room. */
export async function closeRoom(deps: Deps, caller: Caller, id: string): Promise<void> {
  const room = await loadRoom(deps.db, id);
  if (!room) throw notFound("Room not found");
  if (room.hostId !== caller.user.id) {
    if (await isActiveMember(deps.db, id, caller.user.id)) throw forbidden("Only the host can close the room");
    throw notFound("Room not found");
  }
  if (await deps.db.transaction((tx) => endRoomInTx(tx, id, "host_closed", deps.now())))
    await publishRoomControl(deps, { op: "room.close", roomId: id, reason: "host_closed" });
}

/** `watchRooms.mine`: open rooms the caller is an active member of (hosts are members). */
export async function myRooms(deps: Deps, caller: Caller): Promise<dto.WatchRoom[]> {
  const rows = await deps.db
    .select({ room: wr })
    .from(wr)
    .innerJoin(wm, and(eq(wm.roomId, wr.id), eq(wm.userId, caller.user.id), isNull(wm.leftAt)))
    .where(isNull(wr.endedAt))
    .orderBy(asc(wr.createdAt));
  return Promise.all(rows.map((r) => roomView(deps, r.room)));
}
