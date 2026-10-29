// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The channel bot on two chat instances sharing Valkey and one throwaway database. */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { and, eq, sql } from "drizzle-orm";
import { BUS, type ServerFrame } from "@commonair/contracts";
import { KEYS } from "@commonair/contracts/internal";
import { BotConfig } from "@commonair/contracts/shapes";
import { pointsBalance, postPointsInTx, schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { type BotMiddleware, createBotMiddleware } from "../src/plugins/bot/index.ts";
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
let a: ChatService;
let b: ChatService;
let botA: BotMiddleware;
let botB: BotMiddleware;
let valkey: ValkeyClient;
let pub: ValkeyClient;
const iso = isolation();
const clients: Client[] = [];

const connect = async (svc: ChatService, uid: string) => {
  const c = await Client.connect(svc, { token: await chatToken(uid) });
  clients.push(c);
  return c;
};

beforeAll(async () => {
  t = await createTestDatabase();
  // Timers are driven by hand (tickTimers) so the test controls when instances look.
  botA = createBotMiddleware({ timerTickMs: 0 });
  botB = createBotMiddleware({ timerTickMs: 0 });
  a = await startInstance(t.db, iso, { middlewares: [botA] });
  b = await startInstance(t.db, iso, { middlewares: [botB] });
  valkey = createValkey(VALKEY_URL, { keyPrefix: iso.keyPrefix, name: "bot-int" });
  pub = createValkey(VALKEY_URL, { name: "bot-int-pub" });
});

afterAll(async () => {
  for (const c of clients) c.close();
  await Promise.allSettled([a?.stop(), b?.stop(), valkey?.quit(), pub?.quit()]);
  await t?.drop();
});

type Room = Awaited<ReturnType<typeof botRoom>>;

/** A channel with its bot on (a moderator, as E8-bot-api makes it), a moderator and two viewers. */
async function botRoom(config: Partial<BotConfig> = {}, enabled = true) {
  const owner = await createUser(t.db);
  const mod = await createUser(t.db);
  const viewer = await createUser(t.db);
  const viewer2 = await createUser(t.db);
  const bot = await createUser(t.db, { accountType: "bot", botOwnerId: owner.id });
  const ch = await createChannel(t.db, owner);
  await t.db.insert(schema.channelRoles).values([
    { channelId: ch.id, userId: mod.id, role: "moderator" },
    { channelId: ch.id, userId: bot.id, role: "moderator" },
  ]);
  await t.db
    .insert(schema.botConfigs)
    .values({ channelId: ch.id, enabled, config: BotConfig.parse(config), botUserId: bot.id });
  return { owner, mod, viewer, viewer2, bot, ch };
}

async function command(
  room: Room,
  over: Partial<typeof schema.botCommands.$inferInsert> & { name: string; response: string },
): Promise<string> {
  const id = uuidv7();
  await t.db.insert(schema.botCommands).values({ id, channelId: room.ch.id, cooldownSeconds: 0, ...over });
  return id;
}

const fromBot = (room: Room) => (f: ServerFrame) => f.op === "message" && f.message.user.id === room.bot.id;
const botMessages = (c: Client, room: Room) =>
  c.frames.filter(fromBot(room)) as Extract<ServerFrame, { op: "message" }>[];
const waitBot = (c: Client, room: Room, includes: string) =>
  c.waitFor<"message">((f) => fromBot(room)(f) && f.op === "message" && f.message.body.includes(includes), 5_000);

describe("commands", () => {
  test("a command answers once, from the bot account, on every instance", async () => {
    const room = await botRoom();
    await command(room, { name: "hello", response: "Hi ${user}!", aliases: ["hey"] });
    const sender = await connect(a, room.viewer.id);
    const watcher = await connect(b, room.owner.id);
    await sender.join(room.ch.slug);
    await watcher.join(room.ch.slug);

    const { notice } = await sender.say(room.ch.slug, "!hello");
    expect(notice).toBeNull();
    const reply = await waitBot(watcher, room, "Hi");
    expect(reply.message).toMatchObject({
      body: `Hi ${room.viewer.username}!`,
      user: { id: room.bot.id, accountType: "bot" },
    });
    await waitBot(sender, room, "Hi");
    await Bun.sleep(300);
    expect(botMessages(watcher, room)).toHaveLength(1);
    expect(botMessages(sender, room)).toHaveLength(1);

    // An alias answers the same command; the use count follows. (Another viewer: the same reply
    // twice within the duplicate window would be refused like anyone's.)
    const second = await connect(a, room.viewer2.id);
    await second.say(room.ch.slug, "!hey there");
    await eventually(() => botMessages(watcher, room).length === 2);
    const [row] = await t.db
      .select({ uses: schema.botCommands.useCount })
      .from(schema.botCommands)
      .where(and(eq(schema.botCommands.channelId, room.ch.id), eq(schema.botCommands.name, "hello")));
    expect(row?.uses).toBe(2);
  });

  test("the bot's own !-response does not trigger it again", async () => {
    const room = await botRoom();
    await command(room, { name: "loop", response: "!loop ${user} ${count}" });
    const sender = await connect(a, room.viewer.id);
    const watcher = await connect(b, room.viewer2.id);
    await watcher.join(room.ch.slug);
    await sender.say(room.ch.slug, "!loop");
    await waitBot(watcher, room, "!loop");
    await Bun.sleep(500);
    expect(botMessages(watcher, room)).toHaveLength(1);
    expect(botMessages(watcher, room)[0]?.message.body).toBe(`!loop ${room.viewer.username} 1`);
  });

  test("user level: a viewer gets nothing from a moderator command; a moderator does", async () => {
    const room = await botRoom();
    await command(room, { name: "modonly", response: "mods: ${user}", userLevel: "moderator" });
    const viewer = await connect(a, room.viewer.id);
    const mod = await connect(a, room.mod.id);
    await viewer.join(room.ch.slug);
    await viewer.say(room.ch.slug, "!modonly");
    expect(await viewer.never(fromBot(room), 400)).toBe(true);
    await mod.say(room.ch.slug, "!modonly");
    expect((await waitBot(viewer, room, "mods:")).message.body).toBe(`mods: ${room.mod.username}`);
  });

  test("cooldown holds across two instances; moderators skip it", async () => {
    const room = await botRoom();
    await command(room, { name: "cd", response: "cooldown ${user}", cooldownSeconds: 30 });
    const one = await connect(a, room.viewer.id);
    const two = await connect(b, room.viewer2.id);
    const mod = await connect(b, room.mod.id);
    await one.join(room.ch.slug);
    await two.join(room.ch.slug);
    await one.say(room.ch.slug, "!cd");
    await waitBot(two, room, `cooldown ${room.viewer.username}`);
    await two.say(room.ch.slug, "!cd");
    expect(
      await two.never(
        (f) => fromBot(room)(f) && f.op === "message" && f.message.body.includes(room.viewer2.username),
        500,
      ),
    ).toBe(true);
    await mod.say(room.ch.slug, "!cd");
    await waitBot(one, room, `cooldown ${room.mod.username}`);
  });

  test("a disabled bot answers nothing", async () => {
    const room = await botRoom({}, false);
    await command(room, { name: "hello", response: "Hi" });
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!hello");
    expect(await sender.never(fromBot(room), 400)).toBe(true);
  });

  test("a BotControlMessage makes a new command answer without a restart", async () => {
    const room = await botRoom();
    await command(room, { name: "first", response: "first ${user}" });
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!first");
    await waitBot(sender, room, "first");
    await command(room, { name: "second", response: "second ${touser}" });
    // Cached: the new command is unknown until the API's control message arrives.
    await sender.say(room.ch.slug, "!second cached");
    expect(
      await sender.never((f) => fromBot(room)(f) && f.op === "message" && f.message.body.startsWith("second"), 400),
    ).toBe(true);
    await pub.publish(iso.busPrefix + BUS.botControl, JSON.stringify({ channelId: room.ch.id, scope: "commands" }));
    await Bun.sleep(200);
    await sender.say(room.ch.slug, "!second @reloaded");
    expect((await waitBot(sender, room, "second")).message.body).toBe("second reloaded");
  });
});

describe("points", () => {
  test("a command with a cost debits once and emits channel.points.change", async () => {
    const room = await botRoom();
    const hug = await command(room, {
      name: "hug",
      response: "${user} hugs ${touser} (${points} ${pointsName})",
      costPoints: 50,
    });
    await t.db.transaction((tx) =>
      postPointsInTx(tx, {
        channelId: room.ch.id,
        userId: room.viewer.id,
        delta: 100,
        reason: "moderator_adjust",
        refId: null,
      }),
    );
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!hug @bob");
    const reply = await waitBot(sender, room, "hugs");
    expect(reply.message.body).toBe(`${room.viewer.username} hugs bob (50 points)`);
    expect(await pointsBalance(t.db, room.ch.id, room.viewer.id)).toBe(50);

    const ledger = await t.db
      .select()
      .from(schema.loyaltyTransactions)
      .where(
        and(eq(schema.loyaltyTransactions.channelId, room.ch.id), eq(schema.loyaltyTransactions.reason, "command")),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ userId: room.viewer.id, delta: -50, refId: hug });
    const events = await t.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.channelId, room.ch.id), eq(schema.events.type, "channel.points.change")));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      user_id: room.viewer.id,
      user_login: room.viewer.username,
      delta: -50,
      balance: 50,
      reason: "command",
      broadcaster_user_id: room.owner.id,
    });
  });

  test("an overdraw: the bot says so, nothing is debited, the cooldown is released", async () => {
    const room = await botRoom();
    const pricey = await command(room, { name: "pricey", response: "bought", costPoints: 50, cooldownSeconds: 60 });
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!pricey");
    const reply = await waitBot(sender, room, "costs");
    expect(reply.message.body).toBe(`@${room.viewer.username}, !pricey costs 50 points and you have 0.`);
    expect(await valkey.get(KEYS.botCooldown(room.ch.id, "pricey"))).toBeNull();
    const ledger = await t.db
      .select()
      .from(schema.loyaltyTransactions)
      .where(eq(schema.loyaltyTransactions.channelId, room.ch.id));
    expect(ledger).toHaveLength(0);
    const [row] = await t.db
      .select({ uses: schema.botCommands.useCount })
      .from(schema.botCommands)
      .where(eq(schema.botCommands.id, pricey));
    expect(row?.uses).toBe(0);
    const events = await t.db.select().from(schema.events).where(eq(schema.events.channelId, room.ch.id));
    expect(events.filter((e) => e.type === "channel.points.change")).toHaveLength(0);

    // Released: with points, the next try answers at once instead of waiting out the cooldown.
    await t.db.transaction((tx) =>
      postPointsInTx(tx, {
        channelId: room.ch.id,
        userId: room.viewer.id,
        delta: 60,
        reason: "moderator_adjust",
        refId: null,
      }),
    );
    await sender.say(room.ch.slug, "!pricey now");
    await waitBot(sender, room, "bought");
    expect(await pointsBalance(t.db, room.ch.id, room.viewer.id)).toBe(10);
  });

  test("!points answers the balance; silent when points are off", async () => {
    const room = await botRoom({ loyalty: { enabled: true, pointsName: "beans" } });
    await t.db.transaction((tx) =>
      postPointsInTx(tx, {
        channelId: room.ch.id,
        userId: room.viewer.id,
        delta: 42,
        reason: "moderator_adjust",
        refId: null,
      }),
    );
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!points");
    expect((await waitBot(sender, room, "beans")).message.body).toBe(`@${room.viewer.username}, you have 42 beans.`);

    const off = await botRoom({ loyalty: { enabled: false, pointsName: "beans" } });
    const other = await connect(a, off.viewer.id);
    await other.say(off.ch.slug, "!points");
    expect(await other.never(fromBot(off), 400)).toBe(true);
  });
});

