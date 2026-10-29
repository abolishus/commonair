// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E8-bot-api against Postgres and Valkey: the channel bot account (created once, a moderator,
 * username fallbacks), access, commands, timers, variables, song requests, and one
 * `BotControlMessage` per write on `BUS.botControl`.
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, subscriber, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
const db = () => api.db.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-10);

interface BotSettingsBody {
  enabled: boolean;
  config: { displayName: string; loyalty: { enabled: boolean; pointsName: string } };
  botUser: { id: string; username: string } | null;
}
interface CommandBody {
  id: string;
  name: string;
  aliases: string[];
  enabled: boolean;
  useCount: number;
}
interface TimerBody {
  id: string;
  name: string;
  minChatLines: number;
}
interface SongBody {
  id: string;
  url: string;
  requester: string;
  status: string;
}
interface ErrBody {
  data?: { requirement?: string };
}

async function newUser(username = `bt${rand()}`): Promise<string> {
  const [u] = await db()
    .insert(schema.users)
    .values({ name: username, email: `${username}@example.test`, username, emailVerified: true })
    .returning({ id: schema.users.id });
  return u!.id;
}

async function tokenFor(userId: string, scopes: string[]): Promise<string> {
  const raw = randomSecret("ca_", 24);
  await db()
    .insert(schema.oauthTokens)
    .values({
      appId: null,
      userId,
      kind: "personal",
      scopes,
      accessTokenHash: await sha256Hex(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  return raw;
}

interface Owner {
  userId: string;
  channelId: string;
  slug: string;
  c: Client;
}

/** A channel owner with a `channel:manage:bot` token (`slug` defaults to the username). */
async function newOwner(slug = `bt${rand()}`): Promise<Owner> {
  const userId = await newUser(slug);
  const [ch] = await db()
    .insert(schema.channels)
    .values({ ownerId: userId, slug, displayName: slug })
    .returning({ id: schema.channels.id });
  const c = client(api, { bearer: await tokenFor(userId, ["channel:manage:bot"]) });
  return { userId, channelId: ch!.id, slug, c };
}

const enable = (o: Owner, enabled = true, config: Record<string, unknown> = {}) =>
  o.c.call<BotSettingsBody>("PUT", `/api/channels/${o.slug}/bot`, { enabled, config });

const commandBody = (over: Record<string, unknown> = {}) => ({
  aliases: [],
  response: "Hi ${user}!",
  userLevel: "everyone",
  cooldownSeconds: 30,
  costPoints: 0,
  enabled: true,
  ...over,
});

const timerBody = (over: Record<string, unknown> = {}) => ({
  name: "Socials",
  message: "Follow along!",
  intervalMinutes: 15,
  minChatLines: 5,
  enabled: true,
  ...over,
});

/** Run `fn` and return the `BUS.botControl` messages for `channelId` it caused. */
async function botControl(channelId: string, fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const sub = subscriber();
  const got: Record<string, unknown>[] = [];
  sub.on("message", (_ch: string, raw: string) => got.push(JSON.parse(raw) as Record<string, unknown>));
  await sub.subscribe(BUS.botControl);
  try {
    await fn();
    await Bun.sleep(150);
    return got.filter((m) => m.channelId === channelId);
  } finally {
    await sub.quit();
  }
}

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("bot.settings", () => {
  test("defaults before the bot was ever enabled", async () => {
    const o = await newOwner();
    const r = await o.c.call<BotSettingsBody>("GET", `/api/channels/${o.slug}/bot`);
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.botUser).toBeNull();
    expect(r.body.config.displayName).toBe("ChannelBot");
    expect(r.body.config.loyalty).toEqual({ enabled: true, pointsName: "points" });
  });

  test("the first enable creates one moderator bot account; the next reuses it", async () => {
    const o = await newOwner();
    let first!: Awaited<ReturnType<typeof enable>>;
    const msgs = await botControl(o.channelId, async () => {
      first = await enable(o, true, { displayName: "Helper" });
    });
    expect(first.status).toBe(200);
    expect(msgs).toEqual([{ channelId: o.channelId, scope: "config" }]);
    const bot = first.body.botUser!;
    expect(bot.username).toBe(`${o.slug}_bot`);

    const [row] = await db().select().from(schema.users).where(eq(schema.users.id, bot.id));
    expect(row).toMatchObject({ accountType: "bot", botOwnerId: o.userId, name: "Helper", username: bot.username });
    const roles = await db()
      .select({ role: schema.channelRoles.role })
      .from(schema.channelRoles)
      .where(and(eq(schema.channelRoles.channelId, o.channelId), eq(schema.channelRoles.userId, bot.id)));
    expect(roles).toEqual([{ role: "moderator" }]);
    const audits = await db()
      .select({ action: schema.auditLog.action, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.channelId, o.channelId));
    expect(audits).toContainEqual({ action: "bot.settings.update", details: { enabled: true, botCreated: true } });
    expect(audits.map((a) => a.action)).toContain("channel.role.add");
    const events = await db()
      .select({ type: schema.events.type })
      .from(schema.events)
      .where(eq(schema.events.channelId, o.channelId));
    expect(events).toContainEqual({ type: "channel.moderator.add" });

    const second = await enable(o, true, { displayName: "Helper" });
    expect(second.body.botUser).toEqual(bot);
    const [{ n } = { n: 0 }] = await db()
      .select({ n: count() })
      .from(schema.users)
      .where(eq(schema.users.botOwnerId, o.userId));
    expect(n).toBe(1);
    const updates = await db()
      .select({ details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.channelId, o.channelId), eq(schema.auditLog.action, "bot.settings.update")));
    expect(updates.map((u) => u.details)).toContainEqual({ enabled: true, botCreated: false });

    const read = await o.c.call<BotSettingsBody>("GET", `/api/channels/${o.slug}/bot`);
    expect(read.body).toMatchObject({ enabled: true, botUser: bot, config: { displayName: "Helper" } });
  });

  test("saving with the bot off creates no account", async () => {
    const o = await newOwner();
    const r = await enable(o, false, { displayName: "Later" });
    expect(r.status).toBe(200);
    expect(r.body.botUser).toBeNull();
    const [{ n } = { n: 0 }] = await db()
      .select({ n: count() })
      .from(schema.users)
      .where(eq(schema.users.botOwnerId, o.userId));
    expect(n).toBe(0);
  });

  test("a taken <slug>_bot falls back to <slug-prefix>_bot<ddd>", async () => {
    const o = await newOwner();
    await newUser(`${o.slug}_bot`);
    const r = await enable(o);
    expect(r.status).toBe(200);
    expect(r.body.botUser!.username).toMatch(new RegExp(`^${o.slug.slice(0, 18)}_bot\\d{3}$`));
  });

  test("a reserved slug falls back to channelbot_<hex>", async () => {
    const o = await newOwner(`mod_${rand()}`);
    const r = await enable(o);
    expect(r.status).toBe(200);
    expect(r.body.botUser!.username).toMatch(/^channelbot_[0-9a-f]{6}$/);
  });

  test("disabling keeps the account and the role", async () => {
    const o = await newOwner();
    const bot = (await enable(o)).body.botUser!;
    const off = await enable(o, false);
    expect(off.body).toMatchObject({ enabled: false, botUser: bot });
    const roles = await db()
      .select()
      .from(schema.channelRoles)
      .where(and(eq(schema.channelRoles.channelId, o.channelId), eq(schema.channelRoles.userId, bot.id)));
    expect(roles).toHaveLength(1);
  });

  test("a display name change renames the bot user and invalidates its profile", async () => {
    const o = await newOwner();
    const bot = (await enable(o, true, { displayName: "One" })).body.botUser!;
    const sub = subscriber();
    const got: Record<string, unknown>[] = [];
    sub.on("message", (_ch: string, raw: string) => got.push(JSON.parse(raw) as Record<string, unknown>));
    await sub.subscribe(BUS.userControl);
    try {
      expect((await enable(o, true, { displayName: "Two" })).status).toBe(200);
      await Bun.sleep(150);
    } finally {
      await sub.quit();
    }
    const [row] = await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, bot.id));
    expect(row?.name).toBe("Two");
    expect(got.filter((m) => m.userId === bot.id)).toEqual([
      expect.objectContaining({ op: "invalidate", userId: bot.id, reason: "profile_changed" }),
    ]);
  });

  test("viewers and tokens without channel:manage:bot are refused", async () => {
    const o = await newOwner();
    const viewerId = await newUser();
    const viewer = client(api, { bearer: await tokenFor(viewerId, ["channel:manage:bot"]) });
    expect((await viewer.call("PUT", `/api/channels/${o.slug}/bot`, { enabled: true, config: {} })).status).toBe(403);
    expect((await viewer.call("GET", `/api/channels/${o.slug}/bot`)).status).toBe(403);
    const unscoped = client(api, { bearer: await tokenFor(o.userId, ["chat:read"]) });
    expect((await unscoped.call("PUT", `/api/channels/${o.slug}/bot`, { enabled: true, config: {} })).status).toBe(403);
    expect((await unscoped.call("PUT", `/api/channels/${o.slug}/bot/commands/hi`, commandBody())).status).toBe(403);
    expect((await client(api).call("PUT", `/api/channels/${o.slug}/bot`, { enabled: true, config: {} })).status).toBe(
      401,
    );
    // A moderator may manage commands but not the settings (owner procedures).
    const modId = await newUser();
    await db().insert(schema.channelRoles).values({ channelId: o.channelId, userId: modId, role: "moderator" });
    const mod = client(api, { bearer: await tokenFor(modId, ["channel:manage:bot"]) });
    expect((await mod.call("PUT", `/api/channels/${o.slug}/bot`, { enabled: true, config: {} })).status).toBe(403);
    expect((await mod.call("PUT", `/api/channels/${o.slug}/bot/commands/hi`, commandBody())).status).toBe(200);
    const [{ n } = { n: 0 }] = await db()
      .select({ n: count() })
      .from(schema.users)
      .where(eq(schema.users.botOwnerId, o.userId));
    expect(n).toBe(0);
  });
});

