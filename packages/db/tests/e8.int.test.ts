// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E8 schema (0033, 0034; ADR 0026): the points ledger is append-only and the only writer of
 * balances, an overdraw fails the inserting transaction, the sign of each reason is checked, the
 * accrual setting is range-checked, and a channel has at most one open poll, prediction, pending
 * raid and goal per type. Plus the shared `points.ts` helpers.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import {
  InsufficientPointsError,
  isInsufficientPoints,
  type LoyaltyReason,
  pointsBalance,
  postPointsInTx,
} from "../src/points.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, TEST_APP_ROLE, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<Error & { cause?: unknown }> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
  return e;
}

async function newUser(): Promise<string> {
  const name = `e8_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function newChannel(): Promise<string> {
  const ownerId = await newUser();
  const [c] = await owner
    .insert(s.channels)
    .values({ ownerId, slug: `c${ownerId.slice(-10)}`, displayName: "E8" })
    .returning({ id: s.channels.id });
  return c!.id;
}

const tx = (channelId: string, userId: string, delta: number, reason: LoyaltyReason = "moderator_adjust") => ({
  channelId,
  userId,
  delta,
  reason,
});

describe("loyalty_transactions", () => {
  test("append-only for the app role (no privilege) and the owner (trigger)", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    const [row] = await app
      .insert(s.loyaltyTransactions)
      .values(tx(c, u, 5))
      .returning();
    const where = eq(s.loyaltyTransactions.id, row!.id);
    await expectPgError(app.update(s.loyaltyTransactions).set({ delta: 6 }).where(where), /permission denied/);
    await expectPgError(app.delete(s.loyaltyTransactions).where(where), /permission denied/);
    await expectPgError(owner.update(s.loyaltyTransactions).set({ delta: 6 }).where(where), /append-only/);
    await expectPgError(owner.delete(s.loyaltyTransactions).where(where), /append-only/);
    await expectPgError(owner.execute(sql`truncate loyalty_transactions cascade`), /append-only/);
  });

  test("a credit creates the balance; a spend beyond it fails on the CHECK and changes nothing", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    await app.insert(s.loyaltyTransactions).values(tx(c, u, 100, "watch"));
    expect(await pointsBalance(app, c, u)).toBe(100);
    const e = await expectPgError(
      app.insert(s.loyaltyTransactions).values(tx(c, u, -101, "command")),
      /loyalty_balances_points_nonneg/,
    );
    expect(isInsufficientPoints(e)).toBe(true);
    expect(await pointsBalance(app, c, u)).toBe(100);
    // A first spend with no balance row fails the same way.
    const other = await newUser();
    await expectPgError(
      app.insert(s.loyaltyTransactions).values(tx(c, other, -1, "command")),
      /loyalty_balances_points_nonneg/,
    );
  });

  test("the sign check refuses a positive spend, a negative credit and a zero delta", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    await expectPgError(app.insert(s.loyaltyTransactions).values(tx(c, u, 5, "command")), /loyalty_tx_sign_ck/);
    await expectPgError(app.insert(s.loyaltyTransactions).values(tx(c, u, -5, "watch")), /loyalty_tx_sign_ck/);
    await expectPgError(app.insert(s.loyaltyTransactions).values(tx(c, u, 0)), /loyalty_tx_delta_nonzero/);
    // A moderator adjust may go either way.
    await app.insert(s.loyaltyTransactions).values(tx(c, u, 10));
    await app.insert(s.loyaltyTransactions).values(tx(c, u, -4));
    expect(await pointsBalance(app, c, u)).toBe(6);
  });

  test("two concurrent spends of a balance worth one succeed once", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    await app.insert(s.loyaltyTransactions).values(tx(c, u, 1, "watch"));
    const spend = () =>
      app.transaction(async (x) => {
        await x.insert(s.loyaltyTransactions).values(tx(c, u, -1, "command"));
        await x.execute(sql`select pg_sleep(0.2)`);
      });
    const results = await Promise.allSettled([spend(), spend()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(isInsufficientPoints(failed.reason)).toBe(true);
    expect(await pointsBalance(app, c, u)).toBe(0);
  });
});

describe("loyalty_balances", () => {
  test("direct writes are refused for the app role (no privilege) and the owner (trigger)", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    await app.insert(s.loyaltyTransactions).values(tx(c, u, 3, "watch"));
    const where = eq(s.loyaltyBalances.userId, u);
    await expectPgError(
      app.insert(s.loyaltyBalances).values({ channelId: c, userId: await newUser(), points: 5 }),
      /permission denied/,
    );
    await expectPgError(app.update(s.loyaltyBalances).set({ points: 50 }).where(where), /permission denied/);
    await expectPgError(app.delete(s.loyaltyBalances).where(where), /permission denied/);
    await expectPgError(owner.execute(sql`truncate loyalty_balances cascade`), /append-only/);
    expect(await pointsBalance(app, c, u)).toBe(3);
  });

  test("a role without ownership but with grants is stopped by the guard trigger", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    // Grant the app role DML inside a transaction that is rolled back, to reach the trigger layer.
    const done = new Error("rolled back");
    const run = owner.transaction(async (x) => {
      await x.execute(sql.raw(`grant insert, update, delete on loyalty_balances to ${TEST_APP_ROLE}`));
      await x.execute(sql.raw(`set local role ${TEST_APP_ROLE}`));
      await expectPgError(
        x.transaction((sp) => sp.insert(s.loyaltyBalances).values({ channelId: c, userId: u, points: 5 })),
        /written by the database only/,
      );
      throw done;
    });
    await expect(run).rejects.toBe(done);
  });
});

describe("interact.points.accrual", () => {
  const valid = { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 };
  const insert = (value: unknown) =>
    owner
      .insert(s.governanceSettings)
      .values({ key: "interact.points.accrual", description: "x", protected: false, value });

  test("the seeded default is present", async () => {
    const [row] = await app
      .select()
      .from(s.governanceSettings)
      .where(eq(s.governanceSettings.key, "interact.points.accrual"));
    expect(row?.value).toEqual(valid);
    expect(row?.protected).toBe(false);
  });

  test("accepts the default (the insert reaches the unique key, past the check)", async () => {
    await expectPgError(insert(valid), /duplicate key/);
  });

  test.each([
    ["blockMinutes 0", { ...valid, blockMinutes: 0 }],
    ["blockMinutes 61", { ...valid, blockMinutes: 61 }],
    ["pointsPerBlock 0", { ...valid, pointsPerBlock: 0 }],
    ["negative cap", { ...valid, dailyCapPerChannel: -1 }],
    ["fractional points", { ...valid, pointsPerBlock: 1.5 }],
    ["string value", { ...valid, blockMinutes: "5" }],
    ["missing field", { pointsPerBlock: 10, blockMinutes: 5 }],
  ])("refuses %s", async (_name, v) => {
    await expectPgError(insert(v), /interact\.points\.accrual/);
  });
});

describe("one open row per channel", () => {
  test("polls_channel_active_uq", async () => {
    const c = await newChannel();
    const poll = () =>
      app.insert(s.polls).values({
        channelId: c,
        title: "P",
        choices: [],
        durationSeconds: 60,
        endsAt: new Date(Date.now() + 60_000),
      });
    await poll();
    await expectPgError(poll(), /polls_channel_active_uq/);
  });

  test("predictions_channel_open_uq (active or locked)", async () => {
    const c = await newChannel();
    const prediction = (status: "active" | "locked" | "resolved") =>
      app.insert(s.predictions).values({
        channelId: c,
        title: "P",
        outcomes: [],
        status,
        windowSeconds: 60,
        locksAt: new Date(Date.now() + 60_000),
      });
    await prediction("locked");
    await expectPgError(prediction("active"), /predictions_channel_open_uq/);
    await prediction("resolved");
  });

  test("raids_from_pending_uq and raids_cancel_ck", async () => {
    const [from, to] = [await newChannel(), await newChannel()];
    const raid = (over: Partial<typeof s.raids.$inferInsert> = {}) =>
      app.insert(s.raids).values({ fromChannelId: from, toChannelId: to, executeAt: new Date(), ...over });
    await raid();
    await expectPgError(raid(), /raids_from_pending_uq/);
    await expectPgError(raid({ status: "canceled" }), /raids_cancel_ck/);
    await expectPgError(raid({ status: "completed", cancelReason: "owner" }), /raids_cancel_ck/);
    await raid({ status: "canceled", cancelReason: "owner", canceledAt: new Date() });
  });

  test("goals_channel_open_uq (per type, open only)", async () => {
    const c = await newChannel();
    const goal = (type: "followers" | "tips", endedAt: Date | null = null) =>
      app.insert(s.goals).values({ channelId: c, type, title: "G", target: 10, endedAt });
    await goal("followers");
    await expectPgError(goal("followers"), /goals_channel_open_uq/);
    await goal("tips");
    await goal("followers", new Date());
  });
});

describe("points.ts", () => {
  test("balance after a credit and a spend; refId stored", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    const ref = uuidv7();
    const credit = await app.transaction((x) =>
      postPointsInTx(x, { channelId: c, userId: u, delta: 40, reason: "moderator_adjust", refId: ref }),
    );
    expect(credit.balance).toBe(40);
    const spend = await app.transaction((x) =>
      postPointsInTx(x, { channelId: c, userId: u, delta: -15, reason: "command", refId: null }),
    );
    expect(spend.balance).toBe(25);
    const [row] = await app.select().from(s.loyaltyTransactions).where(eq(s.loyaltyTransactions.id, credit.id));
    expect(row?.refId).toBe(ref);
    expect(await pointsBalance(app, c, await newUser())).toBe(0);
  });

  test("an overdraw throws InsufficientPointsError and the outer transaction stays usable", async () => {
    const [c, u] = [await newChannel(), await newUser()];
    const result = await app.transaction(async (x) => {
      await postPointsInTx(x, { channelId: c, userId: u, delta: 10, reason: "watch", refId: null });
      await expect(
        postPointsInTx(x, { channelId: c, userId: u, delta: -11, reason: "prediction_bet", refId: null }),
      ).rejects.toBeInstanceOf(InsufficientPointsError);
      // Still usable: the refusal rolled back to the savepoint only.
      return postPointsInTx(x, { channelId: c, userId: u, delta: -10, reason: "prediction_bet", refId: null });
    });
    expect(result.balance).toBe(0);
    const rows = await app.select().from(s.loyaltyTransactions).where(eq(s.loyaltyTransactions.userId, u));
    expect(rows.map((r) => r.delta).sort((a, b) => a - b)).toEqual([-10, 10]);
  });
});
