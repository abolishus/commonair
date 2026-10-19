// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Two chat instances sharing Valkey and one throwaway database. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import { createValkey } from "@commonair/service";
import { BUS, type BusEvent, EVENTS, type ServerFrame } from "@commonair/contracts";
import { schema } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
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

let t: TestDatabase;
let a: ChatService;
let b: ChatService;
const iso = isolation();
const clients: Client[] = [];
const connect = async (svc: ChatService, uid: string | null, scopes?: string[]) => {
  const c = await Client.connect(svc, { token: await chatToken(uid, scopes) });
  clients.push(c);
  return c;
};

beforeAll(async () => {
  t = await createTestDatabase();
  a = await startInstance(t.db, iso);
  b = await startInstance(t.db, iso);
});

afterAll(async () => {
  for (const c of clients) c.close();
  await Promise.allSettled([a?.stop(), b?.stop()]);
  await t?.drop();
});

/** A channel with a broadcaster, a moderator and a viewer; settings per test. */
async function room(settings: Parameters<typeof createChannel>[2] = {}) {
  const owner = await createUser(t.db);
  const mod = await createUser(t.db);
  const viewer = await createUser(t.db);
  const ch = await createChannel(t.db, owner, settings);
  await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: mod.id, role: "moderator" });
  return { owner, mod, viewer, ch };
}

describe("fan-out across instances", () => {
  test("a message sent on instance A arrives at a client on instance B", async () => {
    const { owner, viewer, ch } = await room();
    const sender = await connect(a, viewer.id);
    const receiver = await connect(b, owner.id);
    await sender.join(ch.slug);
    const joined = await receiver.join(ch.slug);
    expect(joined.me).toMatchObject({ canModerate: true, canChat: true, badges: ["broadcaster"] });

    const { ack, notice } = await sender.say(ch.slug, "hello from A Kappa");
    expect(notice).toBeNull();
    expect(ack.id).toBeTruthy();
    expect(ack.held).toBe(false);
    const msg = await receiver.waitFor<"message">((f) => f.op === "message" && f.message.id === ack.id);
    expect(msg.message).toMatchObject({
      body: "hello from A Kappa",
      channelId: ch.id,
      isAction: false,
      user: { id: viewer.id, username: viewer.username, accountType: "human" },
    });
    expect(msg.message.user.color).toMatch(/^chat-\d+$/);
    // The sender sees its own message too.
    await sender.waitFor((f) => f.op === "message" && f.message.id === ack.id);
  });

  test("accepted messages are published to BUS.events as channel.chat.message and persisted", async () => {
    const { viewer, ch } = await room();
    const listener = createValkey(VALKEY_URL);
    const seen: BusEvent[] = [];
    listener.on("message", (_c: string, raw: string) => seen.push(JSON.parse(raw) as BusEvent));
    await listener.subscribe(iso.busPrefix + BUS.events);
    try {
      const c = await connect(a, viewer.id);
      const { ack } = await c.say(ch.slug, "to the bus");
      const evt = await eventually(() =>
        seen.find((e) => e.type === "channel.chat.message" && e.payload.message_id === ack.id),
      );
      const payload = EVENTS["channel.chat.message"].payload.parse(evt.payload);
      expect(payload.message.text).toBe("to the bus");
      expect(evt.channelId).toBe(ch.id);
      await a.flush();
      const [row] = await t.db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, ack.id ?? ""));
      expect(row).toMatchObject({ body: "to the bus", userId: viewer.id, channelId: ch.id, heldAt: null });
    } finally {
      await listener.quit();
    }
  });

  test("inline platform events are forwarded to the room as event frames", async () => {
    const { owner, viewer, ch } = await room();
    const c = await connect(b, viewer.id);
    await c.join(ch.slug);
    const pub = createValkey(VALKEY_URL);
    try {
      const tip: BusEvent = {
        id: crypto.randomUUID(),
        type: "channel.tip",
        version: "1",
        channelId: ch.id,
        payload: { broadcaster_user_id: owner.id, amount: { value: 500, decimal_places: 2, currency: "usd" } },
        occurredAt: new Date().toISOString(),
      };
      await pub.publish(iso.busPrefix + BUS.events, JSON.stringify(tip));
      await pub.publish(iso.busPrefix + BUS.events, JSON.stringify({ ...tip, type: "channel.follow" }));
      const frame = await c.waitFor<"event">((f) => f.op === "event" && f.type === "channel.tip");
      expect(frame).toMatchObject({ channel: ch.slug, data: { amount: { value: 500 } } });
      expect(await c.never((f) => f.op === "event" && f.type === "channel.follow")).toBe(true);
    } finally {
      await pub.quit();
    }
  });

  test("replies carry the parent message", async () => {
    const { viewer, owner, ch } = await room();
    const c1 = await connect(a, viewer.id);
    const c2 = await connect(b, owner.id);
    await c1.join(ch.slug);
    await c2.join(ch.slug);
    const { ack: parent } = await c1.say(ch.slug, "question?");
    await c2.waitFor((f) => f.op === "message" && f.message.id === parent.id);
    const { ack } = await c2.say(ch.slug, "answer", { replyToId: parent.id });
    const msg = await c1.waitFor<"message">((f) => f.op === "message" && f.message.id === ack.id);
    expect(msg.message.replyTo).toEqual({ id: parent.id, username: viewer.username, body: "question?" });
  });
});

