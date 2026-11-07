// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch rooms in chat (ADR 0017, decisions (q) and (r)) against real Postgres and Valkey, across
 * two chat instances: messages reach members only, run the host channel's filters and are
 * persisted; the sync target is computed and capped; joins re-check the band and standing; the
 * watcher ends rooms and removes members from bus events.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { BUS, type ServerFrame } from "@commonair/contracts";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { schema, uuidv7 } from "@commonair/db";
import { createValkey } from "@commonair/service";
import { signChatToken } from "@commonair/tokens";
import type { WatchRoomDeps } from "../src/core.ts";
import type { ChatService } from "../src/server.ts";
import { WatchRooms } from "../src/watch-rooms.ts";
import {
  chatToken,
  Client,
  createChannel,
  createUser,
  eventually,
  isolation,
  SECRET,
  startInstance,
  VALKEY_URL,
} from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ADULT = "1990-05-05";
const MINOR = "2012-03-04";

let t: TestDatabase;
let a: ChatService;
let b: ChatService;
const iso = isolation();
const pub = createValkey(VALKEY_URL, { name: "watch-rooms-pub" });
const fast = (deps: WatchRoomDeps) => new WatchRooms({ ...deps, syncTickMs: 200 } as WatchRoomDeps);

beforeAll(async () => {
  t = await createTestDatabase();
  [a, b] = await Promise.all([
    startInstance(t.db, iso, { watchRooms: fast }),
    startInstance(t.db, iso, { watchRooms: fast }),
  ]);
});
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()]);
  await pub.quit();
  await t?.drop();
});

interface Room {
  id: string;
  channelId: string;
  slug: string;
  broadcastId: string;
  host: { id: string; username: string };
}

async function liveChannel(opts: { mature?: boolean } = {}) {
  const owner = await createUser(t.db, { birthDate: ADULT });
  const ch = await createChannel(t.db, owner);
  if (opts.mature) await t.db.update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, ch.id));
  const [br] = await t.db
    .insert(schema.broadcasts)
    .values({ channelId: ch.id, ingestProtocol: "rtmp", path: `live/${ch.slug}` })
    .returning({ id: schema.broadcasts.id });
  await t.db.update(schema.channels).set({ liveBroadcastId: br!.id }).where(eq(schema.channels.id, ch.id));
  return { ...ch, broadcastId: br!.id, owner };
}

async function room(band: "adult" | "minor" = "adult", ch?: Awaited<ReturnType<typeof liveChannel>>): Promise<Room> {
  const live = ch ?? (await liveChannel());
  const host = await createUser(t.db, { birthDate: band === "adult" ? ADULT : MINOR });
  const id = uuidv7();
  await t.db.insert(schema.watchRooms).values({
    id,
    hostId: host.id,
    channelId: live.id,
    broadcastId: live.broadcastId,
    ageBand: band,
    inviteHash: "0".repeat(48) + id.replace(/-/g, "").slice(0, 16),
  });
  await t.db.insert(schema.watchRoomMembers).values({ roomId: id, userId: host.id });
  return { id, channelId: live.id, slug: live.slug, broadcastId: live.broadcastId, host };
}

async function member(r: Room, birthDate = ADULT) {
  const u = await createUser(t.db, { birthDate });
  await t.db.insert(schema.watchRoomMembers).values({ roomId: r.id, userId: u.id });
  return u;
}

/** A room token as the API mints it (`watchRooms.join`); chat checks its signature and audience. */
const roomToken = (userId: string, roomId: string) =>
  signChatToken(SECRET, {
    v: 1,
    uid: userId,
    app: null,
    scopes: [`room:${roomId}`],
    exp: Math.floor(Date.now() / 1000) + 300,
  });

async function joined(svc: ChatService, userId: string, roomId: string): Promise<Client> {
  const c = await Client.connect(svc, { token: await chatToken(userId) });
  c.send({ op: "room.join", roomId, token: await roomToken(userId, roomId), nonce: "j" });
  await c.waitFor((f) => f.op === "room.state" && f.roomId === roomId);
  return c;
}

const notice = (c: Client, nonce: string) =>
  c.waitFor<"notice">((f) => f.op === "notice" && (f as { nonce?: string }).nonce === nonce);

