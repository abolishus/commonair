// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 2 (0055): video and clip title search (`services/api/src/discovery/search-media.ts`)
 * has a GIN index on the exact `to_tsvector('simple', title)` expression it queries, so a search is
 * an index lookup instead of a scan of both tables.
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

describe("media title search indexes (0055)", () => {
  test("vods and clips have a GIN index on to_tsvector('simple', title)", async () => {
    const rows = await owner.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes
          where indexname in ('vods_title_search_idx', 'clips_title_search_idx')`,
    );
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.get("vods_title_search_idx")).toBe(
      "CREATE INDEX vods_title_search_idx ON public.vods USING gin (to_tsvector('simple'::regconfig, title))",
    );
    expect(defs.get("clips_title_search_idx")).toBe(
      "CREATE INDEX clips_title_search_idx ON public.clips USING gin (to_tsvector('simple'::regconfig, title))",
    );
  });

  test("the planner can answer the search's match with the index", async () => {
    await owner.transaction(async (tx) => {
      // An empty table is cheaper to scan; turning seq scans off shows the index applies at all.
      await tx.execute(sql`set local enable_seqscan = off`);
      for (const table of ["vods", "clips"] as const) {
        const plan = await tx.execute<{ "QUERY PLAN": string }>(
          sql`explain select id from ${sql.identifier(table)}
              where to_tsvector('simple', title) @@ plainto_tsquery('simple', 'speedrun')`,
        );
        expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain(`${table}_title_search_idx`);
      }
    });
  });
});
