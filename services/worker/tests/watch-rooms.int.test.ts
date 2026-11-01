// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch-room retention, deletion and export (ADR 0017 decision 1) against real Postgres: a room
 * ended 31 days ago is deleted with its members and messages, one ended 29 days ago is kept, a
 * report's evidence survives; empty and offline rooms are ended and announced; account deletion
 * removes the user's room data and ends the rooms they host; the export holds only the user's own.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS, RoomControlMessage } from "@commonair/contracts";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createValkey } from "@commonair/service";
import type { WorkerContext } from "../src/context.ts";
import { deleteRoomData } from "../src/deletion/watch-rooms.ts";
import { WATCH_ROOM_EXPORT_FILES } from "../src/exports/watch-rooms.ts";
import { roomControlChannel, runRetention } from "../src/watch-rooms/retention.ts";
import { makeBroadcast, makeUser, setup, VALKEY_URL, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
let ctx: WorkerContext;
const sub = createValkey(VALKEY_URL, { name: "watch-rooms-sub" });
const control: RoomControlMessage[] = [];
const DAY = 86_400_000;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
  ctx = env.worker.ctx;
  await sub.subscribe(roomControlChannel(ctx.busChannel));
  sub.on("message", (_c: string, raw: string) => {
    const m = RoomControlMessage.safeParse(JSON.parse(raw));
    if (m.success) control.push(m.data);
  });
});
afterAll(async () => {
  await sub.quit();
  await env.close();
});

const db = (): Database => env.t.db;

async function adult(name?: string) {
  const made = await makeUser(db(), name);
  await db().update(schema.users).set({ birthDate: "1990-01-01" }).where(eq(schema.users.id, made.user.id));
  return made;
}

/** A room on a live broadcast of a fresh channel, hosted by a fresh adult. */
async function room(opts: { endedDaysAgo?: number; live?: boolean } = {}) {
  const owner = await adult();
  const b = await makeBroadcast(db(), owner.channel.id);
  if (opts.live !== false)
    await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, owner.channel.id));
  const host = await adult();
  const id = uuidv7();
  const ended = opts.endedDaysAgo !== undefined ? new Date(Date.now() - opts.endedDaysAgo * DAY) : null;
  await db()
    .insert(schema.watchRooms)
    .values({
      id,
      hostId: host.user.id,
      channelId: owner.channel.id,
      broadcastId: b.id,
      ageBand: "adult",
      inviteHash: ended ? null : "a".repeat(64).slice(0, 48) + id.replace(/-/g, "").slice(16),
      createdAt: ended ? new Date(ended.getTime() - 3_600_000) : new Date(),
      endedAt: ended,
      endReason: ended ? "host_closed" : null,
    });
  return { id, host: host.user, channelId: owner.channel.id, slug: owner.channel.slug, broadcastId: b.id };
}

describe("retention", () => {
  test("a room ended 31 days ago is deleted with its rows; 29 days ago is kept; evidence survives", async () => {
    const old = await room();
    await db().insert(schema.watchRoomMembers).values({ roomId: old.id, userId: old.host.id });
    await db().insert(schema.watchRoomMessages).values({ roomId: old.id, authorId: old.host.id, body: "old words" });
    // A report filed while the room existed keeps its own copy.
    const reporter = await adult();
    const [report] = await db()
      .insert(schema.reports)
      .values({
        reporterId: reporter.user.id,
        subjectType: "watch_room",
        subjectId: old.id,
        channelId: null,
        reason: "harassment",
        evidence: { v: 1, roomId: old.id, messages: [{ userId: old.host.id, body: "old words" }] },
      })
      .returning({ id: schema.reports.id });
    // End it and move it 31 days back, as the harness hook does.
    await db()
      .update(schema.watchRooms)
      .set({ endedAt: new Date(Date.now() - 31 * DAY), endReason: "host_closed", inviteHash: null })
      .where(eq(schema.watchRooms.id, old.id));
    await db()
      .update(schema.watchRoomMembers)
      .set({ leftAt: new Date() })
      .where(eq(schema.watchRoomMembers.roomId, old.id));
    const recent = await room({ endedDaysAgo: 29 });

    const result = await runRetention(ctx);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, old.id))).toEqual([]);
    expect(
      await db().select().from(schema.watchRoomMessages).where(eq(schema.watchRoomMessages.roomId, old.id)),
    ).toEqual([]);
    expect(await db().select().from(schema.watchRoomMembers).where(eq(schema.watchRoomMembers.roomId, old.id))).toEqual(
      [],
    );
    expect(await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, recent.id))).toHaveLength(1);
    const [kept] = await db().select().from(schema.reports).where(eq(schema.reports.id, report!.id));
    expect(kept!.evidence).toMatchObject({ roomId: old.id, messages: [{ body: "old words" }] });
  });

  test("an open room empty for 10 minutes is ended; a fresh empty one is not", async () => {
    const stale = await room();
    await db().insert(schema.watchRoomMembers).values({ roomId: stale.id, userId: stale.host.id });
    await db()
      .update(schema.watchRoomMembers)
      .set({ leftAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.watchRoomMembers.roomId, stale.id));
    await db()
      .update(schema.watchRooms)
      .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(schema.watchRooms.id, stale.id));
    const fresh = await room();
    await db().insert(schema.watchRoomMembers).values({ roomId: fresh.id, userId: fresh.host.id });
    await db()
      .update(schema.watchRoomMembers)
      .set({ leftAt: new Date() })
      .where(eq(schema.watchRoomMembers.roomId, fresh.id));
    const busy = await room();
    await db().insert(schema.watchRoomMembers).values({ roomId: busy.id, userId: busy.host.id });

    await runRetention(ctx);
    const [s] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, stale.id));
    expect(s).toMatchObject({ endReason: "empty", inviteHash: null });
    const [f] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, fresh.id));
    expect(f!.endedAt).toBeNull();
    const [b] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, busy.id));
    expect(b!.endedAt).toBeNull();
    await expect
      .poll(() => control.some((m) => m.op === "room.close" && m.roomId === stale.id && m.reason === "empty"))
      .toBe(true);
  });

  test("an open room whose broadcast is no longer live is ended", async () => {
    const r = await room();
    await db().insert(schema.watchRoomMembers).values({ roomId: r.id, userId: r.host.id });
    await db().update(schema.channels).set({ liveBroadcastId: null }).where(eq(schema.channels.id, r.channelId));
    await runRetention(ctx);
    const [row] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, r.id));
    expect(row!.endReason).toBe("broadcast_ended");
    const open = await db()
      .select()
      .from(schema.watchRoomMembers)
      .where(and(eq(schema.watchRoomMembers.roomId, r.id), isNull(schema.watchRoomMembers.leftAt)));
    expect(open).toEqual([]);
  });

  test("roomControlChannel keeps the test prefix", () => {
    expect(roomControlChannel(`p:${BUS.events}`)).toBe(`p:${BUS.roomControl}`);
    expect(roomControlChannel(BUS.events)).toBe(BUS.roomControl);
  });
});

