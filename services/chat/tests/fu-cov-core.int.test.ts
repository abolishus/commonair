// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ChatCore's bus handlers and reply lookups end to end: real Postgres, real Valkey pub/sub, real
 * sockets. Messages are published on the bus the way the API, worker and media services do.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { BUS, type ServerFrame } from "@commonair/contracts";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import type { ChatService } from "../src/server.ts";
import {
  chatToken,
  Client,
  createChannel,
  createUser,
  eventually,
  isolation,
  startInstance,
  VALKEY_URL,
} from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let svc: ChatService;
let pub: ValkeyClient;
const iso = isolation();
const clients: Client[] = [];
const logLines: string[] = [];

const connect = async (uid: string | null, scopes?: string[]) => {
  const c = await Client.connect(svc, { token: await chatToken(uid, scopes) });
  clients.push(c);
  return c;
};

const control = (channelId: string, msg: unknown) =>
  pub.publish(iso.busPrefix + BUS.chatControl(channelId), typeof msg === "string" ? msg : JSON.stringify(msg));

beforeAll(async () => {
  t = await createTestDatabase();
  svc = await startInstance(t.db, iso, {
    filterWorkers: 0,
    logger: createLogger({ service: "chat-cov", level: "warn", write: (line) => logLines.push(line) }),
  });
  pub = createValkey(VALKEY_URL);
});

afterAll(async () => {
  for (const c of clients) c.close();
  await pub?.quit();
  await svc?.stop();
  await t?.drop();
});

async function room() {
  const owner = await createUser(t.db);
  const mod = await createUser(t.db);
  const viewer = await createUser(t.db);
  const ch = await createChannel(t.db, owner);
  await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: mod.id, role: "moderator" });
  return { owner, mod, viewer, ch };
}

const banFrame = (slug: string, userId: string, reason: string) => ({
  op: "ban",
  channel: slug,
  userId,
  username: "target",
  expiresAt: null,
  reason,
});

