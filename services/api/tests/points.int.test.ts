// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bot.points.*` over HTTP (ADR 0026 decision 2): balances and the leaderboard are public reads;
 * `adjust` is a moderator action with the `channel:manage:points` scope that writes the ledger
 * row, an audit row with codes only and `channel.points.change`, or nothing at all on an overdraw.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { EVENTS } from "@commonair/contracts/events";
import { BotConfig } from "@commonair/contracts/shapes";
import { schema as s, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { client, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-10);

async function newUser(opts: { bot?: boolean; pseudonymized?: boolean } = {}) {
  const username = `pt_${rand()}`;
  const [u] = await db()
    .insert(s.users)
    .values({
      name: username,
      username,
      email: `${username}@example.test`,
      emailVerified: true,
      accountType: opts.bot ? "bot" : "human",
      pseudonymizedAt: opts.pseudonymized ? new Date() : null,
    })
    .returning({ id: s.users.id, username: s.users.username });
  if (!u) throw new Error("no user");
  return u;
}

async function newChannel(config?: unknown) {
  const owner = await newUser();
  const [c] = await db()
    .insert(s.channels)
    .values({ ownerId: owner.id, slug: owner.username, displayName: `Display ${owner.username}` })
    .returning({ id: s.channels.id, slug: s.channels.slug });
  if (!c) throw new Error("no channel");
  if (config !== undefined)
    await db()
      .insert(s.botConfigs)
      .values({ channelId: c.id, config: BotConfig.parse(config) });
  return { ...c, owner };
}

async function bearer(userId: string, scopes: string[]): Promise<string> {
  const raw = randomSecret("ca_", 24);
  await db()
    .insert(s.oauthTokens)
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

async function moderator(channelId: string) {
  const m = await newUser();
  await db().insert(s.channelRoles).values({ channelId, userId: m.id, role: "moderator" });
  return m;
}

/** Credit points as the worker would (the trigger writes the balance). */
const credit = (channelId: string, userId: string, delta: number) =>
  db().insert(s.loyaltyTransactions).values({ channelId, userId, delta, reason: "watch" });

const count = async (table: typeof s.loyaltyTransactions | typeof s.auditLog | typeof s.events, channelId: string) => {
  const [r] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.channelId, channelId));
  return r?.n ?? 0;
};

const anon = () => client(api);
const pointsPath = (channel: string, username?: string) =>
  `/api/channels/${channel}/points${username ? `/${username}` : ""}`;

describe("balance", () => {
  test("a stranger has 0 with the default name, points on", async () => {
    const c = await newChannel();
    const v = await newUser();
    const r = await anon().call("GET", pointsPath(c.slug, v.username));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      channelSlug: c.slug,
      user: { id: v.id, username: v.username },
      points: 0,
      pointsName: "points",
      enabled: true,
    });
  });

  test("the channel's points name and switch come from its bot config", async () => {
    const c = await newChannel({ loyalty: { enabled: false, pointsName: "beans" } });
    const v = await newUser();
    await credit(c.id, v.id, 70);
    const r = await anon().call("GET", pointsPath(c.slug, v.username));
    expect(r.body).toMatchObject({ points: 70, pointsName: "beans", enabled: false });
  });

  test("unknown channel or user → NOT_FOUND", async () => {
    const c = await newChannel();
    const v = await newUser();
    expect((await anon().call("GET", pointsPath("nochannel_here", v.username))).status).toBe(404);
    expect((await anon().call("GET", pointsPath(c.slug, "nobody_here"))).status).toBe(404);
  });
});

describe("leaderboard", () => {
  test("most points first, ties by user id, limited; zero balances and deleted accounts left out", async () => {
    const c = await newChannel();
    const [a, b, d, gone, zero] = await Promise.all([
      newUser(),
      newUser(),
      newUser(),
      newUser({ pseudonymized: true }),
      newUser(),
    ]);
    await credit(c.id, a!.id, 50);
    await credit(c.id, b!.id, 100);
    await credit(c.id, d!.id, 100);
    await credit(c.id, gone!.id, 500);
    await credit(c.id, zero!.id, 10);
    await db().insert(s.loyaltyTransactions).values({
      channelId: c.id,
      userId: zero!.id,
      delta: -10,
      reason: "command",
    });
    const tied = [b!, d!].sort((x, y) => (x.id < y.id ? -1 : 1));

    const all = await anon().call<{ user: { id: string }; points: number }[]>("GET", `${pointsPath(c.slug)}?limit=10`);
    expect(all.status).toBe(200);
    expect(all.body.map((r) => [r.user.id, r.points])).toEqual([
      [tied[0]!.id, 100],
      [tied[1]!.id, 100],
      [a!.id, 50],
    ]);
    const top = await anon().call<unknown[]>("GET", `${pointsPath(c.slug)}?limit=2`);
    expect(top.body).toHaveLength(2);
    expect(top.body[0]).toMatchObject({ channelSlug: c.slug, pointsName: "points", enabled: true });
  });

  test("limit out of range → BAD_REQUEST; unknown channel → NOT_FOUND", async () => {
    const c = await newChannel();
    expect((await anon().call("GET", `${pointsPath(c.slug)}?limit=101`)).status).toBe(400);
    expect((await anon().call("GET", pointsPath("nochannel_here"))).status).toBe(404);
  });
});