describe("bot.commands", () => {
  test("built-in names and aliases are refused", async () => {
    const o = await newOwner();
    expect((await o.c.call("PUT", `/api/channels/${o.slug}/bot/commands/points`, commandBody())).status).toBe(400);
    expect(
      (await o.c.call("PUT", `/api/channels/${o.slug}/bot/commands/song`, commandBody({ aliases: ["sr"] }))).status,
    ).toBe(400);
  });

  test("a name or alias another command uses is a conflict", async () => {
    const o = await newOwner();
    const put = (name: string, aliases: string[] = []) =>
      o.c.call("PUT", `/api/channels/${o.slug}/bot/commands/${name}`, commandBody({ aliases }));
    expect((await put("hello", ["hi"])).status).toBe(200);
    expect((await put("hi")).status).toBe(409);
    expect((await put("greet", ["hello"])).status).toBe(409);
    expect((await put("wave", ["hi"])).status).toBe(409);
    // The command itself may keep or change its own aliases.
    expect((await put("hello", ["hi", "hey"])).status).toBe(200);
    expect((await put("wave", ["yo"])).status).toBe(200);
  });

  test("an update keeps useCount; remove of a missing command is NOT_FOUND", async () => {
    const o = await newOwner();
    let created!: { status: number; body: CommandBody };
    const msgs = await botControl(o.channelId, async () => {
      created = await o.c.call<CommandBody>("PUT", `/api/channels/${o.slug}/bot/commands/hello`, commandBody());
    });
    expect(msgs).toEqual([{ channelId: o.channelId, scope: "commands" }]);
    await db().update(schema.botCommands).set({ useCount: 7 }).where(eq(schema.botCommands.id, created.body.id));
    const updated = await o.c.call<CommandBody>(
      "PUT",
      `/api/channels/${o.slug}/bot/commands/hello`,
      commandBody({ response: "Hey ${user}", aliases: ["hi", "hi"] }),
    );
    expect(updated.body).toMatchObject({ id: created.body.id, useCount: 7, aliases: ["hi"] });

    const removeMsgs = await botControl(o.channelId, async () => {
      expect((await o.c.call("DELETE", `/api/channels/${o.slug}/bot/commands/hello`)).status).toBe(200);
    });
    expect(removeMsgs).toEqual([{ channelId: o.channelId, scope: "commands" }]);
    expect((await o.c.call("DELETE", `/api/channels/${o.slug}/bot/commands/hello`)).status).toBe(404);
    const audits = await db()
      .select({ action: schema.auditLog.action, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, created.body.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "bot.command.remove",
      "bot.command.upsert",
      "bot.command.upsert",
    ]);
    expect(JSON.stringify(audits)).not.toContain("Hey");
  });

  test("at most 200 commands per channel; existing ones still update", async () => {
    const o = await newOwner();
    await db()
      .insert(schema.botCommands)
      .values(Array.from({ length: 200 }, (_, i) => ({ channelId: o.channelId, name: `c${i}`, response: "x" })));
    const r = await o.c.call<ErrBody>("PUT", `/api/channels/${o.slug}/bot/commands/one_more`, commandBody());
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "bot_command_limit" });
    expect((await o.c.call("PUT", `/api/channels/${o.slug}/bot/commands/c5`, commandBody())).status).toBe(200);
  });

  test("viewers see enabled commands; the owner and moderators see all", async () => {
    const o = await newOwner();
    await o.c.call("PUT", `/api/channels/${o.slug}/bot/commands/shown`, commandBody());
    await o.c.call("PUT", `/api/channels/${o.slug}/bot/commands/hidden`, commandBody({ enabled: false }));
    const names = (r: { body: CommandBody[] }) => r.body.map((c) => c.name);

    const anon = await client(api).call<CommandBody[]>("GET", `/api/channels/${o.slug}/bot/commands`);
    expect(anon.status).toBe(200);
    expect(names(anon)).toEqual(["shown"]);
    expect(names(await o.c.call<CommandBody[]>("GET", `/api/channels/${o.slug}/bot/commands`))).toEqual([
      "hidden",
      "shown",
    ]);
    const modId = await newUser();
    await db().insert(schema.channelRoles).values({ channelId: o.channelId, userId: modId, role: "moderator" });
    const mod = client(api, { bearer: await tokenFor(modId, []) });
    expect(names(await mod.call<CommandBody[]>("GET", `/api/channels/${o.slug}/bot/commands`))).toEqual([
      "hidden",
      "shown",
    ]);
    const viewer = client(api, { bearer: await tokenFor(await newUser(), []) });
    expect(names(await viewer.call<CommandBody[]>("GET", `/api/channels/${o.slug}/bot/commands`))).toEqual(["shown"]);
    expect((await client(api).call("GET", `/api/channels/nochannel_${rand()}/bot/commands`)).status).toBe(404);
  });
});