describe("control messages", () => {
  test("a ban's reason reaches moderators only; viewers and anonymous members get an empty reason", async () => {
    const { mod, viewer, ch } = await room();
    const target = await createUser(t.db);
    const m = await connect(mod.id);
    const v = await connect(viewer.id);
    const anon = await connect(null);
    for (const c of [m, v, anon]) await c.join(ch.slug);
    await control(ch.id, banFrame(ch.slug, target.id, "slurs in chat"));
    const isBan = (f: ServerFrame) => f.op === "ban" && f.userId === target.id;
    expect(await m.waitFor<"ban">(isBan)).toMatchObject({ reason: "slurs in chat" });
    expect(await v.waitFor<"ban">(isBan)).toMatchObject({ reason: "" });
    expect(await anon.waitFor<"ban">(isBan)).toMatchObject({ reason: "" });
    // Exactly one ban frame each: moderators are not also sent the viewers' copy.
    expect(m.frames.filter(isBan)).toHaveLength(1);
    expect(v.frames.filter(isBan)).toHaveLength(1);
  });

  test("a ban invalidates the banned member's cached standing, so the next send is refused", async () => {
    const { viewer, ch } = await room();
    const v = await connect(viewer.id);
    expect((await v.say(ch.slug, "before the ban")).ack.id).toBeTruthy();
    await t.db.insert(schema.chatBans).values({ channelId: ch.id, userId: viewer.id, reason: "x" });
    await control(ch.id, banFrame(ch.slug, viewer.id, "x"));
    await v.waitFor((f) => f.op === "ban");
    const { ack, notice } = await v.say(ch.slug, "after the ban");
    expect(ack.id).toBeNull();
    expect(notice?.code).toMatch(/ban/);
  });

  test("invalidate (channel scope) drops cached settings: the next send sees the change", async () => {
    const { viewer, ch } = await room();
    const v = await connect(viewer.id);
    expect((await v.say(ch.slug, "plain words")).ack.id).toBeTruthy();
    const [row] = await t.db.select().from(schema.channels).where(eq(schema.channels.id, ch.id));
    if (!row) throw new Error("channel row missing");
    await t.db
      .update(schema.channels)
      .set({ chatSettings: { ...row.chatSettings, emoteOnly: true } })
      .where(eq(schema.channels.id, ch.id));
    // Still cached: the settings change alone does not reach this instance.
    expect((await v.say(ch.slug, "still plain")).ack.id).toBeTruthy();
    await control(ch.id, { op: "invalidate", scope: "channel" });
    await eventually(async () => (await v.say(ch.slug, "plain again")).ack.id === null);
    // Cache signals never reach clients.
    expect(v.frames.some((f) => (f.op as string) === "invalidate")).toBe(false);
  });

  test("invalidate (user scope) refreshes one member's moderator view after a promotion", async () => {
    const { viewer, ch } = await room();
    const v = await connect(viewer.id);
    expect((await v.join(ch.slug)).me.canModerate).toBe(false);
    await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: viewer.id, role: "moderator" });
    await control(ch.id, { op: "invalidate", scope: "user", userId: viewer.id });
    await expectModeratorView(v, ch, viewer.id);
  });

  test("invalidate (user scope, no user) refreshes every member of the room", async () => {
    const { viewer, ch } = await room();
    const other = await createUser(t.db);
    const v = await connect(viewer.id);
    const o = await connect(other.id);
    await v.join(ch.slug);
    await o.join(ch.slug);
    await t.db.insert(schema.channelRoles).values([
      { channelId: ch.id, userId: viewer.id, role: "moderator" },
      { channelId: ch.id, userId: other.id, role: "moderator" },
    ]);
    await control(ch.id, { op: "invalidate", scope: "user" });
    await expectModeratorView(v, ch, viewer.id);
    await expectModeratorView(o, ch, other.id);
  });

  test("a demotion via invalidate hides ban reasons from the former moderator again", async () => {
    const { mod, ch } = await room();
    const m = await connect(mod.id);
    expect((await m.join(ch.slug)).me.canModerate).toBe(true);
    await t.db.delete(schema.channelRoles).where(eq(schema.channelRoles.userId, mod.id));
    await control(ch.id, { op: "invalidate", scope: "user", userId: mod.id });
    const target = (await createUser(t.db)).id;
    await eventually(async () => {
      const next = m.waitFor<"ban">((x) => x.op === "ban" && x.userId === target, 3000, { includePast: false });
      await control(ch.id, banFrame(ch.slug, target, "probe"));
      const f = await next.catch(() => null);
      return f?.reason === "";
    });
  });

  test("BUS.userControl invalidate refreshes the user's moderator view in rooms they are in", async () => {
    const { viewer, ch } = await room();
    const v = await connect(viewer.id);
    await v.join(ch.slug);
    await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: viewer.id, role: "moderator" });
    await pub.publish(
      iso.busPrefix + BUS.userControl,
      JSON.stringify({ op: "invalidate", userId: viewer.id, reason: "role_changed" }),
    );
    await expectModeratorView(v, ch, viewer.id);
  });
});

/** Probe with ban frames until the member receives the moderators' copy (refreshes are async). */
async function expectModeratorView(c: Client, ch: { id: string; slug: string }, _uid: string) {
  const target = (await createUser(t.db)).id;
  await eventually(async () => {
    // Listen before publishing: a frame that lands between the two would count as "past".
    const next = c.waitFor<"ban">((x) => x.op === "ban" && x.userId === target, 3000, { includePast: false });
    await control(ch.id, banFrame(ch.slug, target, "probe"));
    const f = await next.catch(() => null);
    return f?.reason === "probe";
  }, 10_000);
}