describe("adjust", () => {
  test("a moderator credits and debits; ledger, audit (codes only) and a valid event in one go", async () => {
    const c = await newChannel();
    const m = await moderator(c.id);
    const v = await newUser();
    const mod = client(api, { bearer: await bearer(m.id, ["channel:manage:points"]) });

    const up = await mod.call("POST", pointsPath(c.slug, v.username), { delta: 100, reason: "reward" });
    expect(up.status).toBe(200);
    expect(up.body).toEqual({
      channelSlug: c.slug,
      user: { id: v.id, username: v.username },
      points: 100,
      pointsName: "points",
      enabled: true,
    });
    const down = await mod.call("POST", pointsPath(c.slug, v.username), { delta: -40, reason: "penalty" });
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ points: 60 });

    const ledger = await db()
      .select()
      .from(s.loyaltyTransactions)
      .where(eq(s.loyaltyTransactions.channelId, c.id))
      .orderBy(s.loyaltyTransactions.createdAt);
    expect(ledger.map((r) => [r.delta, r.reason, r.userId])).toEqual([
      [100, "moderator_adjust", v.id],
      [-40, "moderator_adjust", v.id],
    ]);

    const audits = await db()
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.channelId, c.id), eq(s.auditLog.action, "points.adjust")))
      .orderBy(s.auditLog.createdAt);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ actorType: "user", actorId: m.id, subjectType: "user", subjectId: v.id });
    expect(audits[0]?.reason).toBe("");
    expect(audits.map((a) => a.details)).toEqual([
      { transactionId: ledger[0]!.id, delta: 100, reason: "reward" },
      { transactionId: ledger[1]!.id, delta: -40, reason: "penalty" },
    ]);

    const events = await db()
      .select()
      .from(s.events)
      .where(and(eq(s.events.channelId, c.id), eq(s.events.type, "channel.points.change")))
      .orderBy(s.events.occurredAt);
    expect(events).toHaveLength(2);
    const payload = EVENTS["channel.points.change"].payload.parse(events[1]?.payload);
    expect(payload).toEqual({
      broadcaster_user_id: c.owner.id,
      broadcaster_user_login: c.slug,
      broadcaster_user_name: `Display ${c.slug}`,
      user_id: v.id,
      user_login: v.username,
      user_name: v.username,
      delta: -40,
      balance: 60,
      reason: "moderator_adjust",
    });
  });

  test("the owner may adjust on their own channel", async () => {
    const c = await newChannel();
    const v = await newUser();
    const owner = client(api, { bearer: await bearer(c.owner.id, ["channel:manage:points"]) });
    const r = await owner.call("POST", pointsPath(c.slug, v.username), { delta: 5, reason: "correction" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ points: 5 });
  });

  test("an overdraw → PRECONDITION_FAILED insufficient_points, and nothing is written", async () => {
    const c = await newChannel();
    const m = await moderator(c.id);
    const v = await newUser();
    await credit(c.id, v.id, 30);
    const before = await Promise.all([
      count(s.loyaltyTransactions, c.id),
      count(s.auditLog, c.id),
      count(s.events, c.id),
    ]);
    const mod = client(api, { bearer: await bearer(m.id, ["channel:manage:points"]) });
    const r = await mod.call<{ code: string; data: { requirement: string } }>("POST", pointsPath(c.slug, v.username), {
      delta: -31,
      reason: "penalty",
    });
    expect(r.status).toBe(412);
    expect(r.body).toMatchObject({ code: "PRECONDITION_FAILED", data: { requirement: "insufficient_points" } });
    const after = await Promise.all([
      count(s.loyaltyTransactions, c.id),
      count(s.auditLog, c.id),
      count(s.events, c.id),
    ]);
    expect(after).toEqual(before);
    expect((await anon().call("GET", pointsPath(c.slug, v.username))).body).toMatchObject({ points: 30 });
  });

  test("delta 0, an unknown, deleted or bot target are refused", async () => {
    const c = await newChannel();
    const m = await moderator(c.id);
    const bot = await newUser({ bot: true });
    const gone = await newUser({ pseudonymized: true });
    const mod = client(api, { bearer: await bearer(m.id, ["channel:manage:points"]) });
    expect((await mod.call("POST", pointsPath(c.slug, m.username), { delta: 0, reason: "other" })).status).toBe(400);
    expect((await mod.call("POST", pointsPath(c.slug, "nobody_here"), { delta: 5, reason: "other" })).status).toBe(404);
    expect((await mod.call("POST", pointsPath(c.slug, gone.username), { delta: 5, reason: "other" })).status).toBe(404);
    expect((await mod.call("POST", pointsPath(c.slug, bot.username), { delta: 5, reason: "other" })).status).toBe(400);
    expect(
      (await mod.call("POST", pointsPath(c.slug, m.username), { delta: 5, reason: "free text here" })).status,
    ).toBe(400);
    expect(await count(s.loyaltyTransactions, c.id)).toBe(0);
  });

  test("a viewer without the role → FORBIDDEN; a token without channel:manage:points is refused", async () => {
    const c = await newChannel();
    const v = await newUser();
    const m = await moderator(c.id);
    const viewer = client(api, { bearer: await bearer(v.id, ["channel:manage:points"]) });
    expect((await viewer.call("POST", pointsPath(c.slug, v.username), { delta: 5, reason: "reward" })).status).toBe(
      403,
    );
    const narrow = client(api, { bearer: await bearer(m.id, ["chat:read"]) });
    expect((await narrow.call("POST", pointsPath(c.slug, v.username), { delta: 5, reason: "reward" })).status).toBe(
      403,
    );
    expect((await anon().call("POST", pointsPath(c.slug, v.username), { delta: 5, reason: "reward" })).status).toBe(
      401,
    );
    expect(await count(s.loyaltyTransactions, c.id)).toBe(0);
  });
});