describe("session-only reads", () => {
  test("timers, variables and song requests list over the owner's session", async () => {
    const owner = await signUpAndSignIn(api);
    const viewer = await signUpAndSignIn(api);
    const [ch] = await db()
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.slug, owner.username));
    const channelId = ch!.id;
    const base = `/api/channels/${owner.username}/bot`;

    expect((await owner.client.call("PUT", `${base}/timers`, timerBody())).status).toBe(200);
    expect((await owner.client.call("PUT", `${base}/variables/deaths`, { value: "3" })).status).toBe(200);
    await db()
      .insert(schema.songRequests)
      .values({ channelId, requesterId: viewer.userId, url: "https://example.org/a" });

    const timers = await owner.client.call<TimerBody[]>("GET", `${base}/timers`);
    expect(timers.body.map((t) => t.name)).toEqual(["Socials"]);
    expect((await owner.client.call("GET", `${base}/variables`)).body).toEqual([{ name: "deaths", value: "3" }]);
    const songs = await owner.client.call<SongBody[]>("GET", `${base}/song-requests`);
    expect(songs.body).toEqual([expect.objectContaining({ url: "https://example.org/a", requester: viewer.username })]);
    expect(
      (await owner.client.call("PUT", `${base}/song-requests/${songs.body[0]!.id}`, { status: "skipped" })).status,
    ).toBe(200);
    expect((await owner.client.call<SongBody[]>("GET", `${base}/song-requests`)).body).toEqual([]);
    const skipped = await owner.client.call<SongBody[]>("GET", `${base}/song-requests?status=skipped`);
    expect(skipped.body.map((s) => s.status)).toEqual(["skipped"]);

    for (const path of ["timers", "variables", "song-requests"])
      expect((await viewer.client.call("GET", `${base}/${path}`)).status).toBe(403);
  });
});

