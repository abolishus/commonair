// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-safety's one direct-insert writer (`hash_match_results`) against a migrated database, as the
 * app role: the rows land in chunks, the table accepts them, and the details hold ids and enums
 * only. Every other seed-safety row comes through the API, the worker or a test hook and is
 * exercised by `seed full` live. A minimal fixture (one user, one channel, written here) stands in
 * for seed-social: the rows mirror a T0 match on that user's upload.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { tableCounts } from "../../src/seed/safety.ts";
import { countDelta } from "../../src/seed/safety/plan.ts";
import { type HashMatchSpec, writeHashMatches } from "../../src/seed/safety/write.ts";

const EMAIL = "demo_v00001@demo-seed.invalid";
const USERNAME = "demo_v00001";

let t: TestDatabase;
let userId: string;
let channelId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  userId = uuidv7();
  channelId = uuidv7();
  await t.app.db.insert(schema.users).values({
    id: userId,
    username: USERNAME,
    displayUsername: USERNAME,
    name: "Demo Viewer",
    email: EMAIL,
    emailVerified: true,
  });
  await t.app.db
    .insert(schema.channels)
    .values({ id: channelId, ownerId: userId, slug: USERNAME, displayName: "Demo Viewer" });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const spec = (i: number): HashMatchSpec => ({
  subjectType: "upload",
  subjectId: uuidv7(),
  provider: "fixture-list",
  matched: i % 2 === 0,
  caseId: uuidv7(),
  listCategory: i % 2 === 0 ? "csam" : "ncii",
  distance: i % 3,
  checkedAt: new Date(Date.now() - i * 1_000),
});

describe("writeHashMatches", () => {
  test("rows land in chunks of at most 1 000, as the app role", async () => {
    const specs = Array.from({ length: 1_203 }, (_, i) => spec(i));
    const n = await writeHashMatches(t.app, specs);
    expect(n).toBe(1_203);
    const [row] = await t.sql<{ n: number }[]>`select count(*)::int as n from hash_match_results`;
    expect(row?.n).toBe(1_203);
    const matched = await t.app.db.select().from(schema.hashMatchResults);
    expect(matched.filter((r) => r.matched)).toHaveLength(602);
  });

  test("details hold ids and enums only: nothing personal, no hash, no bytes", async () => {
    const rows = await t.app.db.select().from(schema.hashMatchResults);
    for (const r of rows) {
      expect(Object.keys(r.details).sort()).toEqual(["caseId", "distance", "listCategory"]);
      const text = JSON.stringify(r);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(USERNAME);
      expect(text).not.toMatch(/https?:\/\//);
    }
  });

  test("an aborted signal stops before the next chunk", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await expect(writeHashMatches(t.app, [spec(1)], ac.signal)).rejects.toThrow("stop");
  });
});

describe("rows reported", () => {
  test("count only what changed during the run, not rows already in the owned tables", async () => {
    await writeHashMatches(t.app, [spec(0), spec(1)]);
    const before = await tableCounts(t.app);
    expect(before.hash_match_results).toBeGreaterThanOrEqual(2);
    await writeHashMatches(t.app, [spec(2), spec(3), spec(4)]);
    const rows = countDelta(before, await tableCounts(t.app));
    expect(rows.hash_match_results).toBe(3);
    expect(rows.mod_actions).toBe(0);
    expect(rows).not.toHaveProperty("integrity_flags");
  });
});
