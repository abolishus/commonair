// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The jury rerun cleanup against a migrated database: it removes the harness's panel (seats,
 * sampled cases and the append-only votes, by cascade through the 0046 triggers) and leaves a real
 * panel alone, on Bun.SQL as the step runs it.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { dropHarnessPanels, readPanels, seedJuryCases, type Seeded } from "../src/w3/jury.ts";

let t: TestDatabase;
let sql: InstanceType<typeof Bun.SQL>;
const people = {
  s1: uuidv7(),
  s2: uuidv7(),
  v: uuidv7(),
  w: uuidv7(),
  legal: uuidv7(),
  h1: uuidv7(),
  h2: uuidv7(),
  r1: uuidv7(),
  r2: uuidv7(),
};
/** The harness's own jurors (`e5_jury_…`) and two real members. */
const usernames: Record<keyof typeof people, string> = {
  s1: "b8h_s1",
  s2: "b8h_s2",
  v: "b8h_v",
  w: "b8h_w",
  legal: "b8h_legal",
  h1: "e5_jury_b8h1",
  h2: "e5_jury_b8h2",
  r1: "alice_b8h",
  r2: "bob_b8h",
};
const ch1 = uuidv7();
const ch2 = uuidv7();
let seeded: Seeded;

const commitment = "a".repeat(64);

async function panel(period: string): Promise<string> {
  const id = uuidv7();
  await sql`insert into jury_panels (id, period, seed_commitment, sealed_seed) values (${id}::uuid, ${period}, ${commitment}, 'sealed')`;
  return id;
}
async function seat(panelId: string, userId: string): Promise<string> {
  const id = uuidv7();
  await sql`insert into jury_seats (id, panel_id, user_id) values (${id}::uuid, ${panelId}::uuid, ${userId}::uuid)`;
  return id;
}
async function sample(panelId: string, kind: "moderation_case" | "report", subjectId: string): Promise<string> {
  const id = uuidv7();
  await sql`
    insert into jury_cases (id, panel_id, subject_kind, subject_id)
    values (${id}::uuid, ${panelId}::uuid, ${kind}::jury_subject_kind, ${subjectId}::uuid)`;
  return id;
}
async function vote(caseId: string, seatId: string): Promise<void> {
  await sql`
    insert into jury_votes (id, case_id, seat_id, vote, reason_code)
    values (${uuidv7()}::uuid, ${caseId}::uuid, ${seatId}::uuid, 'agree', 'clause_fits')`;
}
const count = async (table: "jury_seats" | "jury_cases", panelId: string): Promise<number> => {
  const rows = (await sql.unsafe(`select count(*)::int as n from ${table} where panel_id = $1`, [panelId])) as {
    n: number;
  }[];
  return rows[0]?.n ?? -1;
};
const votesOf = async (caseIds: readonly string[]): Promise<number> => {
  const rows =
    (await sql`select count(*)::int as n from jury_votes where case_id = any(${sql.array([...caseIds], "uuid")})`) as {
      n: number;
    }[];
  return rows[0]?.n ?? -1;
};

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.insert(schema.users).values(
    (Object.keys(people) as (keyof typeof people)[]).map((k) => ({
      id: people[k],
      name: `b8 harness ${k}`,
      email: `b8h-${k}@example.test`,
      username: usernames[k],
      birthDate: "1990-01-01",
      role: k === "legal" ? ("legal" as const) : ("user" as const),
    })),
  );
  await t.db.insert(schema.channels).values([
    { id: ch1, ownerId: people.s1, slug: "b8h-1", displayName: "b8 harness 1" },
    { id: ch2, ownerId: people.s2, slug: "b8h-2", displayName: "b8 harness 2" },
  ]);
  const jurors = [people.h1, people.h2, people.r1, people.r2];
  await t.db
    .insert(schema.memberships)
    .values(jurors.map((userId) => ({ userId, class: "worker" as const, basis: "board_appointment" as const })));
  await t.db.insert(schema.juryOptins).values(jurors.map((userId) => ({ userId })));
  sql = new Bun.SQL(t.url);
  seeded = await seedJuryCases(sql, {
    s1: people.s1,
    s2: people.s2,
    ch1,
    ch2,
    reporter: people.w,
    reported: people.v,
    legal: people.legal,
  });
});

afterAll(async () => {
  await sql?.close();
  await t?.drop();
});

describe("the jury rerun cleanup", () => {
  test("the seed marks every case and report it creates", async () => {
    const cases = (await sql`
      select count(*)::int as n from moderation_cases
       where id = any(${sql.array([...seeded.ok, seeded.t0, seeded.ncii], "uuid")}) and resolution_note = 'harness:e5-coop:jury'`) as {
      n: number;
    }[];
    const reports = (await sql`
      select count(*)::int as n from reports
       where id = any(${sql.array(seeded.reports, "uuid")}) and details = 'harness:e5-coop:jury'`) as { n: number }[];
    expect(cases[0]?.n).toBe(8);
    expect(reports[0]?.n).toBe(8);
  });

  test("the harness's mixed panel goes with its seats, cases and votes; a real panel stays", async () => {
    // The harness's panel: a harness juror and a real member, on the harness's cases.
    const mine = await panel("2026-01");
    const mySeats = [await seat(mine, people.h1), await seat(mine, people.r1)];
    const myCases = [
      await sample(mine, "moderation_case", seeded.ok[0] as string),
      await sample(mine, "report", seeded.reports[1] as string),
    ];
    for (const c of myCases) for (const s of mySeats) await vote(c, s);

    // A real panel: real members on a real (unmarked) report; and one where a stray harness
    // juror sits on real cases only.
    const realReport = uuidv7();
    await sql`
      insert into reports (id, reporter_id, subject_type, subject_id, reason, status, resolved_at)
      values (${realReport}::uuid, ${people.w}::uuid, 'user', ${people.v}::uuid, 'spam', 'actioned', now() - interval '1 day')`;
    const real = await panel("2026-02");
    const realSeats = [await seat(real, people.r1), await seat(real, people.r2)];
    const realCase = await sample(real, "report", realReport);
    for (const s of realSeats) await vote(realCase, s);
    const stray = await panel("2026-03");
    await seat(stray, people.h2);
    await seat(stray, people.r2);
    await sample(stray, "report", realReport);

    expect(await readPanels(sql, "2026-01")).toEqual([
      { id: mine, seats: [usernames.r1, usernames.h1].sort(), cases: 2, markedCases: 2 },
    ]);
    expect(await votesOf(myCases)).toBe(4);

    // Votes are append-only: a direct delete is refused; the panel's cascade is not.
    await expect(sql`delete from jury_votes where case_id = ${myCases[0] as string}::uuid`).rejects.toThrow(
      /append-only/,
    );
    expect(await dropHarnessPanels(sql, "2026-01")).toEqual([mine]);
    expect(await readPanels(sql, "2026-01")).toEqual([]);
    expect([await count("jury_seats", mine), await count("jury_cases", mine), await votesOf(myCases)]).toEqual([
      0, 0, 0,
    ]);

    expect(await dropHarnessPanels(sql, "2026-02")).toEqual([]);
    expect(await dropHarnessPanels(sql, "2026-03")).toEqual([]);
    expect([await count("jury_seats", real), await count("jury_cases", real), await votesOf([realCase])]).toEqual([
      2, 1, 2,
    ]);
    expect(await count("jury_seats", stray)).toBe(2);
  });

  test("a period with no panel, or another period, is left alone", async () => {
    expect(await dropHarnessPanels(sql, "2026-12")).toEqual([]);
  });
});