describe("account deletion", () => {
  test("removes the user's messages and memberships and ends the rooms they host", async () => {
    const hosted = await room();
    const other = await room();
    const user = hosted.host;
    const friend = await adult();
    await db()
      .insert(schema.watchRoomMembers)
      .values([
        { roomId: hosted.id, userId: user.id },
        { roomId: hosted.id, userId: friend.user.id },
        { roomId: other.id, userId: other.host.id },
        { roomId: other.id, userId: user.id },
      ]);
    await db()
      .insert(schema.watchRoomMessages)
      .values([
        { roomId: hosted.id, authorId: user.id, body: "mine" },
        { roomId: hosted.id, authorId: friend.user.id, body: "theirs" },
        { roomId: other.id, authorId: user.id, body: "mine too" },
      ]);

    const counts = await db().transaction((tx) => deleteRoomData(tx, user.id));
    expect(counts).toEqual({ watch_rooms_ended: 1, watch_room_messages: 2, watch_room_members: 2 });
    const [h] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, hosted.id));
    expect(h).toMatchObject({ endReason: "host_deleted", inviteHash: null });
    expect(
      await db().select().from(schema.watchRoomMessages).where(eq(schema.watchRoomMessages.authorId, user.id)),
    ).toEqual([]);
    expect(
      await db().select().from(schema.watchRoomMembers).where(eq(schema.watchRoomMembers.userId, user.id)),
    ).toEqual([]);
    // The friend's message stays (reportable until retention); their membership is closed.
    const left = await db()
      .select()
      .from(schema.watchRoomMembers)
      .where(eq(schema.watchRoomMembers.userId, friend.user.id));
    expect(left[0]!.leftAt).not.toBeNull();
    const [o] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, other.id));
    expect(o!.endedAt).toBeNull();
  });
});

describe("export", () => {
  test("the user's own rooms and messages only", async () => {
    const r = await room();
    const me = await adult();
    const friend = await adult();
    await db()
      .insert(schema.watchRoomMembers)
      .values([
        { roomId: r.id, userId: r.host.id },
        { roomId: r.id, userId: me.user.id },
        { roomId: r.id, userId: friend.user.id },
      ]);
    await db()
      .insert(schema.watchRoomMessages)
      .values([
        { roomId: r.id, authorId: me.user.id, body: "my words" },
        { roomId: r.id, authorId: friend.user.id, body: "their words" },
      ]);
    const file = WATCH_ROOM_EXPORT_FILES[0]!;
    const scope = { userId: me.user.id, channelId: null };
    const rooms = await file.sections.rooms!.query(db(), scope);
    expect(rooms).toEqual([
      expect.objectContaining({ roomId: r.id, channelSlug: r.slug, hosted: false, ageBand: "adult", leftAt: null }),
    ]);
    const messages = await file.sections.messages!.query(db(), scope);
    expect(messages.map((m) => m["body"])).toEqual(["my words"]);
    const hostRooms = await file.sections.rooms!.query(db(), { userId: r.host.id, channelId: null });
    expect(hostRooms[0]).toMatchObject({ hosted: true });
  });
});