describe("song requests", () => {
  test("!sr queues a link and refuses a non-link", async () => {
    const room = await botRoom({ songRequests: { enabled: true, maxQueue: 25 } });
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!sr https://example.org/song");
    expect((await waitBot(sender, room, "queue")).message.body).toBe(
      `@${room.viewer.username}, your request is number 1 in the queue.`,
    );
    await sender.say(room.ch.slug, "!sr not-a-link");
    await waitBot(sender, room, "takes a link");
    const rows = await t.db.select().from(schema.songRequests).where(eq(schema.songRequests.channelId, room.ch.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "https://example.org/song", status: "queued", requesterId: room.viewer.id });
  });

  test("queue limits: per requester and in total", async () => {
    const room = await botRoom({ songRequests: { enabled: true, maxQueue: 4 } });
    const one = await connect(a, room.viewer.id);
    for (const n of [1, 2, 3]) {
      await one.say(room.ch.slug, `!sr https://example.org/${n}`);
      await waitBot(one, room, `number ${n}`);
    }
    await one.say(room.ch.slug, "!sr https://example.org/4");
    await waitBot(one, room, "already have 3");
    const two = await connect(a, room.viewer2.id);
    await two.say(room.ch.slug, "!sr https://example.org/5");
    await waitBot(one, room, "number 4");
    const mod = await connect(a, room.mod.id);
    await mod.say(room.ch.slug, "!sr https://example.org/6");
    await waitBot(one, room, "queue is full");
    const queued = await t.db.select().from(schema.songRequests).where(eq(schema.songRequests.channelId, room.ch.id));
    expect(queued.map((r) => r.url).sort()).toEqual([1, 2, 3, 5].map((n) => `https://example.org/${n}`));
  });

  test("after a refusal, !sr from that user is silent for a few seconds", async () => {
    const room = await botRoom({ songRequests: { enabled: true, maxQueue: 25 } });
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!sr not-a-link");
    await waitBot(sender, room, "takes a link");
    await sender.say(room.ch.slug, "!sr still-not-a-link");
    await sender.say(room.ch.slug, "!sr https://example.org/song");
    await Bun.sleep(400);
    expect(botMessages(sender, room)).toHaveLength(1);
    const rows = await t.db.select().from(schema.songRequests).where(eq(schema.songRequests.channelId, room.ch.id));
    expect(rows).toHaveLength(0);
    // Another viewer is not held back by it.
    const other = await connect(a, room.viewer2.id);
    await other.say(room.ch.slug, "!sr https://example.org/other");
    await waitBot(other, room, "number 1");
  });

  test("!sr is silent when song requests are off", async () => {
    const room = await botRoom();
    const sender = await connect(a, room.viewer.id);
    await sender.say(room.ch.slug, "!sr https://example.org/song");
    expect(await sender.never(fromBot(room), 400)).toBe(true);
  });
});