describe("bot.timers", () => {
  test("create, update, and NOT_FOUND for another channel's timer", async () => {
    const o = await newOwner();
    const other = await newOwner();
    let created!: { status: number; body: TimerBody };
    const msgs = await botControl(o.channelId, async () => {
      created = await o.c.call<TimerBody>("PUT", `/api/channels/${o.slug}/bot/timers`, timerBody());
    });
    expect(created.status).toBe(200);
    expect(msgs).toEqual([{ channelId: o.channelId, scope: "timers" }]);

    const updated = await o.c.call<TimerBody>(
      "PUT",
      `/api/channels/${o.slug}/bot/timers`,
      timerBody({ id: created.body.id, minChatLines: 9 }),
    );
    expect(updated.body).toMatchObject({ id: created.body.id, minChatLines: 9 });

    const foreign = await other.c.call(
      "PUT",
      `/api/channels/${other.slug}/bot/timers`,
      timerBody({ id: created.body.id }),
    );
    expect(foreign.status).toBe(404);
    expect((await other.c.call("DELETE", `/api/channels/${other.slug}/bot/timers/${created.body.id}`)).status).toBe(
      404,
    );
    const removeMsgs = await botControl(o.channelId, async () => {
      expect((await o.c.call("DELETE", `/api/channels/${o.slug}/bot/timers/${created.body.id}`)).status).toBe(200);
    });
    expect(removeMsgs).toEqual([{ channelId: o.channelId, scope: "timers" }]);
    expect((await o.c.call("DELETE", `/api/channels/${o.slug}/bot/timers/${created.body.id}`)).status).toBe(404);
  });

  test("minChatLines 0 is refused by the contract", async () => {
    const o = await newOwner();
    expect((await o.c.call("PUT", `/api/channels/${o.slug}/bot/timers`, timerBody({ minChatLines: 0 }))).status).toBe(
      400,
    );
  });

  test("at most 20 timers per channel", async () => {
    const o = await newOwner();
    await db()
      .insert(schema.botTimers)
      .values(
        Array.from({ length: 20 }, (_, i) => ({
          channelId: o.channelId,
          name: `t${i}`,
          message: "m",
          intervalMinutes: 5,
        })),
      );
    const r = await o.c.call<ErrBody>("PUT", `/api/channels/${o.slug}/bot/timers`, timerBody());
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "bot_timer_limit" });
  });
});

