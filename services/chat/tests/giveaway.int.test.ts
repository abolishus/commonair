// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The giveaway keyword plugin (ADR 0039 §2) on a real chat instance and database: the keyword
 * (any case) enters the sender once, through the shared eligibility rules; the bot confirms at most
 * once per interval and never lists entrants; other messages and closed giveaways enter nobody; and
 * with `GIVEAWAYS_ENABLED` off the plugin does nothing.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import type { ServerFrame } from "@commonair/contracts";
import { BotConfig } from "@commonair/contracts/shapes";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
// The chat service does not depend on packages/draw; the test reads it by path, as other tests do.
import { commit, newSalt, newSeed, pseudonym } from "../../../packages/draw/src/index.ts";
import { createGiveawayMiddleware, type GiveawayMiddleware } from "../src/plugins/giveaway.ts";
import type { ChatService } from "../src/server.ts";
import { chatToken, Client, createChannel, createUser, eventually, isolation, startInstance } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let on: ChatService;
let off: ChatService;
let plugin: GiveawayMiddleware;
let offPlugin: GiveawayMiddleware;
const clients: Client[] = [];

const connect = async (svc: ChatService, uid: string) => {
  const c = await Client.connect(svc, { token: await chatToken(uid) });
  clients.push(c);
  return c;
};

beforeAll(async () => {
  t = await createTestDatabase();
  plugin = createGiveawayMiddleware({ enabled: true, replyIntervalMs: 60_000, cacheMs: 0 });
  offPlugin = createGiveawayMiddleware({ enabled: false, cacheMs: 0 });
  // Separate isolations: each instance runs only its own plugin.
  on = await startInstance(t.app.db, isolation(), { middlewares: [plugin] });
  off = await startInstance(t.app.db, isolation(), { middlewares: [offPlugin] });
});

afterAll(async () => {
  for (const c of clients) c.close();
  await Promise.allSettled([on?.stop(), off?.stop()]);
  await t?.drop();
});

/** A channel with its bot on and an open keyword giveaway. */
async function room(eligibility: Partial<{ minVerifiedWatchSeconds: number }> = {}) {
  const owner = await createUser(t.db);
  const bot = await createUser(t.db, { accountType: "bot", botOwnerId: owner.id });
  const ch = await createChannel(t.db, owner);
  await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: bot.id, role: "moderator" });
  await t.db
    .insert(schema.botConfigs)
    .values({ channelId: ch.id, enabled: true, config: BotConfig.parse({}), botUserId: bot.id });
  const id = uuidv7();
  const salt = newSalt();
  await t.db.insert(schema.giveaways).values({
    id,
    channelId: ch.id,
    title: "t",
    prize: "p",
    eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0, ...eligibility },
    winnerCount: 1,
    keyword: "!win",
    seedCommitment: await commit(newSeed()),
    sealedSeed: "v1.sealed",
    salt,
  });
  return { owner, bot, ch, id, salt };
}

const entriesOf = (giveawayId: string) =>
  t.db.select().from(schema.giveawayEntries).where(eq(schema.giveawayEntries.giveawayId, giveawayId));
const fromBot = (botId: string) => (f: ServerFrame) => f.op === "message" && f.message.user.id === botId;

describe("keyword entry", () => {
  test("the keyword enters the sender once, with their pseudonym; the bot confirms once per interval", async () => {
    const r = await room();
    const [v1, v2] = [await createUser(t.db), await createUser(t.db)];
    const c1 = await connect(on, v1.id);
    const c2 = await connect(on, v2.id);
    await c1.join(r.ch.slug);
    await c2.join(r.ch.slug);

    const before = plugin.entered();
    const sent = await c1.say(r.ch.slug, "!WIN");
    expect(sent.notice).toBeNull();
    const rows = await eventually(async () => {
      const e = await entriesOf(r.id);
      return e.length === 1 ? e : null;
    });
    expect(rows[0]).toMatchObject({ userId: v1.id, pseudonym: await pseudonym(r.salt, v1.id) });
    const reply = (await c2.waitFor<"message">(fromBot(r.bot.id), 5_000)).message;
    expect(reply.body).toContain(`@${v1.username}`);
    expect(reply.body).not.toContain(v2.username);

    await c2.say(r.ch.slug, "!win");
    await eventually(async () => ((await entriesOf(r.id)).length === 2 ? true : null));
    // Rate limited: no second confirmation within the interval.
    expect(
      await c1.never((f) => fromBot(r.bot.id)(f) && f.op === "message" && f.message.body.includes(v2.username), 500),
    ).toBe(true);
    // The same keyword again does not enter twice.
    await c1.say(r.ch.slug, "!win");
    await new Promise((res) => setTimeout(res, 300));
    expect(await entriesOf(r.id)).toHaveLength(2);
    expect(plugin.entered() - before).toBe(2);
  });

  test("other messages and a closed giveaway enter nobody", async () => {
    const r = await room();
    const v = await createUser(t.db);
    const c = await connect(on, v.id);
    await c.join(r.ch.slug);
    await c.say(r.ch.slug, "win");
    await c.say(r.ch.slug, "!win please");
    await new Promise((res) => setTimeout(res, 300));
    expect(await entriesOf(r.id)).toHaveLength(0);
    await t.db.update(schema.giveaways).set({ status: "closed" }).where(eq(schema.giveaways.id, r.id));
    await c.say(r.ch.slug, "!win");
    await new Promise((res) => setTimeout(res, 300));
    expect(await entriesOf(r.id)).toHaveLength(0);
  });

  test("the shared eligibility rules apply: an unverified sender is not entered", async () => {
    const r = await room({ minVerifiedWatchSeconds: 60 });
    const v = await createUser(t.db);
    const c = await connect(on, v.id);
    await c.join(r.ch.slug);
    await c.say(r.ch.slug, "!win");
    await new Promise((res) => setTimeout(res, 300));
    expect(await entriesOf(r.id)).toHaveLength(0);
    expect(await c.never(fromBot(r.bot.id), 200)).toBe(true);
  });

  test("with GIVEAWAYS_ENABLED off the plugin does nothing", async () => {
    const r = await room();
    const v = await createUser(t.db);
    const c = await connect(off, v.id);
    await c.join(r.ch.slug);
    const sent = await c.say(r.ch.slug, "!win");
    expect(sent.notice).toBeNull();
    await new Promise((res) => setTimeout(res, 400));
    expect(await entriesOf(r.id)).toHaveLength(0);
    expect(offPlugin.entered()).toBe(0);
    const [still] = await t.db
      .select()
      .from(schema.giveaways)
      .where(and(eq(schema.giveaways.id, r.id), eq(schema.giveaways.status, "open")));
    expect(still).toBeDefined();
  });
});
