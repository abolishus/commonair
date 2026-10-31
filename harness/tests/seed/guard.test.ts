// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { describeTarget, fullSeedRefusals } from "../../src/seed/guard.ts";

const url = "postgres://app:secret@db.internal:5432/commonair";
const ok = { seedFull: true, databaseUrl: url, confirm: "db.internal:5432/commonair", userCount: 0 };

describe("fullSeedRefusals", () => {
  test("opted in, confirmed and empty: no refusal", () => {
    expect(fullSeedRefusals(ok)).toEqual([]);
  });

  test("each missing condition is its own reason", () => {
    expect(fullSeedRefusals({ ...ok, seedFull: false })).toEqual([expect.stringContaining("DEMO_SEED_FULL")]);
    expect(fullSeedRefusals({ ...ok, confirm: undefined })).toEqual([
      "pass --confirm db.internal:5432/commonair to seed this database",
    ]);
    expect(fullSeedRefusals({ ...ok, confirm: "db.internal:5432/other" })).toHaveLength(1);
    expect(fullSeedRefusals({ ...ok, userCount: 1 })).toEqual([expect.stringContaining("has 1 user(s)")]);
  });

  test("every reason at once, and no target without DATABASE_URL", () => {
    expect(fullSeedRefusals({ seedFull: false, databaseUrl: url, confirm: undefined, userCount: 3 })).toHaveLength(3);
    expect(fullSeedRefusals({ ...ok, databaseUrl: undefined })).toEqual(["DATABASE_URL is not set"]);
  });

  test("the target never includes credentials", () => {
    expect(describeTarget(url)).toBe("db.internal:5432/commonair");
    expect(describeTarget("postgres://u:p@localhost/x")).toBe("localhost/x");
  });
});