describe("rules across instances", () => {
  test("a timeout issued on A is enforced on B and broadcast to both", async () => {
    const { mod, viewer, ch } = await room();
    const modClient = await connect(a, mod.id);
    const viewerClient = await connect(b, viewer.id);
    await modClient.join(ch.slug);
    await viewerClient.join(ch.slug);
    expect((await viewerClient.say(ch.slug, "before")).notice).toBeNull();

    const n = await modClient.command(ch.slug, "timeout", [viewer.username, "120", "cool", "off"]);
    expect(n.code).toBe("cmd_success");
    const ban = await viewerClient.waitFor<"ban">((f) => f.op === "ban" && f.userId === viewer.id);
    // Viewers never see the reason; moderators do.
    expect(ban.reason).toBe("");
    expect(ban.expiresAt).not.toBeNull();
    const modBan = await modClient.waitFor<"ban">((f) => f.op === "ban" && f.userId === viewer.id);
    expect(modBan.reason).toBe("cool off");

    const blocked = await viewerClient.say(ch.slug, "after");
    expect(blocked.ack.id).toBeNull();
    expect(blocked.notice?.code).toBe("msg_timedout");

    expect((await modClient.command(ch.slug, "untimeout", [viewer.username])).code).toBe("cmd_success");
    await eventually(async () => (await viewerClient.say(ch.slug, `free ${Math.random()}`)).notice === null);
  });

  test("slow mode set from chat text on A applies to a user on B", async () => {
    const { mod, viewer, ch } = await room();
    const modClient = await connect(a, mod.id);
    const viewerClient = await connect(b, viewer.id);
    await viewerClient.join(ch.slug);
    const { ack, notice } = await modClient.say(ch.slug, "/slow 30");
    expect(ack.id).toBeNull();
    expect(notice?.code).toBe("slow_on");
    const settings = await viewerClient.waitFor<"settings">((f) => f.op === "settings");
    expect(settings.settings.slowModeSeconds).toBe(30);

    expect((await viewerClient.say(ch.slug, "one")).notice).toBeNull();
    expect((await viewerClient.say(ch.slug, "two")).notice?.code).toBe("msg_slowmode");
    // Moderators are exempt.
    expect((await modClient.say(ch.slug, "mod one")).notice).toBeNull();
    expect((await modClient.say(ch.slug, "mod two")).notice).toBeNull();

    expect((await modClient.command(ch.slug, "slowoff")).code).toBe("slow_off");
    const [row] = await t.db
      .select({ s: schema.channels.chatSettings })
      .from(schema.channels)
      .where(eq(schema.channels.id, ch.id));
    expect(row?.s.slowModeSeconds).toBe(0);
  });

  test("held messages reach moderators only", async () => {
    const { mod, viewer, owner, ch } = await room();
    await t.db.insert(schema.wordFilters).values({ channelId: ch.id, pattern: "suspicious", action: "hold" });
    const modClient = await connect(b, mod.id);
    const other = await connect(b, owner.id, ["chat:read", "chat:edit"]); // broadcaster without the moderation scope
    const bystander = await connect(a, (await createUser(t.db)).id);
    const sender = await connect(a, viewer.id);
    for (const c of [modClient, other, bystander, sender]) await c.join(ch.slug);
    expect(modClient.frames.find((f) => f.op === "joined")).toMatchObject({ me: { canModerate: true } });

    const { ack, notice } = await sender.say(ch.slug, "this is suspicious");
    expect(ack.held).toBe(true);
    expect(ack.id).toBeTruthy();
    expect(notice?.code).toBe("msg_held");
    const held = await modClient.waitFor<"message">((f) => f.op === "message" && f.message.id === ack.id);
    expect(held.held).toBe(true);
    expect(held.message.body).toBe("this is suspicious");
    const notHeld = (f: ServerFrame) => f.op === "message" && f.message.id === ack.id;
    expect(await bystander.never(notHeld)).toBe(true);
    expect(await other.never(notHeld, 0)).toBe(true);
    expect(await sender.never(notHeld, 0)).toBe(true);

    await a.flush();
    const [row] = await t.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, ack.id ?? ""));
    expect(row?.heldAt).not.toBeNull();
  });

  test("regex filters run in the filter worker; stored patterns the validator refuses are skipped", async () => {
    const { viewer, ch } = await room();
    await t.db.insert(schema.wordFilters).values([
      { channelId: ch.id, pattern: "\\bspam\\d+\\b", isRegex: true, action: "block" },
      // Saved before the API's stricter check: would block every message ending in "!" if it ran.
      { channelId: ch.id, pattern: ".*.{0,20}!", isRegex: true, action: "block" },
    ]);
    const sender = await connect(a, viewer.id);
    await sender.join(ch.slug);
    expect((await sender.say(ch.slug, "buy spam42 now")).notice?.code).toBe("msg_rejected");
    const ok = await sender.say(ch.slug, "hello!");
    expect(ok.notice).toBeNull();
    expect(ok.ack.id).toBeTruthy();
  });

  test("followers-only and subscribers-only read live database state", async () => {
    const { viewer, ch } = await room({ followersOnlyMinutes: 0 });
    const c = await connect(a, viewer.id);
    expect((await c.say(ch.slug, "hi")).notice?.code).toBe("msg_followersonly");
    await t.db.insert(schema.follows).values({ followerId: viewer.id, channelId: ch.id });
    // Standing is cached; a user-scoped invalidation (as the API sends after a follow) refreshes it.
    const pub = createValkey(VALKEY_URL);
    await c.join(ch.slug);
    await pub.publish(
      iso.busPrefix + BUS.chatControl(ch.id),
      JSON.stringify({ op: "invalidate", scope: "user", userId: viewer.id }),
    );
    await pub.quit();
    await eventually(async () => (await c.say(ch.slug, `hi ${Math.random()}`)).notice === null);
  });
});

