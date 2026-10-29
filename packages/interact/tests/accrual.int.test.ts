// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `readPointsAccrual` against a real database. Settings change only through passed proposals (the
 * 0001 guard), so each value comes from its own database's governance overrides.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { schema } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { POINTS_ACCRUAL_KEY, readPointsAccrual } from "../src/accrual.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });

let seeded: TestDatabase;
let harness: TestDatabase;
beforeAll(async () => {
  [seeded, harness] = await Promise.all([
    createTestDatabase(),
    createTestDatabase({
      governance: { [POINTS_ACCRUAL_KEY]: { pointsPerBlock: 10, blockMinutes: 1, dailyCapPerChannel: 1000 } },
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([seeded?.drop(), harness?.drop()]);
});

describe("readPointsAccrual", () => {
  test("the seeded default: 10 points per 5 minutes, 1,000 a day", async () => {
    const log = { error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(await readPointsAccrual(seeded.app.db, log)).toEqual({
      pointsPerBlock: 10,
      blockMinutes: 5,
      dailyCapPerChannel: 1000,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  test("an overridden value as stored (the harness stack's one-minute blocks)", async () => {
    expect(await readPointsAccrual(harness.app.db)).toEqual({
      pointsPerBlock: 10,
      blockMinutes: 1,
      dailyCapPerChannel: 1000,
    });
  });

  test("the database refuses a direct change (only a passed proposal may change it)", async () => {
    await expect(
      seeded.db
        .update(schema.governanceSettings)
        .set({ value: { pointsPerBlock: 10, blockMinutes: 0, dailyCapPerChannel: 1000 } })
        .where(eq(schema.governanceSettings.key, POINTS_ACCRUAL_KEY)),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});
