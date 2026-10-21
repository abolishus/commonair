// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Demo seed and clear against a real database, as the least-privilege app role (proving that
 * role is enough). Real-looking users with similar data, and users carrying only one anchor,
 * must survive a clear untouched.
 */
import { count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { anchoredUser } from "../src/demo/anchors.ts";
import { clearDemo } from "../src/demo/clear.ts";
import { DEMO_CHAT, DEMO_HANDLES, DEMO_STREAMERS } from "../src/demo/data.ts";
import { verifyPassword } from "../src/demo/password.ts";
import { countAnchoredUsers, seedDemo } from "../src/demo/seed.ts";

// Postgres runs DROP DATABASE one at a time: when many files finish together, teardown queues.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const byText = (a: string, b: string) => a.localeCompare(b);

let t: TestDatabase;
let app: Database;
const PASSWORD = "demo-password-for-tests";

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

/** Non-demo data that shares tables (and even channels) with the demo data. */
interface RealData {
  realUser: string;
  realChannel: string;
  realBroadcast: string;
  realKey: string;
  realBot: string;
  /** Username `demo_…` but a normal email: one anchor only. */
  prefixOnly: string;
  /** Fixture email but a normal username: one anchor only. */
  domainOnly: string;
  domainOnlyChannel: string;
  realAudit: string;
  ids: { follows: number; messages: string[]; bans: string[]; sessions: string[] };
}

async function insertUser(username: string, email: string, extra: Partial<typeof s.users.$inferInsert> = {}) {
  const id = uuidv7();
  await app.insert(s.users).values({ id, name: username, email, username, emailVerified: true, ...extra });
  return id;
}
async function insertChannel(ownerId: string, slug: string) {
  const id = uuidv7();
  await app.insert(s.channels).values({ id, ownerId, slug, displayName: slug, title: "Real stream", tags: ["real"] });
  return id;
}

async function insertRealData(): Promise<RealData> {
  const [demoChannel] = await app
    .select({ id: s.channels.id, ownerId: s.channels.ownerId })
    .from(s.channels)
    .innerJoin(s.users, eq(s.users.id, s.channels.ownerId))
    .where(anchoredUser())
    .limit(1);
  const [demoViewer] = await app
    .select({ id: s.users.id })
    .from(s.users)
    .where(sql`${anchoredUser()} and ${s.users.username} = 'demo_viewer2'`);
  if (!demoChannel || !demoViewer) throw new Error("seed first");

  const realUser = await insertUser("realstreamer", "realstreamer@example.org");
  const realChannel = await insertChannel(realUser, "realstreamer");
  const realBot = await insertUser("realbot", `bot+${uuidv7()}@bots.invalid`, {
    accountType: "bot",
    botOwnerId: realUser,
  });
  const prefixOnly = await insertUser("demo_lookalike", "lookalike@example.org");
  const domainOnly = await insertUser("domainonly", "domainonly@demo-seed.invalid");
  const domainOnlyChannel = await insertChannel(domainOnly, "domainonly");
  const realBroadcast = uuidv7();
  await app.insert(s.broadcasts).values({
    id: realBroadcast,
    channelId: realChannel,
    ingestProtocol: "rtmp",
    path: "live/realstreamer",
    startedAt: new Date(Date.now() - 3_600_000),
    endedAt: new Date(),
  });
  const realKey = uuidv7();
  await app
    .insert(s.streamKeys)
    .values({ id: realKey, channelId: realChannel, keyHash: `h${uuidv7()}`, prefix: "live_realkey" });

  // Follows among real users, plus a demo viewer following the real channel (removed by clear).
  await app.insert(s.follows).values([
    { followerId: prefixOnly, channelId: realChannel },
    { followerId: domainOnly, channelId: realChannel },
    { followerId: realUser, channelId: domainOnlyChannel },
    { followerId: demoViewer.id, channelId: realChannel },
  ]);
  await app.update(s.channels).set({ followerCount: 3 }).where(eq(s.channels.id, realChannel));

  const messages = [uuidv7(), uuidv7(), uuidv7()];
  await app.insert(s.chatMessages).values([
    { id: messages[0], channelId: realChannel, userId: realUser, body: "hello from a real channel" },
    { id: messages[1], channelId: realChannel, userId: prefixOnly, body: "lookalike chatting" },
    { id: messages[2], channelId: realChannel, userId: realBot, body: "bot says hi" },
    // Demo user in a real channel: hangs off the demo user, so it goes.
    { channelId: realChannel, userId: demoViewer.id, body: "demo viewer in a real channel" },
  ]);
  const bans = [uuidv7()];
  await app.insert(s.chatBans).values([
    // A demo user moderating a real user in a real channel keeps the ban (moderator set null).
    { id: bans[0], channelId: realChannel, userId: domainOnly, moderatorId: realUser, reason: "" },
    { channelId: realChannel, userId: demoViewer.id, moderatorId: realUser, reason: "" },
  ]);
  await app.insert(s.channelRoles).values({ channelId: realChannel, userId: prefixOnly, role: "moderator" });
  const sessions = [uuidv7()];
  await app.insert(s.playbackSessions).values([
    {
      id: sessions[0],
      channelId: realChannel,
      broadcastId: realBroadcast,
      userId: realUser,
      deviceHash: "d",
      ipHash: "i",
    },
    // A real viewer on a demo channel: RESTRICT on channels, must be removed with it.
    { channelId: demoChannel.id, userId: realUser, deviceHash: "d2", ipHash: "i2" },
  ]);
  await app.insert(s.integrityFlags).values([
    { subjectType: "channel", subjectId: realChannel, channelId: realChannel, signal: "test", score: 0.5 },
    { subjectType: "channel", subjectId: demoChannel.id, channelId: demoChannel.id, signal: "test", score: 0.5 },
  ]);
  await app.insert(s.sessions).values({
    userId: realUser,
    token: `tok-${uuidv7()}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const realAudit = uuidv7();
  await app.insert(s.auditLog).values({
    id: realAudit,
    actorType: "user",
    actorId: realUser,
    action: "stream_key.rotate",
    subjectType: "stream_key",
    subjectId: realKey,
    channelId: realChannel,
  });
  return {
    realUser,
    realChannel,
    realBroadcast,
    realKey,
    realBot,
    prefixOnly,
    domainOnly,
    domainOnlyChannel,
    realAudit,
    ids: { follows: 3, messages, bans, sessions },
  };
}

/** Every row the real data owns, for an exact before/after comparison. */
async function snapshotReal(r: RealData) {
  const userIds = [r.realUser, r.realBot, r.prefixOnly, r.domainOnly];
  const channelIds = [r.realChannel, r.domainOnlyChannel];
  const orderById = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  return {
    users: orderById(await app.select().from(s.users).where(inArray(s.users.id, userIds))),
    channels: orderById(await app.select().from(s.channels).where(inArray(s.channels.id, channelIds))),
    broadcasts: await app.select().from(s.broadcasts).where(eq(s.broadcasts.id, r.realBroadcast)),
    keys: await app.select().from(s.streamKeys).where(eq(s.streamKeys.id, r.realKey)),
    follows: await app
      .select()
      .from(s.follows)
      .where(inArray(s.follows.followerId, userIds))
      .orderBy(s.follows.followerId, s.follows.channelId),
    messages: orderById(await app.select().from(s.chatMessages).where(inArray(s.chatMessages.id, r.ids.messages))),
    bans: await app.select().from(s.chatBans).where(inArray(s.chatBans.id, r.ids.bans)),
    roles: await app.select().from(s.channelRoles).where(eq(s.channelRoles.channelId, r.realChannel)),
    playback: await app.select().from(s.playbackSessions).where(inArray(s.playbackSessions.id, r.ids.sessions)),
    flags: await app.select().from(s.integrityFlags).where(eq(s.integrityFlags.channelId, r.realChannel)),
    sessions: await app.select().from(s.sessions).where(eq(s.sessions.userId, r.realUser)),
    audit: await app.select().from(s.auditLog).where(eq(s.auditLog.id, r.realAudit)),
  };
}

const rowCount = async (table: PgTable) => {
  const [row] = await app.select({ n: count() }).from(table);
  return row?.n ?? 0;
};

describe("demo seed", () => {
  test("seeds anchored accounts, channels, chat, moderation and history", async () => {
    const result = await seedDemo(app, { password: PASSWORD });
    expect(result.status).toBe("seeded");
    if (result.status !== "seeded") return;
    const { summary } = result;
    expect(summary.accounts).toHaveLength(DEMO_HANDLES.length);
    expect(summary.chatMessages).toBe(DEMO_CHAT.length);
    expect(summary.channels).toBe(DEMO_STREAMERS.length);
    expect(await countAnchoredUsers(app)).toBe(DEMO_HANDLES.length);

    const people = await app.select().from(s.users).where(anchoredUser());
    for (const u of people) {
      expect(u.username.startsWith("demo_")).toBe(true);
      expect(u.email.endsWith("@demo-seed.invalid")).toBe(true);
    }
    const humans = people.filter((u) => u.accountType === "human");
    expect(humans.every((u) => u.emailVerified && u.birthDate !== null)).toBe(true);
    const creds = await app
      .select()
      .from(s.accounts)
      .where(
        inArray(
          s.accounts.userId,
          humans.map((u) => u.id),
        ),
      );
    expect(creds).toHaveLength(humans.length);
    for (const c of creds) {
      expect(c.providerId).toBe("credential");
      expect(c.accountId).toBe(c.userId);
      expect(await verifyPassword(c.password ?? "", PASSWORD)).toBe(true);
    }
    const bot = people.find((u) => u.accountType === "bot");
    expect(bot?.botOwnerId).toBe(people.find((u) => u.username === "demo_streamer1")?.id);

    const chans = await app
      .select()
      .from(s.channels)
      .where(
        inArray(
          s.channels.ownerId,
          humans.map((u) => u.id),
        ),
      );
    expect(chans).toHaveLength(3);
    for (const c of chans) {
      expect(c.title).not.toBe("");
      expect(c.categoryId).not.toBeNull();
      expect(c.tags.length).toBeGreaterThan(0);
      expect(c.followerCount).toBeGreaterThan(0);
    }
    const bans = await app.select().from(s.chatBans);
    expect(bans.filter((b) => b.expiresAt === null)).toHaveLength(1);
    expect(bans.filter((b) => b.expiresAt !== null && b.expiresAt > new Date())).toHaveLength(1);
    const audit = await app.select().from(s.auditLog);
    expect(audit.map((a) => a.action).sort(byText)).toEqual(
      ["channel.role.add", "channel.role.add", "chat.ban", "chat.timeout", ...Array(3).fill("stream_key.rotate")].sort(
        byText,
      ),
    );
    // Audit rows reference ids only (ADR 0004).
    expect(JSON.stringify(audit)).not.toContain("demo_");
    expect(await rowCount(s.streamKeys)).toBe(3);
    expect(await rowCount(s.broadcasts)).toBe(6);
  });

  test("a second seed changes nothing without --reset", async () => {
    const before = await rowCount(s.users);
    const result = await seedDemo(app, { password: PASSWORD });
    expect(result).toEqual({ status: "exists", existing: DEMO_HANDLES.length });
    expect(await rowCount(s.users)).toBe(before);
  });

  test("refuses a password better-auth would refuse", async () => {
    await expect(seedDemo(app, { password: "short" })).rejects.toThrow(/at least 10/);
  });
});

describe("demo clear", () => {
  let real: RealData;
  let before: Awaited<ReturnType<typeof snapshotReal>>;
  let auditBefore: number;

  beforeAll(async () => {
    real = await insertRealData();
    before = await snapshotReal(real);
    auditBefore = await rowCount(s.auditLog);
  });

  test("dry run reports counts and deletes nothing", async () => {
    const usersBefore = await rowCount(s.users);
    const report = await clearDemo(app, { execute: false });
    expect(report.anchoredUsers).toBe(DEMO_HANDLES.length);
    const rows = Object.fromEntries(report.steps.map((x) => [x.table, x.rows]));
    expect(rows["users (bots)"]).toBe(1);
    expect(rows.users).toBe(DEMO_HANDLES.length - 1);
    expect(rows.channels).toBe(3);
    expect(rows.playback_sessions).toBe(1);
    expect(rows.integrity_flags).toBe(1);
    expect(rows.chat_messages).toBe(DEMO_CHAT.length + 1);
    expect(await rowCount(s.users)).toBe(usersBefore);
    expect(await countAnchoredUsers(app)).toBe(DEMO_HANDLES.length);
  });

  test("--yes removes every anchored row and leaves everything else untouched", async () => {
    const report = await clearDemo(app, { execute: true });
    expect(report.anchoredUsers).toBe(DEMO_HANDLES.length);
    expect(await countAnchoredUsers(app)).toBe(0);

    // Nothing demo is left anywhere.
    const remainingUsers = await app.select({ username: s.users.username }).from(s.users);
    expect(remainingUsers.map((u) => u.username).sort(byText)).toEqual(
      ["demo_lookalike", "domainonly", "realbot", "realstreamer"].sort(byText),
    );
    expect((await app.select().from(s.channels)).map((c) => c.slug).sort(byText)).toEqual([
      "domainonly",
      "realstreamer",
    ]);
    expect(await rowCount(s.broadcasts)).toBe(1);
    expect(await rowCount(s.streamKeys)).toBe(1);
    expect(await rowCount(s.accounts)).toBe(0);
    expect(await rowCount(s.chatMessages)).toBe(real.ids.messages.length);
    expect(await rowCount(s.chatBans)).toBe(real.ids.bans.length);
    expect(await rowCount(s.playbackSessions)).toBe(real.ids.sessions.length);
    expect(await rowCount(s.integrityFlags)).toBe(1);
    expect(await rowCount(s.channelRoles)).toBe(1);
    expect(await rowCount(s.follows)).toBe(real.ids.follows);

    // Real rows are byte-for-byte the same, except the real channel's follower count, which loses
    // the demo viewer's follow.
    const after = await snapshotReal(real);
    const fix = (snap: typeof before) => ({
      ...snap,
      channels: snap.channels.map((c) => ({ ...c, followerCount: 0, updatedAt: null })),
    });
    expect(fix(after)).toEqual(fix(before));
    const followerCount = (snap: typeof before) => snap.channels.find((c) => c.id === real.realChannel)?.followerCount;
    expect(followerCount(before)).toBe(3);
    expect(followerCount(after)).toBe(2);

    // Append-only: every audit row stays, the demo ones included (ids only).
    expect(await rowCount(s.auditLog)).toBe(auditBefore);
  });

  test("a clear with nothing to clear is a no-op", async () => {
    const report = await clearDemo(app, { execute: true });
    expect(report.anchoredUsers).toBe(0);
    expect(report.steps.every((x) => x.rows === 0)).toBe(true);
  });

  test("seed → clear → seed works, and --reset replaces existing demo data", async () => {
    const first = await seedDemo(app, { password: PASSWORD });
    expect(first.status).toBe("seeded");
    const firstIds = (await app.select({ id: s.users.id }).from(s.users).where(anchoredUser())).map((u) => u.id);
    const reset = await seedDemo(app, { password: PASSWORD, reset: true });
    expect(reset.status).toBe("seeded");
    expect(reset).toMatchObject({ status: "seeded", cleared: { anchoredUsers: DEMO_HANDLES.length } });
    const secondIds = (await app.select({ id: s.users.id }).from(s.users).where(anchoredUser())).map((u) => u.id);
    expect(secondIds).toHaveLength(DEMO_HANDLES.length);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    // The categories are shared reference data and are reused, not duplicated.
    expect(await rowCount(s.categories)).toBe(3);
    await clearDemo(app, { execute: true });
    expect(await countAnchoredUsers(app)).toBe(0);
    expect(await rowCount(s.users)).toBe(4);
  });

  test("anchored users with money rows block the clear and nothing is deleted", async () => {
    await seedDemo(app, { password: PASSWORD });
    const [viewer] = await app
      .select()
      .from(s.users)
      .where(sql`${anchoredUser()} and ${s.users.username} = 'demo_viewer1'`);
    if (!viewer) throw new Error("no demo viewer");
    // Money rows are RESTRICT on users: the clear must fail as a whole rather than touch them.
    await app.insert(s.payouts).values({
      userId: viewer.id,
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
      amountCents: 100,
      currency: "usd",
      provider: "manual",
    });
    const anchored = await countAnchoredUsers(app);
    const err = await clearDemo(app, { execute: true }).then(
      () => null,
      (e: unknown) => e as Error & { cause?: Error },
    );
    expect(err?.cause?.message ?? err?.message).toMatch(/foreign key/);
    expect(await countAnchoredUsers(app)).toBe(anchored);
  });
});
