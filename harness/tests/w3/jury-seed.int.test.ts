// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The jury step's raw seeding SQL against a migrated database (batch 7 wave 1 CI: the inserts left
 * `id` to a default the tables do not have). It runs on Bun.SQL, as the step does, through every
 * 0016 case trigger (T0 confirmation by a `legal` reviewer included), and `outcomes` reads back
 * what the seed decided.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { outcomes, seedJuryCases, type SeedParties } from "../../src/w3/jury.ts";

let t: TestDatabase;
let sql: InstanceType<typeof Bun.SQL>;
const ids = { s1: uuidv7(), s2: uuidv7(), v: uuidv7(), w: uuidv7(), legal: uuidv7() };
const ch1 = uuidv7();
const ch2 = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.insert(schema.users).values(
    Object.entries(ids).map(([k, id]) => ({
      id,
      name: `jury ${k}`,
      email: `jury-${k}@example.test`,
      username: `jury_seed_${k}`,
      birthDate: "1990-01-01",
      role: k === "legal" ? ("legal" as const) : ("user" as const),
    })),
  );
  await t.db.insert(schema.channels).values([
    { id: ch1, ownerId: ids.s1, slug: "jury-seed-1", displayName: "jury seed 1" },
    { id: ch2, ownerId: ids.s2, slug: "jury-seed-2", displayName: "jury seed 2" },
  ]);
  sql = new Bun.SQL(t.url);
});

afterAll(async () => {
  await sql?.close();
  await t?.drop();
});

describe("seedJuryCases", () => {
  const parties = (): SeedParties => ({
    s1: ids.s1,
    s2: ids.s2,
    ch1,
    ch2,
    reporter: ids.w,
    reported: ids.v,
    legal: ids.legal,
  });

  test("neither table defaults its id, so a raw insert must mint one", async () => {
    const cols = (await sql`
      select table_name::text as t, column_default::text as d from information_schema.columns
       where table_schema = 'public' and column_name = 'id' and table_name in ('moderation_cases', 'reports')
       order by table_name`) as { t: string; d: string | null }[];
    expect([...cols]).toEqual([
      { t: "moderation_cases", d: null },
      { t: "reports", d: null },
    ]);
    await expect(
      sql`insert into reports (subject_type, subject_id, reason) values ('user', ${ids.v}::uuid, 'spam')`.then(
        () => "ok",
      ),
    ).rejects.toThrow(/null value in column "id"/);
  });

  test("seeds decided cases and resolved reports with minted ids", async () => {
    const seeded = await seedJuryCases(sql, parties());
    expect(seeded.ok).toHaveLength(6);
    expect(seeded.reports).toHaveLength(8);
    const all = [...seeded.ok, seeded.t0, seeded.ncii, ...seeded.reports];
    expect(new Set(all).size).toBe(all.length);

    const rows = (await sql`
      select id::text as id, tier::text as tier, status::text as status, list_category::text as list,
             rule_ref, resolved_by_id::text as resolved_by, resolved_at < now() - interval '23 hours' as day_old
        from moderation_cases where id = any(${sql.array([...seeded.ok, seeded.t0, seeded.ncii], "uuid")})`) as {
      id: string;
      tier: string;
      status: string;
      list: string | null;
      rule_ref: string | null;
      resolved_by: string | null;
      day_old: boolean;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.day_old)).toBe(true);
    expect(seeded.ok.map((id) => byId.get(id)?.status)).toEqual([
      "actioned",
      "actioned",
      "actioned",
      "actioned",
      "confirmed",
      "confirmed",
    ]);
    expect(byId.get(seeded.t0)).toMatchObject({
      tier: "t0",
      status: "confirmed",
      list: "csam",
      rule_ref: null,
      resolved_by: ids.legal,
    });
    expect(byId.get(seeded.ncii)).toMatchObject({
      tier: "t1",
      status: "actioned",
      rule_ref: "decency.intimate-images@1",
    });

    const decided = await outcomes(t.url, all);
    expect(decided).toHaveLength(all.length);
    expect(decided.filter((o) => o.status === "dismissed")).toHaveLength(3);
  });

  test("a second seed in the same database (a rerun) succeeds", async () => {
    const again = await seedJuryCases(sql, parties());
    expect(again.ok).toHaveLength(6);
  });
});