describe("membership", () => {
  test("a non-member and a stranger to the room are refused with room_closed", async () => {
    const r = await room();
    const stranger = await createUser(t.db, { birthDate: ADULT });
    const c = await Client.connect(a, { token: await chatToken(stranger.id) });
    c.send({ op: "room.join", roomId: r.id, token: await roomToken(stranger.id, r.id), nonce: "n1" });
    expect(await notice(c, "n1")).toMatchObject({ code: "room_closed" });
    c.send({ op: "room.join", roomId: uuidv7(), token: "x", nonce: "n2" });
    expect(await notice(c, "n2")).toMatchObject({ code: "room_closed" });
    c.send({ op: "room.send", roomId: r.id, body: "hi", nonce: "n3" });
    expect(await notice(c, "n3")).toMatchObject({ code: "room_closed" });
    c.close();
  });

  test("room.state lists connected members on both instances", async () => {
    const r = await room();
    const m = await member(r);
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, m.id, r.id);
    const state = await h.waitFor<"room.state">((f) => f.op === "room.state" && f.members.length === 2, 3000);
    expect(state).toMatchObject({ hostId: r.host.id, ageBand: "adult" });
    expect(state.members.map((x) => x.id).sort()).toEqual([r.host.id, m.id].sort());
    g.close();
    await h.waitFor((f) => f.op === "room.state" && f.members.length === 1, 3000, { includePast: false });
    h.close();
  });

  test("a member whose band changed is removed at reconnect", async () => {
    const r = await room();
    const m = await member(r);
    // A data fix: the birth date now makes them a minor.
    await t.db.update(schema.users).set({ birthDate: MINOR }).where(eq(schema.users.id, m.id));
    const c = await Client.connect(a, { token: await chatToken(m.id) });
    c.send({ op: "room.join", roomId: r.id, token: await roomToken(m.id, r.id), nonce: "j" });
    expect(await notice(c, "j")).toMatchObject({ code: "room_age_band" });
    const open = await t.db
      .select()
      .from(schema.watchRoomMembers)
      .where(
        and(
          eq(schema.watchRoomMembers.roomId, r.id),
          eq(schema.watchRoomMembers.userId, m.id),
          isNull(schema.watchRoomMembers.leftAt),
        ),
      );
    expect(open).toEqual([]);
    c.close();
  });

  test("a block between members does not remove either at reconnect; a channel ban does", async () => {
    // Blocks are checked at first join only (API, ADR 0017): the host who blocks a member and
    // refreshes keeps the room, and a member cannot end it by blocking the host.
    const r = await room();
    const m = await member(r);
    await t.db.insert(schema.userBlocks).values({ userId: r.host.id, blockedUserId: m.id });
    await t.db.insert(schema.userBlocks).values({ userId: m.id, blockedUserId: r.host.id });
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, m.id, r.id);
    const [row] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, r.id));
    expect(row!.endedAt).toBeNull();
    h.close();
    g.close();

    const banned = await member(r);
    await t.db.insert(schema.chatBans).values({ channelId: r.channelId, userId: banned.id });
    const d = await Client.connect(a, { token: await chatToken(banned.id) });
    d.send({ op: "room.join", roomId: r.id, token: await roomToken(banned.id, r.id), nonce: "j" });
    expect(await notice(d, "j")).toMatchObject({ code: "room_banned" });
    d.close();
  });

  test("the room token's signature, owner and audience are checked", async () => {
    const r = await room();
    const iso2 = isolation();
    const svc = await startInstance(t.db, iso2, {
      watchRooms: (deps) => new WatchRooms({ ...deps, internalSecret: SECRET } as WatchRoomDeps),
    });
    try {
      const c = await Client.connect(svc, { token: await chatToken(r.host.id) });
      c.send({ op: "room.join", roomId: r.id, token: "forged", nonce: "f" });
      expect(await notice(c, "f")).toMatchObject({ code: "room_closed" });
      const other = await signChatToken(SECRET, {
        v: 1,
        uid: r.host.id,
        app: null,
        scopes: [`room:${uuidv7()}`],
        exp: Math.floor(Date.now() / 1000) + 300,
      });
      c.send({ op: "room.join", roomId: r.id, token: other, nonce: "o" });
      expect(await notice(c, "o")).toMatchObject({ code: "room_closed" });
      const good = await signChatToken(SECRET, {
        v: 1,
        uid: r.host.id,
        app: null,
        scopes: [`room:${r.id}`],
        exp: Math.floor(Date.now() / 1000) + 300,
      });
      c.send({ op: "room.join", roomId: r.id, token: good, nonce: "g" });
      await c.waitFor((f) => f.op === "room.state" && f.roomId === r.id);
      c.close();
    } finally {
      await svc.stop();
    }
  });
});