describe("moderation commands", () => {
  test("ban writes chat_bans, mod_actions, audit_log and an outbox event in one go", async () => {
    const { owner, mod, viewer, ch } = await room();
    const modClient = await connect(a, mod.id);
    const n = await modClient.command(ch.slug, "ban", [`@${viewer.username}`, "spam", "bot"]);
    expect(n.code).toBe("cmd_success");

    const bans = await t.db.select().from(schema.chatBans).where(eq(schema.chatBans.channelId, ch.id));
    expect(bans).toHaveLength(1);
    expect(bans[0]).toMatchObject({
      userId: viewer.id,
      moderatorId: mod.id,
      reason: "spam bot",
      expiresAt: null,
      liftedAt: null,
    });
    const actions = await t.db.select().from(schema.modActions).where(eq(schema.modActions.channelId, ch.id));
    expect(actions).toMatchObject([
      { action: "ban", moderatorId: mod.id, targetUserId: viewer.id, reason: "spam bot", scope: "channel" },
    ]);
    const audits = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.channelId, ch.id));
    expect(audits).toMatchObject([
      {
        action: "chat.ban",
        actorType: "moderator",
        actorId: mod.id,
        subjectType: "user",
        subjectId: viewer.id,
        reason: "",
      },
    ]);
    expect(audits[0]?.details).toEqual({ modActionId: actions[0]?.id });
    const evts = await t.db.select().from(schema.events).where(eq(schema.events.channelId, ch.id));
    expect(evts).toHaveLength(1);
    const payload = EVENTS["channel.ban"].payload.parse(evts[0]?.payload);
    expect(payload).toMatchObject({
      broadcaster_user_id: owner.id,
      user_id: viewer.id,
      moderator_user_id: mod.id,
      is_permanent: true,
    });

    const viewerClient = await connect(b, viewer.id);
    expect((await viewerClient.say(ch.slug, "let me in")).notice?.code).toBe("msg_banned");

    expect((await modClient.command(ch.slug, "unban", [viewer.username])).code).toBe("cmd_success");
    const unbanEvents = await t.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.channelId, ch.id), eq(schema.events.type, "channel.unban")));
    expect(unbanEvents).toHaveLength(1);
    expect((await modClient.command(ch.slug, "unban", [viewer.username])).code).toBe("msg_rejected");
  });

  test("moderators cannot act on the broadcaster or other moderators; viewers cannot moderate", async () => {
    const { owner, mod, viewer, ch } = await room();
    const mod2 = await createUser(t.db);
    await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: mod2.id, role: "moderator" });
    const modClient = await connect(a, mod.id);
    expect((await modClient.command(ch.slug, "ban", [owner.username])).code).toBe("no_permission");
    expect((await modClient.command(ch.slug, "timeout", [mod2.username])).code).toBe("no_permission");
    expect((await modClient.command(ch.slug, "ban", [mod.username])).code).toBe("no_permission");
    expect((await modClient.command(ch.slug, "mod", [viewer.username])).code).toBe("no_permission");
    const viewerClient = await connect(a, viewer.id);
    expect((await viewerClient.command(ch.slug, "clear")).code).toBe("no_permission");
    // Moderator without the moderation scope on this connection.
    const scoped = await connect(a, mod.id, ["chat:read", "chat:edit"]);
    expect((await scoped.command(ch.slug, "clear")).code).toBe("no_permission");
    // The broadcaster can act on moderators.
    const ownerClient = await connect(a, owner.id);
    expect((await ownerClient.command(ch.slug, "timeout", [mod2.username, "5"])).code).toBe("cmd_success");
    expect(await t.db.select().from(schema.modActions).where(eq(schema.modActions.moderatorId, mod.id))).toHaveLength(
      0,
    );
  });

  test("mod/vip role changes are broadcaster-only and take effect immediately", async () => {
    const { owner, viewer, ch } = await room({ subscribersOnly: true });
    const ownerClient = await connect(a, owner.id);
    const viewerClient = await connect(b, viewer.id);
    await viewerClient.join(ch.slug);
    expect((await viewerClient.say(ch.slug, "hi")).notice?.code).toBe("msg_subsonly");
    expect((await ownerClient.command(ch.slug, "vip", [viewer.username])).code).toBe("cmd_success");
    await eventually(async () => (await viewerClient.say(ch.slug, `vip ${Math.random()}`)).notice === null);
    expect((await ownerClient.command(ch.slug, "vip", [viewer.username])).code).toBe("msg_rejected");
    expect((await ownerClient.command(ch.slug, "mod", [viewer.username])).code).toBe("cmd_success");
    const evts = await t.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.channelId, ch.id), eq(schema.events.type, "channel.moderator.add")));
    expect(evts).toHaveLength(1);
    const roles = await t.db.select().from(schema.channelRoles).where(eq(schema.channelRoles.channelId, ch.id));
    expect(roles.map((r) => r.role).sort()).toEqual(["moderator", "moderator", "vip"]);
    expect((await ownerClient.command(ch.slug, "unmod", [viewer.username])).code).toBe("cmd_success");
    expect((await ownerClient.command(ch.slug, "unvip", [viewer.username])).code).toBe("cmd_success");
  });

  test("delete removes a just-sent message everywhere and records it", async () => {
    const { mod, viewer, ch } = await room();
    const viewerClient = await connect(a, viewer.id);
    const modClient = await connect(b, mod.id);
    await viewerClient.join(ch.slug);
    await modClient.join(ch.slug);
    const { ack } = await viewerClient.say(ch.slug, "oops");
    const id = ack.id ?? "";
    // Sent on A, deleted from B before A's write buffer is necessarily flushed.
    const n = await modClient.command(ch.slug, "delete", [id]);
    expect(n.code).toBe("cmd_success");
    const del = await viewerClient.waitFor<"delete">((f) => f.op === "delete" && f.messageId === id);
    expect(del.username).toBe(viewer.username);
    const [row] = await t.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id));
    expect(row?.deletedBy).toBe(mod.id);
    const evts = await t.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.channelId, ch.id), eq(schema.events.type, "channel.chat.message_delete")));
    expect(evts[0]?.payload).toMatchObject({ message_id: id, target_user_id: viewer.id });
  });

  test("clear and mode toggles notify and broadcast", async () => {
    const { mod, viewer, ch } = await room();
    const modClient = await connect(a, mod.id);
    const viewerClient = await connect(b, viewer.id);
    await viewerClient.join(ch.slug);
    expect((await modClient.command(ch.slug, "clear")).code).toBe("cmd_success");
    await viewerClient.waitFor((f) => f.op === "clear" && f.channel === ch.slug);
    expect((await modClient.command(ch.slug, "emoteonly")).code).toBe("emote_only_on");
    expect((await viewerClient.say(ch.slug, "words")).notice?.code).toBe("msg_emoteonly");
    expect((await modClient.command(ch.slug, "emoteonlyoff")).code).toBe("emote_only_off");
    expect((await modClient.command(ch.slug, "followers", ["10m"])).code).toBe("followers_on");
    expect((await modClient.command(ch.slug, "followersoff")).code).toBe("followers_off");
    expect((await modClient.command(ch.slug, "subscribers")).code).toBe("subs_on");
    expect((await modClient.command(ch.slug, "subscribersoff")).code).toBe("subs_off");
    expect((await modClient.command(ch.slug, "bogus")).code).toBe("unrecognized_cmd");
    const types = (await t.db.select().from(schema.events).where(eq(schema.events.channelId, ch.id))).map(
      (e) => e.type,
    );
    expect(types.filter((x) => x === "channel.chat_settings.update")).toHaveLength(6);
    expect(types).toContain("channel.chat.clear");
  });

  test("/me sends an action message", async () => {
    const { viewer, ch } = await room();
    const c = await connect(a, viewer.id);
    await c.join(ch.slug);
    const { ack } = await c.say(ch.slug, "/me waves");
    const msg = await c.waitFor<"message">((f) => f.op === "message" && f.message.id === ack.id);
    expect(msg.message).toMatchObject({ body: "waves", isAction: true });
    // As a command frame it still answers with exactly one notice.
    expect((await c.command(ch.slug, "me", ["dances"])).code).toBe("cmd_success");
    await c.waitFor((f) => f.op === "message" && f.message.body === "dances" && f.message.isAction);
  });

  test("replies echo the request nonce; usage and invalid_user codes", async () => {
    const { mod, ch } = await room();
    const c = await connect(a, mod.id);
    await c.join(ch.slug);
    c.send({ op: "command", channel: ch.slug, command: "ban", args: [], nonce: "n-usage" });
    expect(await c.waitFor((f) => f.op === "notice" && (f as { nonce?: string }).nonce === "n-usage")).toMatchObject({
      code: "usage",
      channel: ch.slug,
    });
    c.send({ op: "command", channel: ch.slug, command: "timeout", args: ["nobody_here"], nonce: "n-user" });
    expect(await c.waitFor((f) => f.op === "notice" && (f as { nonce?: string }).nonce === "n-user")).toMatchObject({
      code: "invalid_user",
    });
    c.send({ op: "join", channel: "no_such_room", nonce: "n-join" });
    expect(await c.waitFor((f) => f.op === "error" && f.nonce === "n-join")).toMatchObject({
      code: "channel_not_found",
      channel: "no_such_room",
    });
    // A rejected send: notice and ack both carry the nonce.
    const viewer = await createUser(t.db, { emailVerified: false });
    const v = await connect(a, viewer.id);
    await v.join(ch.slug);
    v.send({ op: "send", channel: ch.slug, body: "hi", nonce: "n-send" });
    expect(await v.waitFor((f) => f.op === "notice" && (f as { nonce?: string }).nonce === "n-send")).toMatchObject({
      code: "msg_verified_email",
      channel: ch.slug,
    });
    expect(await v.waitFor((f) => f.op === "ack" && f.nonce === "n-send")).toMatchObject({ id: null });
  });

  test("every command frame gets exactly one notice", async () => {
    const { mod, ch } = await room();
    const c = await connect(a, mod.id);
    for (const [cmd, args] of [
      ["slow", ["10"]],
      ["slowoff", []],
      ["bogus", []],
      ["ban", []],
      ["mod", ["nobody_here"]],
    ] as const) {
      const start = c.frames.length;
      await c.command(ch.slug, cmd, [...args]);
      await Bun.sleep(100);
      expect(c.frames.slice(start).filter((f) => f.op === "notice")).toHaveLength(1);
    }
  });
});

describe("joined frame", () => {
  test("badges are type or type/tier strings", async () => {
    const { viewer, ch } = await room();
    await t.db.insert(schema.subscriptions).values({
      subscriberId: viewer.id,
      channelId: ch.id,
      tier: 2,
      status: "active",
      provider: "manual",
      priceCents: 999,
      currency: "usd",
    });
    await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: viewer.id, role: "vip" });
    const c = await connect(b, viewer.id);
    const joined = await c.join(ch.slug);
    expect(joined.me.badges).toEqual(["vip", "subscriber/2"]);
  });
});
