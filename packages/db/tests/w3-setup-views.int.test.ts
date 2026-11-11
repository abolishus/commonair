// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 3 (0056): `vods.views` starts at 0, `channel_setup_steps` holds one row per
 * (channel, markable step), refuses steps that are derived, and goes with its channel.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

describe("0056 wave 3 columns and tables", () => {
  test("vods.views is a non-null integer defaulting to 0", async () => {
    const [col] = await owner.execute<{ data_type: string; is_nullable: string; column_default: string }>(
      sql`select data_type, is_nullable, column_default from information_schema.columns
          where table_name = 'vods' and column_name = 'views'`,
    );
    expect(col).toEqual({ data_type: "integer", is_nullable: "NO", column_default: "0" });
  });

  test("channel_setup_steps accepts only markable steps and enforces one row per step", async () => {
    const [col] = await owner.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.table_constraints
          where table_name = 'channel_setup_steps' and constraint_type = 'FOREIGN KEY'`,
    );
    expect(col?.n).toBe(1);
    const constraints = await owner.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'channel_setup_steps'::regclass and contype in ('c', 'p')`,
    );
    const defs = constraints.map((c) => c.def).join("\n");
    expect(defs).toContain("PRIMARY KEY (channel_id, step)");
    expect(defs).toContain("'bring_your_audience'");
    expect(defs).not.toContain("'first_live'");
  });

  test("notification_type has vod_ready", async () => {
    const rows = await owner.execute<{ v: string }>(sql`select unnest(enum_range(null::notification_type))::text as v`);
    expect(rows.map((r) => r.v)).toContain("vod_ready");
  });
});