describe("room chat", () => {
  test("messages reach members only, never channel chat, and are persisted", async () => {
    const r = await room();
    const m = await member(r);
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, m.id, r.id);
    // A channel chat viewer of the same channel on the same instance.
    const viewer = await createUser(t.db, { birthDate: ADULT });
    const v = await Client.connect(a, { token: await chatToken(viewer.id) });
    await v.join(r.slug);

    h.send({ op: "room.send", roomId: r.id, body: "hello room", nonce: "s" });
    const got = await g.waitFor<"room.message">((f) => f.op === "room.message" && f.message.body === "hello room");
    expect(got.message.user.id).toBe(r.host.id);
    await h.waitFor((f) => f.op === "room.message" && f.message.id === got.message.id);
    expect(
      await v.never((f) => f.op === "room.message" || (f.op === "message" && f.message.body === "hello room")),
    ).toBe(true);
    const rows = await t.db.select().from(schema.watchRoomMessages).where(eq(schema.watchRoomMessages.roomId, r.id));
    expect(rows.map((x) => [x.id, x.authorId, x.body])).toEqual([[got.message.id, r.host.id, "hello room"]]);
    // A late joiner gets the backlog.
    const late = await member(r);
    const l = await joined(a, late.id, r.id);
    await l.waitFor((f) => f.op === "room.message" && f.message.id === got.message.id);
    for (const c of [h, g, v, l]) c.close();
  });

  test("the host channel's word filters run; a held message is refused too; nothing is persisted", async () => {
    const r = await room();
    await t.db.insert(schema.wordFilters).values([
      { channelId: r.channelId, pattern: "forbidden", action: "block" },
      { channelId: r.channelId, pattern: "suspicious", action: "hold" },
    ]);
    const h = await joined(a, r.host.id, r.id);
    h.send({ op: "room.send", roomId: r.id, body: "a forbidden word", nonce: "b" });
    expect(await notice(h, "b")).toMatchObject({ code: "msg_rejected" });
    h.send({ op: "room.send", roomId: r.id, body: "something suspicious", nonce: "h" });
    expect(await notice(h, "h")).toMatchObject({ code: "msg_rejected" });
    const rows = await t.db.select().from(schema.watchRoomMessages).where(eq(schema.watchRoomMessages.roomId, r.id));
    expect(rows).toEqual([]);
    h.close();
  });

  test("the host channel's link rule applies to room messages", async () => {
    const r = await room();
    await t.db.execute(
      sql`update channels set chat_settings = chat_settings || '{"linksAllowed": false}'::jsonb where id = ${r.channelId}::uuid`,
    );
    const m = await member(r);
    const g = await joined(a, m.id, r.id);
    g.send({ op: "room.send", roomId: r.id, body: "see https://example.test/x", nonce: "l" });
    expect(await notice(g, "l")).toMatchObject({ code: "msg_links_blocked" });
    g.close();
  });

  test("a platform-banned member cannot send", async () => {
    const r = await room();
    const m = await member(r);
    const g = await joined(a, m.id, r.id);
    await t.db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, m.id));
    // The profile cache is short; ask the instance to drop it as the API would.
    await pub.publish(
      iso.busPrefix + BUS.userControl,
      JSON.stringify({ op: "invalidate", userId: m.id, reason: "profile_changed" }),
    );
    const refused = await eventually(async () => {
      g.send({ op: "room.send", roomId: r.id, body: `try ${crypto.randomUUID()}`, nonce: "x" });
      const n = await g.waitFor<"notice">((f) => f.op === "notice", 1000, { includePast: false }).catch(() => null);
      return n?.code === "room_banned";
    }, 5000);
    expect(refused).toBe(true);
    g.close();
  });
});

