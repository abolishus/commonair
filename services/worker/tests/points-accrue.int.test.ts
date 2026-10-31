// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `points-accrue` against a real database as the application role (ADR 0026 decision 1): only
 * gate-eligible, signed-in watch time earns; concurrent sessions count once; reruns are idempotent;
 * the daily cap and the UTC day; no clawback; demo data never gets a ledger row.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { BotConfig } from "@commonair/contracts/shapes";
import { pointsBalance, schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import type { WorkerContext } from "../src/context.ts";
import { accruePoints } from "../src/interact/points/accrue.ts";
import { job } from "../src/jobs/points-accrue.ts";
import { quietLogger } from "./fixtures.ts";

let t: TestDatabase;
let owner: Database;
let app: Database;
const ctx = () => ({ db: app, logger: quietLogger });

beforeAll(async () => {
  // The harness stack's setting: 10 points per one-minute block, 1,000 a day.
  t = await createTestDatabase({
    governance: { "interact.points.accrual": { pointsPerBlock: 10, blockMinutes: 1, dailyCapPerChannel: 1000 } },
  });
  owner = t.db;
  app = t.app.db;
}, 180_000);
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
const tag = () => `${++seq}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function user(
  opts: { username?: string; email?: string; bot?: boolean; banned?: boolean; deleted?: boolean } = {},
): Promise<string> {
  const name = opts.username ?? `pa${tag()}`;
  const [u] = await owner
    .insert(s.users)
    .values({
      name,
      username: name,
      email: opts.email ?? `${name}@example.test`,
      accountType: opts.bot ? "bot" : "human",
      banned: opts.banned ?? false,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  return u.id;
}

async function channel(ownerId?: string, loyaltyEnabled?: boolean): Promise<{ id: string; ownerId: string }> {
  const oid = ownerId ?? (await user());
  const slug = `ch${tag()}`;
  const [c] = await owner
    .insert(s.channels)
    .values({ ownerId: oid, slug, displayName: slug })
    .returning({ id: s.channels.id });
  if (!c) throw new Error("no channel");
  if (loyaltyEnabled !== undefined)
    await owner.insert(s.botConfigs).values({
      channelId: c.id,
      config: BotConfig.parse({ loyalty: { enabled: loyaltyEnabled, pointsName: "beans" } }),
    });
  return { id: c.id, ownerId: oid };
}

type Verdict = "verified" | "pending" | "excluded";
async function session(
  channelId: string,
  userId: string | null,
  watchSeconds: number,
  opts: { verdict?: Verdict; reasons?: string[]; scored?: boolean; startedAt?: Date } = {},
): Promise<string> {
  const id = uuidv7();
  await owner.insert(s.playbackSessions).values({
    id,
    channelId,
    userId,
    deviceHash: `dev-${tag()}`,
    ipHash: `ip-${tag()}`,
    watchSeconds,
    verdict: opts.verdict ?? "verified",
    verdictReasons: opts.reasons ?? [],
    scoredAt: opts.scored === false ? null : new Date(),
    lastHeartbeatAt: new Date(),
    ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
  });
  return id;
}

const watch = (id: string, watchSeconds: number, extra: Partial<typeof s.playbackSessions.$inferInsert> = {}) =>
  owner
    .update(s.playbackSessions)
    .set({ watchSeconds, ...extra })
    .where(eq(s.playbackSessions.id, id));

const txCount = async (where: { channelId?: string; userId?: string }) => {
  const [r] = await owner
    .select({ n: sql<number>`count(*)::int` })
    .from(s.loyaltyTransactions)
    .where(
      and(
        where.channelId ? eq(s.loyaltyTransactions.channelId, where.channelId) : undefined,
        where.userId ? eq(s.loyaltyTransactions.userId, where.userId) : undefined,
      ),
    );
  return r?.n ?? 0;
};

const balance = (channelId: string, userId: string) => pointsBalance(owner, channelId, userId);
const secondsLater = (n: number) => new Date(Date.now() + n * 1000);

describe("who earns", () => {
  test("a verified, scored, signed-in session earns whole blocks as a watch row with no ref and no event", async () => {
    const c = await channel();
    const v = await user();
    await session(c.id, v, 185);
    await accruePoints(ctx());
    expect(await balance(c.id, v)).toBe(30);
    const rows = await owner.select().from(s.loyaltyTransactions).where(eq(s.loyaltyTransactions.userId, v));
    expect(rows).toMatchObject([{ channelId: c.id, delta: 30, reason: "watch", refId: null }]);
    const [acc] = await owner.select().from(s.loyaltyAccruals).where(eq(s.loyaltyAccruals.userId, v));
    expect(acc).toMatchObject({ carrySeconds: 5, dayPoints: 30 });
    const [events] = await owner
      .select({ n: sql<number>`count(*)::int` })
      .from(s.events)
      .where(eq(s.events.type, "channel.points.change"));
    expect(events?.n).toBe(0);
  });

  test("pending, excluded, fetch_unjudged, never-scored and anonymous sessions earn nothing", async () => {
    const c = await channel();
    const viewers = await Promise.all([user(), user(), user(), user()]);
    const [pending, excluded, unjudged, unscored] = viewers as [string, string, string, string];
    await session(c.id, pending, 600, { verdict: "pending" });
    await session(c.id, excluded, 600, { verdict: "excluded", reasons: ["fetch_pattern"] });
    await session(c.id, unjudged, 600, { reasons: ["fetch_unjudged"] });
    await session(c.id, unscored, 600, { scored: false });
    await session(c.id, null, 600);
    await accruePoints(ctx());
    expect(await txCount({ channelId: c.id })).toBe(0);
  });

  test("the owner on their own channel, bots, suspended and deleted accounts, and points-off channels earn nothing", async () => {
    const c = await channel();
    await session(c.id, c.ownerId, 600);
    await session(c.id, await user({ bot: true }), 600);
    await session(c.id, await user({ banned: true }), 600);
    await session(c.id, await user({ deleted: true }), 600);
    const off = await channel(undefined, false);
    const offViewer = await user();
    await session(off.id, offViewer, 600);
    await accruePoints(ctx());
    expect(await txCount({ channelId: c.id })).toBe(0);
    expect(await txCount({ channelId: off.id })).toBe(0);

    // The owner earns elsewhere; a channel with points explicitly on earns.
    const other = await channel();
    await session(other.id, c.ownerId, 60);
    const on = await channel(undefined, true);
    await session(on.id, offViewer, 60);
    await accruePoints(ctx());
    expect(await balance(other.id, c.ownerId)).toBe(10);
    expect(await balance(on.id, offViewer)).toBe(10);
  });

  test("an expired suspension earns again", async () => {
    const c = await channel();
    const v = await user({ banned: true });
    await owner
      .update(s.users)
      .set({ banExpires: new Date(Date.now() - 60_000) })
      .where(eq(s.users.id, v));
    await session(c.id, v, 60);
    await accruePoints(ctx());
    expect(await balance(c.id, v)).toBe(10);
  });

  test("a suspension that ends mid-session: only the time after it earns", async () => {
    const c = await channel();
    const v = await user({ banned: true });
    const t0 = new Date();
    await owner
      .update(s.users)
      .set({ banExpires: new Date(t0.getTime() + 30_000) })
      .where(eq(s.users.id, v));
    const id = await session(c.id, v, 300);
    await accruePoints(ctx(), { now: t0 });
    expect(await txCount({ userId: v })).toBe(0);
    await watch(id, 360);
    await accruePoints(ctx(), { now: new Date(t0.getTime() + 60_000) });
    expect(await balance(c.id, v)).toBe(10);
  });

  test("points turned on mid-session: only the time after it earns", async () => {
    const c = await channel(undefined, false);
    const v = await user();
    const id = await session(c.id, v, 300);
    const t0 = new Date();
    await accruePoints(ctx(), { now: t0 });
    expect(await txCount({ channelId: c.id })).toBe(0);
    await owner
      .update(s.botConfigs)
      .set({ config: BotConfig.parse({ loyalty: { enabled: true, pointsName: "beans" } }) })
      .where(eq(s.botConfigs.channelId, c.id));
    await watch(id, 360);
    await accruePoints(ctx(), { now: new Date(t0.getTime() + 60_000) });
    expect(await balance(c.id, v)).toBe(10);
  });
});

describe("demo data (decided 2026-10-29: demo:clear keeps working)", () => {
  const demo = (handle: string) => {
    const username = `${DEMO_FIXTURES.usernamePrefix}${handle}`.toLowerCase();
    return { username, email: `${username}@${DEMO_FIXTURES.emailDomain}` };
  };

  test("a demo channel's viewers earn nothing and no ledger row is written", async () => {
    const streamer = await user(demo(`s${tag()}`));
    const c = await channel(streamer);
    const v = await user();
    await session(c.id, v, 600);
    await accruePoints(ctx());
    expect(await txCount({ channelId: c.id })).toBe(0);
  });

  test("a demo viewer earns nothing on a real channel", async () => {
    const c = await channel();
    const v = await user(demo(`v${tag()}`));
    await session(c.id, v, 600);
    await accruePoints(ctx());
    expect(await txCount({ userId: v })).toBe(0);
  });

  test("one anchor alone is not demo data: such users still earn", async () => {
    const onlyName = await user({ username: `${DEMO_FIXTURES.usernamePrefix}${tag()}`.toLowerCase() });
    const onlyEmail = await user({ email: `x${tag()}@${DEMO_FIXTURES.emailDomain}` });
    const c = await channel(onlyEmail);
    await session(c.id, onlyName, 60);
    await accruePoints(ctx());
    expect(await balance(c.id, onlyName)).toBe(10);
  });

  test("with includeDemo (DEMO_SEED_FULL), demo viewers on demo channels earn", async () => {
    const streamer = await user(demo(`s${tag()}`));
    const c = await channel(streamer);
    const v = await user(demo(`v${tag()}`));
    await session(c.id, v, 60);
    await accruePoints(ctx(), { includeDemo: true });
    expect(await balance(c.id, v)).toBe(10);
  });
});

describe("how much", () => {
  test("two concurrent sessions of one viewer on one channel earn as one", async () => {
    const c = await channel();
    const v = await user();
    const a = await session(c.id, v, 60);
    const b = await session(c.id, v, 60);
    const t0 = new Date();
    await accruePoints(ctx(), { now: t0 });
    expect(await balance(c.id, v)).toBe(10);
    await watch(a, 120);
    await watch(b, 120);
    await accruePoints(ctx(), { now: new Date(t0.getTime() + 60_000) });
    expect(await balance(c.id, v)).toBe(20);
    const marks = await owner.select().from(s.loyaltyAccrualSessions);
    expect(marks.filter((m) => m.sessionId === a || m.sessionId === b).map((m) => m.countedSeconds)).toEqual([
      120, 120,
    ]);
  });

  test("two concurrent sessions after a day-old credit earn as one", async () => {
    const c = await channel();
    const v = await user();
    const t0 = new Date();
    const yesterday = new Date(t0.getTime() - 86_400_000);
    await owner.insert(s.loyaltyAccruals).values({
      channelId: c.id,
      userId: v,
      day: yesterday.toISOString().slice(0, 10),
      carrySeconds: 0,
      dayPoints: 10,
      updatedAt: yesterday,
    });
    await session(c.id, v, 120);
    await session(c.id, v, 120);
    await accruePoints(ctx(), { now: t0 });
    expect(await balance(c.id, v)).toBe(20);
  });

  test("two sessions that started before a stale credit still earn as one", async () => {
    const c = await channel();
    const v = await user();
    const t0 = new Date();
    const tenAgo = new Date(t0.getTime() - 600_000);
    await owner.insert(s.loyaltyAccruals).values({
      channelId: c.id,
      userId: v,
      day: tenAgo.toISOString().slice(0, 10),
      updatedAt: tenAgo,
    });
    const started = new Date(t0.getTime() - 1_200_000);
    await session(c.id, v, 120, { startedAt: started });
    await session(c.id, v, 120, { startedAt: started });
    await accruePoints(ctx(), { now: t0 });
    expect(await balance(c.id, v)).toBe(20);
  });

  test("a second run without new watch time credits nothing", async () => {
    const c = await channel();
    const v = await user();
    await session(c.id, v, 120);
    await accruePoints(ctx());
    expect(await balance(c.id, v)).toBe(20);
    await accruePoints(ctx(), { now: secondsLater(60) });
    expect(await balance(c.id, v)).toBe(20);
    expect(await txCount({ userId: v })).toBe(1);
  });

  test("two runs at once credit once", async () => {
    const c = await channel();
    const v = await user();
    await session(c.id, v, 300);
    await Promise.all([accruePoints(ctx()), accruePoints(ctx())]);
    expect(await balance(c.id, v)).toBe(50);
    expect(await txCount({ userId: v })).toBe(1);
  });

  test("the daily cap, then a new UTC day with the carry kept", async () => {
    const c = await channel();
    const v = await user();
    const id = await session(c.id, v, 7_000);
    const t0 = new Date();
    await accruePoints(ctx(), { now: t0 });
    expect(await balance(c.id, v)).toBe(1000);
    // 116 one-minute blocks used up; 40 s carried. More watch the same day earns nothing.
    await watch(id, 7_300);
    await accruePoints(ctx(), { now: new Date(t0.getTime() + 300_000) });
    expect(await balance(c.id, v)).toBe(1000);
    const [capped] = await owner.select().from(s.loyaltyAccruals).where(eq(s.loyaltyAccruals.userId, v));
    expect(capped).toMatchObject({ dayPoints: 1000, carrySeconds: 40 });

    const tomorrow = new Date(t0.getTime() + 86_400_000);
    await watch(id, 7_380, { scoredAt: tomorrow });
    await accruePoints(ctx(), { now: tomorrow });
    // 40 s carried + 80 s new = two blocks.
    expect(await balance(c.id, v)).toBe(1020);
    const [next] = await owner.select().from(s.loyaltyAccruals).where(eq(s.loyaltyAccruals.userId, v));
    expect(next).toMatchObject({ dayPoints: 20, carrySeconds: 0 });
  });

  test("a verdict that turns excluded after a credit keeps the points (no clawback)", async () => {
    const c = await channel();
    const v = await user();
    const id = await session(c.id, v, 120);
    await accruePoints(ctx());
    expect(await balance(c.id, v)).toBe(20);
    await watch(id, 600, { verdict: "excluded", verdictReasons: ["fetch_pattern"] });
    await accruePoints(ctx(), { now: secondsLater(60) });
    expect(await balance(c.id, v)).toBe(20);
  });

  test("bounded: a run handles at most maxViewers pairs, the next one continues", async () => {
    const c = await channel();
    const vs = await Promise.all([user(), user(), user()]);
    for (const v of vs) await session(c.id, v, 60);
    // Earlier tests' viewers have nothing new, so only these three are candidates.
    const first = await accruePoints(ctx(), { batchSize: 1, maxViewers: 2 });
    expect(first).toEqual({ viewers: 2, points: 20 });
    const second = await accruePoints(ctx(), { batchSize: 1 });
    expect(second).toEqual({ viewers: 1, points: 10 });
  });

  test("stopping at maxViewers warns only when candidates are left", async () => {
    const warnings: string[] = [];
    const logger = { error: () => {}, warn: (msg: string) => void warnings.push(msg) };
    const c = await channel();
    const vs = await Promise.all([user(), user()]);
    for (const v of vs) await session(c.id, v, 60);
    expect(await accruePoints({ db: app, logger }, { batchSize: 1, maxViewers: 2 })).toEqual({
      viewers: 2,
      points: 20,
    });
    expect(warnings).toEqual([]);
    for (const v of await Promise.all([user(), user(), user()])) await session(c.id, v, 60);
    await accruePoints({ db: app, logger }, { batchSize: 1, maxViewers: 2 });
    expect(warnings).toHaveLength(1);
    await accruePoints({ db: app, logger });
  });
});

describe("the job", () => {
  test("returns its counts", async () => {
    const c = await channel();
    const v = await user();
    await session(c.id, v, 60);
    const r = await job.handler({}, ctx() as unknown as WorkerContext, { id: undefined, attemptsMade: 0 });
    expect(r).toEqual({ viewers: 1, points: 10 });
  });
});