describe("live events", () => {
  test("a BUS.live event reloads the channel: later messages carry the new broadcast", async () => {
    const { viewer, ch } = await room();
    const v = await connect(viewer.id);
    const first = await v.say(ch.slug, "offline message");
    const broadcastId = uuidv7();
    await t.db.insert(schema.broadcasts).values({
      id: broadcastId,
      channelId: ch.id,
      ingestProtocol: "rtmp",
      path: `live/${ch.slug}`,
      startedAt: new Date(Date.now() - 5_000),
    });
    await t.db.update(schema.channels).set({ liveBroadcastId: broadcastId }).where(eq(schema.channels.id, ch.id));
    const cached = await v.say(ch.slug, "still cached");
    // Malformed live events are ignored; a valid one for another channel changes nothing here.
    for (const raw of ["{", "null", JSON.stringify({ channelId: 7 }), JSON.stringify({ channelId: uuidv7() })])
      await pub.publish(iso.busPrefix + BUS.live, raw);
    await pub.publish(iso.busPrefix + BUS.live, JSON.stringify({ channelId: ch.id, status: "online" }));
    const after = await eventually(async () => {
      const r = await v.say(ch.slug, "live message");
      await svc.flush();
      const [row] = await t.db
        .select({ b: schema.chatMessages.broadcastId })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, r.ack.id ?? uuidv7()));
      return row?.b === broadcastId ? r : null;
    });
    await svc.flush();
    const rows = await t.db
      .select({ id: schema.chatMessages.id, b: schema.chatMessages.broadcastId })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.channelId, ch.id));
    const byId = new Map(rows.map((r) => [r.id, r.b]));
    expect(byId.get(first.ack.id ?? "")).toBeNull();
    expect(byId.get(cached.ack.id ?? "")).toBeNull();
    expect(byId.get(after.ack.id ?? "")).toBe(broadcastId);
  });
});

describe("malformed bus traffic", () => {
  test("garbage on the chat, control and events channels is dropped without an error log", async () => {
    const { owner, viewer, ch } = await room();
    const v = await connect(viewer.id);
    await v.join(ch.slug);
    const before = v.frames.length;
    const errorsBefore = logLines.filter((l) => l.includes('"level":"error"')).length;
    for (const raw of ["{", "null", "[]", "42", JSON.stringify({ v: 2, frame: { op: "clear", channel: ch.slug } })])
      await pub.publish(iso.busPrefix + BUS.chat(ch.id), raw);
    for (const raw of ["{", "null", JSON.stringify({ op: "pong" }), JSON.stringify({ op: "invalidate", scope: "x" })])
      await control(ch.id, raw);
    const tip = {
      id: uuidv7(),
      type: "channel.tip",
      version: "1",
      channelId: ch.id,
      payload: { broadcaster_user_id: owner.id },
      occurredAt: new Date().toISOString(),
    };
    for (const raw of [
      "{",
      "null",
      JSON.stringify({ ...tip, channelId: null }),
      JSON.stringify({ ...tip, payload: "not a record" }),
      JSON.stringify({ ...tip, type: "channel.chat.message" }),
    ])
      await pub.publish(iso.busPrefix + BUS.events, raw);
    // A valid event after the garbage still arrives, and is the only new frame.
    await pub.publish(iso.busPrefix + BUS.events, JSON.stringify(tip));
    await v.waitFor((f) => f.op === "event" && f.type === "channel.tip");
    expect(v.frames.slice(before).map((f) => f.op)).toEqual(["event"]);
    expect(logLines.filter((l) => l.includes('"level":"error"')).length).toBe(errorsBefore);
    expect(logLines.filter((l) => l.includes("malformed chat control message")).length).toBeGreaterThanOrEqual(4);
  });
});