describe("filters", () => {
  test("a caps drop with a timeout by the bot; moderators are exempt", async () => {
    const room = await botRoom({
      filters: {
        spam: { enabled: true, maxRepeatedChars: 12 },
        links: { enabled: true, allowSubscribers: false, allowlist: ["example.org"] },
        caps: { enabled: true, minLength: 10, maxRatio: 0.7 },
        timeoutSeconds: 5,
      },
    });
    const viewer = await connect(a, room.viewer.id);
    const mod = await connect(a, room.mod.id);
    const linker = await connect(a, room.viewer2.id);

    const ok = await linker.say(room.ch.slug, "see https://clips.example.org/x");
    expect(ok.notice).toBeNull();
    const link = await linker.say(room.ch.slug, "see evil.test now");
    expect(link.notice?.code).toBe("msg_links_blocked");
    expect(link.ack.id).toBeNull();

    const loud = await mod.say(room.ch.slug, "MODERATORS MAY SHOUT");
    expect(loud.notice).toBeNull();

    const r = await viewer.say(room.ch.slug, "THIS IS SHOUTING");
    expect(r.notice?.code).toBe("msg_rejected");
    expect(r.ack.id).toBeNull();
    const ban = await eventually(async () => {
      const [row] = await t.db
        .select()
        .from(schema.chatBans)
        .where(and(eq(schema.chatBans.channelId, room.ch.id), eq(schema.chatBans.userId, room.viewer.id)));
      return row;
    });
    expect(ban.moderatorId).toBe(room.bot.id);
    expect(ban.expiresAt).not.toBeNull();
  });
});

