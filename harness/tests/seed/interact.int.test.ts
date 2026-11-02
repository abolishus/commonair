// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-interact's direct-insert writers against a migrated database, as the app role: the rows land
 * and satisfy the constraints, the triggers accept them, the seeded sessions are what the worker's
 * points accrual credits (only with `DEMO_SEED_FULL`'s `includeDemo`), and nothing goes into an
 * append-only table or the outbox. The API steps (bot settings, grants, polls, predictions,
 * giveaways, the live raid, overlay tokens) are exercised by `seed full` live.
 *
 * The social fixture is this file's own: a few demo accounts and channels inserted directly.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { accruePoints } from "../../../services/worker/src/interact/points/accrue.ts";
import { createRng } from "../../src/seed/prng.ts";
import type { SeedScale } from "../../src/seed/scale.ts";
import type { SeedAccountKind, SeedStore } from "../../src/seed/types.ts";
import { ownedRows } from "../../src/seed/interact.ts";
import { DAY_MS, type InteractPlan, planCounts, planInteract } from "../../src/seed/interact/plan.ts";
import { readRoster } from "../../src/seed/interact/roster.ts";
import { SEED_USER_AGENT, writeInteractDirect } from "../../src/seed/interact/write.ts";

const SCALE: SeedScale = { streamers: 2, viewers: 12, chatLines: 0, historyDays: 45, factor: 1 };
const NOW = new Date();

let t: TestDatabase;
let store: SeedStore;
let plan: InteractPlan;
let rows: Record<string, number>;
let sessionIds: string[];

const fixture: { handle: string; kind: SeedAccountKind; streamer: boolean; ageDays: number }[] = [
  { handle: "streamer1", kind: "fixed", streamer: true, ageDays: 46 },
  { handle: "streamer2", kind: "fixed", streamer: true, ageDays: 46 },
  { handle: "council1", kind: "fixed", streamer: true, ageDays: 46 },
  { handle: "chanmod", kind: "fixed", streamer: false, ageDays: 46 },
  { handle: "viewer1", kind: "fixed", streamer: false, ageDays: 46 },
  { handle: "viewer2", kind: "fixed", streamer: false, ageDays: 46 },
  { handle: "bot1", kind: "bot", streamer: false, ageDays: 46 },
  ...Array.from({ length: SCALE.streamers }, (_, i) => ({
    handle: `s${String(i + 1).padStart(4, "0")}`,
    kind: "bulk-streamer" as const,
    streamer: true,
    ageDays: 40,
  })),
  ...Array.from({ length: SCALE.viewers }, (_, i) => ({
    handle: `v${String(i + 1).padStart(5, "0")}`,
    kind: "bulk-viewer" as const,
    streamer: false,
    ageDays: i % 4 === 0 ? 5 : 35,
  })),
];

beforeAll(async () => {
  t = await createTestDatabase();
  const { db } = t.app;
  store = { users: [], channels: [], extra: {} };
  const owner = fixture.find((f) => f.handle === "streamer1");
  const s1Id = uuidv7();
  for (const f of fixture) {
    const createdAt = new Date(NOW.getTime() - f.ageDays * DAY_MS);
    const id = f.handle === "streamer1" ? s1Id : uuidv7(createdAt.getTime());
    const username = `demo_${f.handle}`;
    const email = `demo_${f.handle}@demo-seed.invalid`;
    await db.insert(schema.users).values({
      id,
      name: f.handle,
      email,
      emailVerified: f.kind !== "bot",
      username,
      displayUsername: username,
      accountType: f.kind === "bot" ? "bot" : "human",
      botOwnerId: f.kind === "bot" && owner ? s1Id : null,
      createdAt,
      updatedAt: createdAt,
    });
    store.users.push({ id, handle: f.handle, username, email, kind: f.kind, platformRole: "user" });
    if (f.streamer) {
      const channelId = uuidv7(createdAt.getTime() + DAY_MS);
      await db.insert(schema.channels).values({
        id: channelId,
        ownerId: id,
        slug: username,
        displayName: f.handle,
        createdAt: new Date(createdAt.getTime() + DAY_MS),
      });
      store.channels.push({ id: channelId, ownerId: id, ownerHandle: f.handle, slug: username });
    }
  }
  const idOf = (h: string) => store.users.find((u) => u.handle === h)?.id ?? "";
  const chOf = (h: string) => store.channels.find((c) => c.ownerHandle === h)?.id ?? "";
  // chanmod moderates streamer1; viewer2 has a timeout there.
  await db
    .insert(schema.channelRoles)
    .values({ channelId: chOf("streamer1"), userId: idOf("chanmod"), role: "moderator" });
  await db.insert(schema.chatBans).values({
    channelId: chOf("streamer1"),
    userId: idOf("viewer2"),
    moderatorId: idOf("chanmod"),
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });

  const roster = await readRoster(t.app, store, NOW);
  plan = planInteract(createRng(5).fork("interact"), SCALE, NOW, roster);
  const ids = {
    users: new Map(store.users.map((u) => [u.handle, u.id])),
    channels: new Map(store.channels.map((c) => [c.ownerHandle, c.id])),
  };
  ({ rows, sessionIds } = await writeInteractDirect(t.app, plan, ids));
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

const count = async (table: string) =>
  Number((await t.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`))[0]?.n ?? 0);

describe("readRoster", () => {
  test("finds the team and the bans in force", async () => {
    const r = await readRoster(t.app, store, NOW);
    expect([...(r.team.get("streamer1") ?? [])]).toEqual(["chanmod"]);
    expect([...(r.banned.get("streamer1") ?? [])]).toEqual(["viewer2"]);
    expect(r.users).toHaveLength(fixture.length);
  });
});

describe("writeInteractDirect", () => {
  test("every planned row lands, and the reported counts are the table counts", async () => {
    const want = planCounts(plan);
    for (const [table, n] of Object.entries(want)) {
      expect(await count(table), table).toBe(n);
      expect(rows[table], table).toBe(n);
    }
    expect(want.polls).toBeGreaterThan(0);
    expect(want.poll_votes).toBeGreaterThan(0);
    expect(want.playback_sessions).toBeGreaterThan(0);
    expect(await count("bot_configs")).toBe(1);
  });

  test("the report counts only owned tables: seed-media's playback_sessions is a cross-unit write, not counted", async () => {
    const report = await ownedRows(t.app);
    expect(await count("playback_sessions")).toBe(sessionIds.length);
    expect(sessionIds.length).toBeGreaterThan(0);
    expect(report).not.toHaveProperty("playback_sessions");
    expect(report.polls).toBe(planCounts(plan).polls);
  });

  test("streamer1's bot config is linked to bot1 and enabled", async () => {
    const [row] = await t.app.db.select().from(schema.botConfigs);
    expect(row?.botUserId).toBe(store.users.find((u) => u.handle === "bot1")?.id);
    expect(row?.enabled).toBe(true);
    expect(row?.config.loyalty.pointsName).toBe("pixels");
  });

  test("ended polls carry their final counts, and every vote is for one of the poll's choices", async () => {
    const polls = await t.app.db.select().from(schema.polls);
    const votes = await t.app.db.select().from(schema.pollVotes);
    for (const p of polls) {
      expect(p.status).not.toBe("active");
      const mine = votes.filter((v) => v.pollId === p.id);
      for (const c of p.choices) expect(c.votes).toBe(mine.filter((v) => v.choiceId === c.id).length);
      for (const v of mine) expect(p.choices.some((c) => c.id === v.choiceId)).toBe(true);
    }
  });

  test("raids satisfy the cancel check and leave no raid pending", async () => {
    const raids = await t.app.db.select().from(schema.raids);
    expect(raids.length).toBe(plan.raids.length);
    for (const r of raids) {
      expect(r.status === "canceled").toBe(r.cancelReason !== null);
      expect(r.status).not.toBe("pending");
    }
  });

  test("one open goal per channel and type", async () => {
    const goals = await t.app.db.select().from(schema.goals);
    const open = goals.filter((g) => g.endedAt === null).map((g) => `${g.channelId}:${g.type}`);
    expect(new Set(open).size).toBe(open.length);
  });

  test("nothing went into an append-only table, the ledger or the outbox", async () => {
    for (const table of ["audit_log", "events", "loyalty_transactions", "loyalty_balances", "prediction_bets"])
      expect(await count(table), table).toBe(0);
  });
});

describe("the seeded sessions feed points accrual", () => {
  const log = { error: () => undefined, warn: () => undefined };

  test("without DEMO_SEED_FULL the worker credits demo users nothing", async () => {
    const r = await accruePoints({ db: t.app.db, logger: log }, { now: new Date() });
    expect(r.points).toBe(0);
    expect(await count("loyalty_transactions")).toBe(0);
  });

  test("with it, every seeded session is counted and the viewers hold points", async () => {
    const r = await accruePoints({ db: t.app.db, logger: log }, { now: new Date(), includeDemo: true });
    expect(r.points).toBeGreaterThan(0);
    const [counted] = await t.sql<{ n: number }[]>`
      select count(*)::int as n from loyalty_accrual_sessions las
        join playback_sessions ps on ps.id = las.session_id where ps.user_agent = ${SEED_USER_AGENT}`;
    expect(counted?.n).toBe(sessionIds.length);
    const viewer1 = store.users.find((u) => u.handle === "viewer1")?.id ?? "";
    const [bal] = await t.sql<{ points: string }[]>`
      select points::text from loyalty_balances where user_id = ${viewer1}`;
    expect(Number(bal?.points ?? 0)).toBeGreaterThan(0);
    // Nobody watched their own channel and the bot earned nothing.
    const [own] = await t.sql<{ n: number }[]>`
      select count(*)::int as n from loyalty_transactions lt join channels c on c.id = lt.channel_id
       where lt.user_id = c.owner_id`;
    expect(own?.n).toBe(0);
  });
});
