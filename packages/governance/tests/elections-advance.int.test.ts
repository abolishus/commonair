// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** advanceElections (the `elections-advance` job) against a real database, as the application role. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { advanceElections } from "../src/elections.ts";

let t: TestDatabase;
let app: Database;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function viewer(): Promise<string> {
  const name = `adv${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  await app.insert(s.memberships).values({ userId: u!.id, class: "viewer", basis: "share" });
  return u!.id;
}

async function election(nominationsCloseAt: Date, votingEndsAt: Date): Promise<string> {
  const [e] = await app
    .insert(s.elections)
    .values({ class: "viewer", seats: 1, nominationsCloseAt, votingEndsAt, termMonths: 12 })
    .returning({ id: s.elections.id });
  return e!.id;
}

const statusOf = async (id: string) =>
  (await app.select({ status: s.elections.status }).from(s.elections).where(eq(s.elections.id, id)))[0]!.status;
const eventsOf = (id: string) =>
  app
    .select()
    .from(s.events)
    .where(and(eq(s.events.type, "coop.election.update"), sql`${s.events.payload}->>'election_id' = ${id}`))
    .orderBy(s.events.occurredAt, s.events.id);

describe("advanceElections", () => {
  test("opens voting when nominations close, then closes the election when voting ends", async () => {
    const id = await election(at(1), at(3));
    const candidate = await viewer();
    await app.insert(s.electionCandidates).values({ electionId: id, userId: candidate, nominatedAt: NOW });

    // Nothing is due yet.
    expect(await advanceElections(app, NOW)).toEqual({ votingOpened: 0, closed: 0, failed: 0 });
    expect(await statusOf(id)).toBe("nominating");

    expect(await advanceElections(app, at(2))).toEqual({ votingOpened: 1, closed: 0, failed: 0 });
    expect(await statusOf(id)).toBe("voting");
    // A second run in the same state changes nothing.
    expect(await advanceElections(app, at(2))).toEqual({ votingOpened: 0, closed: 0, failed: 0 });

    await app.insert(s.electionBallots).values({ electionId: id, voterId: await viewer(), candidateIds: [candidate] });
    expect(await advanceElections(app, at(4))).toEqual({ votingOpened: 0, closed: 1, failed: 0 });
    expect(await statusOf(id)).toBe("closed");
    expect(await advanceElections(app, at(5))).toEqual({ votingOpened: 0, closed: 0, failed: 0 });

    const events = await eventsOf(id);
    expect(events.map((e) => e.payload)).toEqual([
      { election_id: id, class: "viewer", status: "voting" },
      { election_id: id, class: "viewer", status: "closed" },
    ]);
    const audits = await app
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectType, "election"), eq(s.auditLog.subjectId, id)))
      .orderBy(s.auditLog.createdAt);
    expect(audits.map((a) => [a.action, a.actorType])).toEqual([
      ["election.open_voting", "system"],
      ["election.close", "system"],
    ]);
    const [seat] = await app.select().from(s.boardSeats).where(eq(s.boardSeats.electionId, id));
    expect(seat?.userId).toBe(candidate);
  });

  test("an election past both deadlines opens voting first and closes on the next run", async () => {
    const id = await election(at(-3), at(-1));
    const r1 = await advanceElections(app, NOW);
    expect(r1.votingOpened).toBe(1);
    expect(await statusOf(id)).toBe("voting");
    const r2 = await advanceElections(app, NOW);
    expect(r2.closed).toBe(1);
    expect(await statusOf(id)).toBe("closed");
  });

  test("concurrent runs open and close each election once", async () => {
    const id = await election(at(-3), at(-1));
    const opened = await Promise.all([advanceElections(app, NOW), advanceElections(app, NOW)]);
    expect(opened.reduce((n, r) => n + r.votingOpened, 0)).toBe(1);
    const closed = await Promise.all([advanceElections(app, NOW), advanceElections(app, NOW)]);
    expect(closed.reduce((n, r) => n + r.closed, 0) + opened.reduce((n, r) => n + r.closed, 0)).toBe(1);
    // Both events carry the same (test) clock, so compare them as a set.
    expect((await eventsOf(id)).map((e) => String(e.payload.status)).sort((a, b) => a.localeCompare(b))).toEqual([
      "closed",
      "voting",
    ]);
  });
});