describe("sync", () => {
  test("members get the slowest live playhead, capped 5 s behind the most advanced", async () => {
    const r = await room();
    const m = await member(r);
    const dvr = await member(r);
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, m.id, r.id);
    const d = await joined(a, dvr.id, r.id);
    const now = Date.now();
    h.send({ op: "room.sync", roomId: r.id, playheadWallclock: new Date(now - 6000).toISOString(), mode: "live" });
    g.send({ op: "room.sync", roomId: r.id, playheadWallclock: new Date(now - 8000).toISOString(), mode: "live" });
    d.send({ op: "room.sync", roomId: r.id, playheadWallclock: new Date(now - 600_000).toISOString(), mode: "dvr" });
    const target = await g.waitFor<"room.sync">((f) => f.op === "room.sync" && f.roomId === r.id, 3000, {
      includePast: false,
    });
    const behind = Date.now() - Date.parse(target.target);
    expect(behind).toBeGreaterThan(7000);
    expect(behind).toBeLessThan(9500);

    // A member 30 s behind is capped: the target stays within 5 s of the leader.
    g.send({
      op: "room.sync",
      roomId: r.id,
      playheadWallclock: new Date(Date.now() - 30_000).toISOString(),
      mode: "live",
    });
    h.send({
      op: "room.sync",
      roomId: r.id,
      playheadWallclock: new Date(Date.now() - 6000).toISOString(),
      mode: "live",
    });
    const capped = await eventually(async () => {
      const f = await h.waitFor<"room.sync">((x) => x.op === "room.sync", 3000, { includePast: false });
      const lag = Date.now() - Date.parse(f.target);
      return lag > 10_000 && lag < 12_500 ? lag : null;
    }, 6000);
    expect(capped).toBeGreaterThan(10_000);
    for (const c of [h, g, d]) c.close();
  });

  test("batch 8: the cap is measured from max(edgeWallclock); a future edge is dropped", async () => {
    const r = await room();
    const m = await member(r);
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, m.id, r.id);
    const report = (c: Client, headAgo: number, edgeAgo: number) =>
      c.send({
        op: "room.sync",
        roomId: r.id,
        playheadWallclock: new Date(Date.now() - headAgo).toISOString(),
        mode: "live",
        edgeWallclock: new Date(Date.now() - edgeAgo).toISOString(),
      });
    // Edges 1 s and 3 s back; the slow member 20 s back: capped 5 s behind the 1 s edge, not the leader.
    report(h, 6000, 3000);
    report(g, 20_000, 1000);
    const lag = await eventually(async () => {
      const f = await g.waitFor<"room.sync">((x) => x.op === "room.sync", 3000, { includePast: false });
      const behind = Date.now() - Date.parse(f.target);
      return behind > 5000 && behind < 7500 ? behind : null;
    }, 6000);
    expect(lag).toBeGreaterThan(5000);

    // A member claiming an edge a minute in the future cannot pull the room forward.
    report(h, 6000, -60_000);
    report(g, 20_000, 20_000);
    const held = await eventually(async () => {
      const f = await h.waitFor<"room.sync">((x) => x.op === "room.sync", 3000, { includePast: false });
      const behind = Date.now() - Date.parse(f.target);
      return behind > 10_000 && behind < 12_500 ? behind : null;
    }, 6000);
    expect(held).toBeGreaterThan(10_000);
    for (const c of [h, g]) c.close();
  });

  test("the target stays where every live member has buffered to (watch-room CI run 42333642371)", async () => {
    const r = await room();
    const m = await member(r);
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, m.id, r.id);
    const report = (c: Client, headAgo: number, bufferedAgo: number | undefined) =>
      c.send({
        op: "room.sync",
        roomId: r.id,
        playheadWallclock: new Date(Date.now() - headAgo).toISOString(),
        mode: "live",
        edgeWallclock: new Date(Date.now() - 50).toISOString(),
        ...(bufferedAgo === undefined ? {} : { bufferedWallclock: new Date(Date.now() - bufferedAgo).toISOString() }),
      });
    // The host on the cap point with plenty buffered; the member 6.66 s behind with 1.2 s buffered.
    report(h, 5000, 400);
    report(g, 6660, 5460);
    const lag = await eventually(async () => {
      const f = await g.waitFor<"room.sync">((x) => x.op === "room.sync", 3000, { includePast: false });
      const behind = Date.now() - Date.parse(f.target);
      // Its buffer's end less the 1.5 s spare (6.96 s), not the capped 5.05 s.
      return behind > 6700 && behind < 7700 ? behind : null;
    }, 6000);
    expect(lag).toBeGreaterThan(6700);
    for (const c of [h, g]) c.close();
  });
});

