// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 3 (D4.5): `loyaltyOf` reports the instance's `interact.points.accrual` setting, the
 * rate the worker applies, so the points popover's "How you earn" matches what viewers get. The
 * setting changes only through passed proposals, so each value comes from its own database.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { BotConfig } from "@commonair/contracts/shapes";
import { schema as s } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { POINTS_ACCRUAL_KEY } from "@commonair/interact";
import { balanceOf, leaderboard, loyaltyOf } from "../src/points/service.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });

let seeded: TestDatabase;
let tuned: TestDatabase;
const TUNED = { pointsPerBlock: 25, blockMinutes: 15, dailyCapPerChannel: 0 };

beforeAll(async () => {
  [seeded, tuned] = await Promise.all([
    createTestDatabase(),
    createTestDatabase({ governance: { [POINTS_ACCRUAL_KEY]: TUNED } }),
  ]);
});
afterAll(async () => {
  await Promise.all([seeded?.drop(), tuned?.drop()]);
});

let n = 0;
async function channel(t: TestDatabase, config?: unknown) {
  n += 1;
  const username = `d4acc${n}`;
  const [u] = await t.app.db
    .insert(s.users)
    .values({ name: username, username, email: `${username}@example.test`, emailVerified: true })
    .returning({ id: s.users.id, username: s.users.username });
  if (!u) throw new Error("no user");
  const [c] = await t.app.db
    .insert(s.channels)
    .values({ ownerId: u.id, slug: username, displayName: `Display ${username}` })
    .returning({ id: s.channels.id, slug: s.channels.slug });
  if (!c) throw new Error("no channel");
  if (config !== undefined)
    await t.app.db.insert(s.botConfigs).values({ channelId: c.id, config: BotConfig.parse(config) });
  return { channel: c, user: u };
}

describe("loyaltyOf accrual", () => {
  test("the seeded instance setting: 10 points every 5 minutes, up to 1,000 a day", async () => {
    const { channel: c } = await channel(seeded);
    expect(await loyaltyOf(seeded.app.db, c.id)).toEqual({
      enabled: true,
      pointsName: "points",
      accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
    });
  });

  test("a governed value as stored, including a daily cap of 0 (accrual off instance-wide)", async () => {
    const { channel: c } = await channel(tuned, { loyalty: { enabled: true, pointsName: "beans" } });
    expect(await loyaltyOf(tuned.app.db, c.id)).toEqual({ enabled: true, pointsName: "beans", accrual: TUNED });
  });

  test("a channel with points off still reports the instance rate", async () => {
    const { channel: c } = await channel(tuned, { loyalty: { enabled: false, pointsName: "points" } });
    const loyalty = await loyaltyOf(tuned.app.db, c.id);
    expect(loyalty.enabled).toBe(false);
    expect(loyalty.accrual).toEqual(TUNED);
  });

  test("balance and leaderboard carry the same accrual", async () => {
    const { channel: c, user } = await channel(tuned);
    const balance = await balanceOf(tuned.app.db, { channel: c.slug, username: user.username });
    expect(balance.points).toBe(0);
    expect(balance.accrual).toEqual(TUNED);
    expect(await leaderboard(tuned.app.db, { channel: c.slug, limit: 5 })).toEqual([]);
  });
});