describe("timers", () => {
  test("fires once across two instances, and not below minChatLines", async () => {
    const room = await botRoom();
    const broadcastId = uuidv7();
    await t.db
      .insert(schema.broadcasts)
      .values({ id: broadcastId, channelId: room.ch.id, ingestProtocol: "rtmp", path: `live/${room.ch.slug}` });
    await t.db.update(schema.channels).set({ liveBroadcastId: broadcastId }).where(eq(schema.channels.id, room.ch.id));
    const timerId = uuidv7();
    await t.db.insert(schema.botTimers).values({
      id: timerId,
      channelId: room.ch.id,
      name: "follow",
      message: "Follow ${channel}! Live for ${uptime}.",
      intervalMinutes: 1,
      minChatLines: 3,
    });
    // Hosted on both instances: someone is in the room on each.
    const onA = await connect(a, room.viewer.id);
    const onB = await connect(b, room.viewer2.id);
    await onA.join(room.ch.slug);
    await onB.join(room.ch.slug);
    const tick = () => Promise.all([botA.engine()?.tickTimers(), botB.engine()?.tickTimers()]);

    await tick(); // first sight: the mark is set, nothing posts
    await onA.say(room.ch.slug, "one");
    await onB.say(room.ch.slug, "two");
    await tick();
    expect(await onA.never(fromBot(room), 300)).toBe(true);

    await onA.say(room.ch.slug, "three");
    await eventually(async () => Number(await valkey.get(KEYS.botLines(room.ch.id))) >= 3);
    await tick();
    const posted = await waitBot(onB, room, "Follow");
    expect(posted.message.body).toMatch(new RegExp(`^Follow ${room.ch.slug}! Live for \\d+s\\.$`));
    await tick();
    await Bun.sleep(300);
    expect(botMessages(onA, room)).toHaveLength(1);
    expect(botMessages(onB, room)).toHaveLength(1);
    const [timer] = await t.db.select().from(schema.botTimers).where(eq(schema.botTimers.id, timerId));
    expect(timer?.lastFiredAt).not.toBeNull();

    // Enough new lines, but the interval has not passed: still one post. The Valkey lock is cleared
    // first, so only the database claim can refuse it.
    for (const n of ["four", "five", "six"]) await onA.say(room.ch.slug, n);
    await eventually(async () => Number(await valkey.get(KEYS.botLines(room.ch.id))) >= 6);
    await valkey.del(KEYS.botTimerLock(timerId));
    await tick();
    await Bun.sleep(300);
    expect(botMessages(onA, room)).toHaveLength(1);

    // Once the interval has passed, it fires again, once. (New text: chat's duplicate window would
    // otherwise drop a second identical body.)
    await t.db
      .update(schema.botTimers)
      .set({ lastFiredAt: sql`now() - interval '2 minutes'`, message: "Second round" })
      .where(eq(schema.botTimers.id, timerId));
    await valkey.del(KEYS.botTimerLock(timerId));
    await tick();
    await waitBot(onA, room, "Second round");
    await Bun.sleep(300);
    expect(botMessages(onA, room)).toHaveLength(2);
    expect(botMessages(onB, room)).toHaveLength(2);
  });

  test("an offline channel's timer never fires", async () => {
    const room = await botRoom();
    await t.db.insert(schema.botTimers).values({
      channelId: room.ch.id,
      name: "t",
      message: "offline timer",
      intervalMinutes: 1,
      minChatLines: 1,
    });
    const c = await connect(a, room.viewer.id);
    await c.join(room.ch.slug);
    await botA.engine()?.tickTimers();
    await c.say(room.ch.slug, "a line");
    await c.say(room.ch.slug, "another line");
    await botA.engine()?.tickTimers();
    expect(await c.never(fromBot(room), 300)).toBe(true);
  });
});