describe("bot.variables", () => {
  test("set upserts, allows an empty value, and publishes", async () => {
    const o = await newOwner();
    const msgs = await botControl(o.channelId, async () => {
      expect((await o.c.call("PUT", `/api/channels/${o.slug}/bot/variables/deaths`, { value: "1" })).status).toBe(200);
    });
    expect(msgs).toEqual([{ channelId: o.channelId, scope: "variables" }]);
    expect((await o.c.call("PUT", `/api/channels/${o.slug}/bot/variables/deaths`, { value: "" })).status).toBe(200);
    const rows = await db()
      .select({ name: schema.botVariables.name, value: schema.botVariables.value })
      .from(schema.botVariables)
      .where(eq(schema.botVariables.channelId, o.channelId));
    expect(rows).toEqual([{ name: "deaths", value: "" }]);
    expect((await o.c.call("PUT", `/api/channels/${o.slug}/bot/variables/Bad-Name`, { value: "x" })).status).toBe(400);
  });

  test("at most 100 variables per channel; existing ones still update", async () => {
    const o = await newOwner();
    await db()
      .insert(schema.botVariables)
      .values(Array.from({ length: 100 }, (_, i) => ({ channelId: o.channelId, name: `v${i}`, value: "x" })));
    const r = await o.c.call<ErrBody>("PUT", `/api/channels/${o.slug}/bot/variables/extra`, { value: "x" });
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "bot_variable_limit" });
    expect((await o.c.call("PUT", `/api/channels/${o.slug}/bot/variables/v1`, { value: "y" })).status).toBe(200);
  });
});

describe("bot.songRequests", () => {
  test("only a queued request moves to played or skipped", async () => {
    const o = await newOwner();
    const requesterName = `bt${rand()}`;
    const requesterId = await newUser(requesterName);
    const [a] = await db()
      .insert(schema.songRequests)
      .values({ channelId: o.channelId, requesterId, url: "https://example.org/a" })
      .returning({ id: schema.songRequests.id });
    const [b] = await db()
      .insert(schema.songRequests)
      .values({ channelId: o.channelId, requesterId, url: "https://example.org/b" })
      .returning({ id: schema.songRequests.id });

    const played = await o.c.call<SongBody>("PUT", `/api/channels/${o.slug}/bot/song-requests/${a!.id}`, {
      status: "played",
    });
    expect(played.status).toBe(200);
    expect(played.body).toMatchObject({ id: a!.id, status: "played", requester: requesterName });
    expect(
      (await o.c.call("PUT", `/api/channels/${o.slug}/bot/song-requests/${a!.id}`, { status: "skipped" })).status,
    ).toBe(409);
    expect(
      (await o.c.call("PUT", `/api/channels/${o.slug}/bot/song-requests/${uuidv7()}`, { status: "skipped" })).status,
    ).toBe(404);
    expect(
      (await o.c.call("PUT", `/api/channels/${o.slug}/bot/song-requests/${b!.id}`, { status: "queued" })).status,
    ).toBe(400);

    // Another channel cannot move this channel's request.
    const other = await newOwner();
    expect(
      (await other.c.call("PUT", `/api/channels/${other.slug}/bot/song-requests/${b!.id}`, { status: "skipped" }))
        .status,
    ).toBe(404);

    const [audit] = await db()
      .select({ action: schema.auditLog.action, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, a!.id));
    expect(audit).toEqual({ action: "bot.song_request.status", details: { status: "played" } });

    const rows = await db()
      .select({ status: schema.songRequests.status })
      .from(schema.songRequests)
      .where(eq(schema.songRequests.id, b!.id));
    expect(rows).toEqual([{ status: "queued" }]);
  });
});