describe("empty rooms", () => {
  test("a room nobody is connected to ends after the wait; a member returning cancels it", async () => {
    const iso2 = isolation();
    const svc = await startInstance(t.db, iso2, {
      watchRooms: (deps) => new WatchRooms({ ...deps, emptyEndMs: 400 } as WatchRoomDeps),
    });
    try {
      const r = await room();
      const c = await joined(svc, r.host.id, r.id);
      c.close();
      const ended = await eventually(async () => {
        const [row] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, r.id));
        return row?.endedAt ? row.endReason : null;
      }, 5000);
      expect(ended).toBe("empty");

      const back = await room();
      const first = await joined(svc, back.host.id, back.id);
      first.close();
      const again = await joined(svc, back.host.id, back.id);
      await Bun.sleep(900);
      const [row] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, back.id));
      expect(row!.endedAt).toBeNull();
      again.close();
    } finally {
      await svc.stop();
    }
  });
});

describe("watcher", () => {
  const event = (type: string, channelId: string, payload: Record<string, unknown> = {}) =>
    pub.publish(
      iso.busPrefix + BUS.events,
      JSON.stringify({ id: uuidv7(), type, version: "1", channelId, payload, occurredAt: new Date().toISOString() }),
    );

  test("the broadcast ending ends the room and tells its members", async () => {
    const r = await room();
    const m = await member(r);
    const g = await joined(b, m.id, r.id);
    await event("stream.offline", r.channelId);
    const closed = await g.waitFor<"room.closed">((f) => f.op === "room.closed" && f.roomId === r.id);
    expect(closed.reason).toBe("broadcast_ended");
    const [row] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, r.id));
    expect(row).toMatchObject({ endReason: "broadcast_ended", inviteHash: null });
    g.close();
  });

  test("the channel turning mature ends its minor rooms, not its adult ones", async () => {
    const ch = await liveChannel();
    const minor = await room("minor", ch);
    const adult = await room("adult", ch);
    await t.db.update(schema.users).set({ matureConfirmedAt: new Date() }).where(eq(schema.users.id, adult.host.id));
    const c = await joined(a, minor.host.id, minor.id);
    await t.db.update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, ch.id));
    await event("channel.update", ch.id, { mature: true });
    const closed = await c.waitFor<"room.closed">((f) => f.op === "room.closed");
    expect(closed.reason).toBe("mature");
    const [still] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, adult.id));
    expect(still!.endedAt).toBeNull();
    c.close();
  });

  test("the channel turning mature removes unconfirmed members of adult rooms; an unconfirmed host ends it", async () => {
    const ch = await liveChannel();
    const r = await room("adult", ch);
    await t.db.update(schema.users).set({ matureConfirmedAt: new Date() }).where(eq(schema.users.id, r.host.id));
    const ok = await member(r);
    await t.db.update(schema.users).set({ matureConfirmedAt: new Date() }).where(eq(schema.users.id, ok.id));
    const unconfirmed = await member(r);
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, unconfirmed.id, r.id);
    const unconfirmedHost = await room("adult", ch);
    const u = await joined(a, unconfirmedHost.host.id, unconfirmedHost.id);

    await t.db.update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, ch.id));
    await event("channel.update", ch.id, { mature: true });
    await g.waitFor((f) => f.op === "room.closed" && f.roomId === r.id);
    expect(g.frames.some((f) => f.op === "notice" && f.code === "room_age_band")).toBe(true);
    const closed = await u.waitFor<"room.closed">((f) => f.op === "room.closed" && f.roomId === unconfirmedHost.id);
    expect(closed.reason).toBe("mature");

    const rows = await t.db
      .select({ userId: schema.watchRoomMembers.userId })
      .from(schema.watchRoomMembers)
      .where(and(eq(schema.watchRoomMembers.roomId, r.id), isNull(schema.watchRoomMembers.leftAt)));
    expect(rows.map((x) => x.userId).sort()).toEqual([r.host.id, ok.id].sort());
    const [kept] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, r.id));
    expect(kept!.endedAt).toBeNull();
    h.close();
    g.close();
    u.close();
  });

  test("a host's account deletion is announced to the room's members", async () => {
    const r = await room();
    const m = await member(r);
    const g = await joined(b, m.id, r.id);
    // What the deletion transaction does: end the room and drop the host's membership.
    await t.db
      .update(schema.watchRooms)
      .set({ endedAt: new Date(), endReason: "host_deleted", inviteHash: null })
      .where(eq(schema.watchRooms.id, r.id));
    await t.db
      .delete(schema.watchRoomMembers)
      .where(and(eq(schema.watchRoomMembers.roomId, r.id), eq(schema.watchRoomMembers.userId, r.host.id)));
    await t.db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, r.host.id));
    await pub.publish(
      iso.busPrefix + BUS.userControl,
      JSON.stringify({ op: "disconnect", userId: r.host.id, reason: "deleted" }),
    );
    const closed = await g.waitFor<"room.closed">((f) => f.op === "room.closed" && f.roomId === r.id);
    expect(closed.reason).toBe("host_deleted");
    g.close();
  });

  test("a channel ban during the room kicks the member; banning the host ends the room", async () => {
    const r = await room();
    const m = await member(r);
    const h = await joined(a, r.host.id, r.id);
    const g = await joined(b, m.id, r.id);
    await t.db.insert(schema.chatBans).values({ channelId: r.channelId, userId: m.id });
    await event("channel.ban", r.channelId, { user_id: m.id });
    await g.waitFor((f) => f.op === "room.closed" && f.roomId === r.id && f.reason === "moderation");
    expect(g.frames.some((f) => f.op === "notice" && f.code === "room_banned")).toBe(true);
    await h.waitFor((f) => f.op === "room.state" && f.members.length === 1, 3000);
    const [left] = await t.db
      .select()
      .from(schema.watchRoomMembers)
      .where(and(eq(schema.watchRoomMembers.roomId, r.id), eq(schema.watchRoomMembers.userId, m.id)));
    expect(left!.leftAt).not.toBeNull();

    await event("channel.ban", r.channelId, { user_id: r.host.id });
    await h.waitFor((f) => f.op === "room.closed" && f.reason === "moderation", 3000, { includePast: false });
    const [row] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, r.id));
    expect(row!.endReason).toBe("moderation");
    h.close();
    g.close();
  });

  test("a platform suspension removes the member from every room", async () => {
    const r = await room();
    const m = await member(r);
    const h = await joined(a, r.host.id, r.id);
    await t.db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, m.id));
    await pub.publish(
      iso.busPrefix + BUS.userControl,
      JSON.stringify({ op: "disconnect", userId: m.id, reason: "suspended" }),
    );
    const leftAt = await eventually(async () => {
      const [row] = await t.db
        .select()
        .from(schema.watchRoomMembers)
        .where(and(eq(schema.watchRoomMembers.roomId, r.id), eq(schema.watchRoomMembers.userId, m.id)));
      return row?.leftAt ?? null;
    });
    expect(leftAt).toBeInstanceOf(Date);
    h.close();
  });

  test("malformed bus messages are ignored", async () => {
    const r = await room();
    await pub.publish(iso.busPrefix + BUS.events, "not json");
    await pub.publish(iso.busPrefix + BUS.events, JSON.stringify({ type: "stream.offline" }));
    await Bun.sleep(200);
    const [row] = await t.db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, r.id));
    expect(row!.endedAt).toBeNull();
  });

  test("frames on the room bus never reach another room", async () => {
    const r1 = await room();
    const r2 = await room();
    const c = await joined(a, r1.host.id, r1.id);
    const stray: ServerFrame = { op: "room.closed", roomId: r2.id, reason: "host_closed" };
    await pub.publish(iso.busPrefix + BUS.room(r1.id), JSON.stringify(stray));
    expect(await c.never((f) => f.op === "room.closed")).toBe(true);
    c.close();
  });
});