describe("reply lookups", () => {
  test("a reply to a message not in the recent cache is resolved from Postgres", async () => {
    const { viewer, owner, ch } = await room();
    const v = await connect(viewer.id);
    const parent = await v.say(ch.slug, "the parent message");
    await svc.flush();
    // A clear drops the recent cache (and is what a real /clear sends); the row stays in Postgres.
    await control(ch.id, { op: "clear", channel: ch.slug });
    await v.waitFor((f) => f.op === "clear");
    const o = await connect(owner.id);
    const reply = await o.say(ch.slug, "replying", { replyToId: parent.ack.id });
    const msg = await o.waitFor<"message">((f) => f.op === "message" && f.message.id === reply.ack.id);
    expect(msg.message.replyTo).toEqual({ id: parent.ack.id, username: viewer.username, body: "the parent message" });
  });

  test("deleted, held, foreign and unknown parents resolve to no reply", async () => {
    const { viewer, owner, ch } = await room();
    const other = await room();
    const v = await connect(viewer.id);
    const deleted = await v.say(ch.slug, "to be deleted");
    const foreign = await (await connect(other.viewer.id)).say(other.ch.slug, "elsewhere");
    await svc.flush();
    const heldId = uuidv7();
    await t.db.insert(schema.chatMessages).values({
      id: heldId,
      channelId: ch.id,
      userId: viewer.id,
      body: "held one",
      heldAt: new Date(),
      createdAt: new Date(),
    });
    await t.db
      .update(schema.chatMessages)
      .set({ deletedAt: new Date() })
      .where(eq(schema.chatMessages.id, deleted.ack.id ?? ""));
    await control(ch.id, { op: "delete", channel: ch.slug, messageId: deleted.ack.id, username: viewer.username });
    await v.waitFor((f) => f.op === "delete");
    const o = await connect(owner.id);
    for (const parentId of [deleted.ack.id, heldId, foreign.ack.id, uuidv7()]) {
      const r = await o.say(ch.slug, `reply to ${parentId}`, { replyToId: parentId });
      const msg = await o.waitFor<"message">((f) => f.op === "message" && f.message.id === r.ack.id);
      expect(msg.message.replyTo).toBeNull();
    }
  });
});

describe("joins", () => {
  test("the per-connection room cap, unknown channels and parting a room never joined", async () => {
    const { viewer, ch } = await room();
    const second = await room();
    const capped = await startInstance(t.db, iso, { maxRoomsPerConnection: 1, filterWorkers: 0 });
    try {
      const c = await Client.connect(capped, { token: await chatToken(viewer.id) });
      clients.push(c);
      await c.join(ch.slug);
      c.send({ op: "join", channel: second.ch.slug, nonce: "n1" });
      expect(await c.waitFor((f) => f.op === "error" && f.nonce === "n1")).toMatchObject({ code: "too_many_rooms" });
      // Rejoining the room already joined does not count against the cap.
      expect((await c.join(ch.slug)).channel).toBe(ch.slug);
      c.send({ op: "part", channel: second.ch.slug });
      expect(await c.waitFor((f) => f.op === "parted" && f.channel === second.ch.slug)).toBeTruthy();
      c.send({ op: "part", channel: ch.slug });
      await c.waitFor((f) => f.op === "parted" && f.channel === ch.slug);
      c.send({ op: "join", channel: "no-such-channel-here", nonce: "n2" });
      expect(await c.waitFor((f) => f.op === "error" && f.nonce === "n2")).toMatchObject({
        code: "channel_not_found",
      });
      // The cap counts current rooms: after parting, another room fits.
      expect((await c.join(second.ch.slug)).channel).toBe(second.ch.slug);
    } finally {
      await capped.stop();
    }
  });

  test("a command or send to a channel not joined is refused before reaching the core", async () => {
    const { viewer } = await room();
    const c = await connect(viewer.id);
    c.send({ op: "command", channel: "no-such-channel-cmd", command: "clear", args: [], nonce: "c1" });
    expect(await c.waitFor((f) => f.op === "notice" && f.nonce === "c1")).toMatchObject({
      code: "msg_rejected",
      text: "Join the channel first.",
    });
    c.send({ op: "send", channel: "no-such-channel-send", body: "hi", nonce: "s1" });
    expect(await c.waitFor((f) => f.op === "notice" && f.nonce === "s1")).toMatchObject({ code: "msg_rejected" });
    expect(await c.waitFor((f) => f.op === "ack" && f.nonce === "s1")).toMatchObject({ id: null, held: false });
  });
});
