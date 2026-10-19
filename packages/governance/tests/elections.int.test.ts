// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** closeElection against a real database, as the application role. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { closeElection, ElectionError } from "../src/elections.ts";

let t: TestDatabase;
let app: Database;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
type Cls = "streamer" | "viewer" | "worker";
/** A user, optionally an active member of `cls`. */
async function user(cls: Cls | null = "viewer", o: Partial<typeof s.users.$inferInsert> = {}): Promise<string> {
  const name = `eluser${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, ...o })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  if (cls) {
    const basis = cls === "streamer" ? "streaming_hours" : cls === "viewer" ? "share" : "board_appointment";
    await app.insert(s.memberships).values({ userId: u.id, class: cls, basis });
  }
  return u.id;
}

async function election(o: Partial<typeof s.elections.$inferInsert> = {}) {
  const [e] = await app
    .insert(s.elections)
    .values({
      class: "viewer",
      seats: 2,
      status: "voting",
      nominationsCloseAt: new Date(NOW.getTime() - 14 * DAY),
      votingEndsAt: new Date(NOW.getTime() - 1000),
      termMonths: 12,
      ...o,
    })
    .returning({ id: s.elections.id });
  if (!e) throw new Error("no election");
  return e.id;
}

/** Nominate in order; each one a minute after the previous unless `at` is given. */
async function nominate(electionId: string, userIds: string[], at?: Date) {
  await app.insert(s.electionCandidates).values(
    userIds.map((userId, i) => ({
      electionId,
      userId,
      nominatedAt: at ?? new Date(NOW.getTime() - 20 * DAY + i * 60_000),
    })),
  );
}

async function vote(electionId: string, voterId: string, candidateIds: string[]) {
  await app.insert(s.electionBallots).values({ electionId, voterId, candidateIds });
}

const candidates = (electionId: string) =>
  app
    .select({
      userId: s.electionCandidates.userId,
      votes: s.electionCandidates.votes,
      elected: s.electionCandidates.elected,
    })
    .from(s.electionCandidates)
    .where(eq(s.electionCandidates.electionId, electionId));
const seats = (electionId: string) => app.select().from(s.boardSeats).where(eq(s.boardSeats.electionId, electionId));
const audits = (electionId: string) =>
  app
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.subjectType, "election"), eq(s.auditLog.subjectId, electionId)));
const status = async (electionId: string) =>
  (await app.select({ status: s.elections.status }).from(s.elections).where(eq(s.elections.id, electionId)))[0]?.status;

describe("closeElection: tallying", () => {
  test("the seats with the most approvals win; votes, seats and the audit row are recorded", async () => {
    const id = await election({ seats: 2, termMonths: 24 });
    const [a, b, c] = [await user(), await user(), await user()];
    await nominate(id, [a, b, c]);
    const voters = await Promise.all([1, 2, 3, 4].map(() => user()));
    await vote(id, voters[0]!, [a, b]);
    await vote(id, voters[1]!, [a, c]);
    await vote(id, voters[2]!, [a]);
    await vote(id, voters[3]!, [b]);

    const r = await closeElection(app, id, NOW);
    expect(r.alreadyClosed).toBe(false);
    expect(r.ballotsCounted).toBe(4);
    expect(r.spoiled).toEqual([]);
    expect(r.results).toEqual([
      { userId: a, votes: 3, rank: 1, elected: true },
      { userId: b, votes: 2, rank: 2, elected: true },
      { userId: c, votes: 1, rank: 3, elected: false },
    ]);
    expect(await status(id)).toBe("closed");

    const stored = new Map((await candidates(id)).map((x) => [x.userId, x]));
    expect(stored.get(a)).toMatchObject({ votes: 3, elected: true });
    expect(stored.get(b)).toMatchObject({ votes: 2, elected: true });
    expect(stored.get(c)).toMatchObject({ votes: 1, elected: false });

    const board = await seats(id);
    expect(board.map((x) => x.userId).sort()).toEqual([a, b].sort());
    for (const seat of board) {
      expect(seat.class).toBe("viewer");
      expect(seat.termStart.toISOString()).toBe(NOW.toISOString());
      expect(seat.termEnd.toISOString()).toBe("2028-06-15T12:00:00.000Z");
    }

    const [audit, ...more] = await audits(id);
    expect(more).toHaveLength(0);
    expect(audit).toMatchObject({ actorType: "system", action: "election.close" });
    expect(audit?.details).toEqual({ elected: [a, b], ballotsCounted: 4, spoiled: 0, ineligibleCandidates: [] });
  });

  test("ballots from non-members, banned members, other classes or over the seat limit are spoiled", async () => {
    const id = await election({ seats: 1 });
    const [a, b] = [await user(), await user()];
    await nominate(id, [a, b]);
    const good = await user();
    const outsider = await user(null);
    const streamer = await user("streamer");
    const banned = await user("viewer", { banned: true });
    const deleted = await user("viewer", { deletedAt: new Date(NOW.getTime() - DAY) });
    const greedy = await user();
    const stray = await user();
    await vote(id, good, [b]);
    await vote(id, outsider, [a]);
    await vote(id, streamer, [a]);
    await vote(id, banned, [a]);
    await vote(id, deleted, [a]);
    await vote(id, greedy, [a, b]);
    // An approval for a non-candidate is ignored, and the rest of the ballot still counts.
    await vote(id, stray, [b, outsider]);

    const r = await closeElection(app, id, NOW);
    expect(r.ballotsCounted).toBe(2);
    expect(r.ignoredApprovals).toBe(1);
    expect(new Map(r.spoiled.map((x) => [x.voterId, x.reason]))).toEqual(
      new Map([
        [outsider, "ineligible_voter"],
        [streamer, "ineligible_voter"],
        [banned, "ineligible_voter"],
        [deleted, "ineligible_voter"],
        [greedy, "too_many_approvals"],
      ]),
    );
    expect(r.results.filter((x) => x.elected).map((x) => x.userId)).toEqual([b]);
    expect((await audits(id))[0]?.details).toMatchObject({ elected: [b], ballotsCounted: 2, spoiled: 5 });
  });

  test("a candidate who no longer holds the class cannot be elected; their approvals are ignored", async () => {
    const id = await election({ seats: 1 });
    const [a, b] = [await user(), await user()];
    await nominate(id, [a, b]);
    for (let i = 0; i < 3; i++) await vote(id, await user(), [a]);
    await vote(id, await user(), [b]);
    await app.update(s.memberships).set({ status: "lapsed", lapsedAt: NOW }).where(eq(s.memberships.userId, a));

    const r = await closeElection(app, id, NOW);
    expect(r.ineligibleCandidates).toEqual([a]);
    expect(r.ignoredApprovals).toBe(3);
    expect(r.results).toEqual([{ userId: b, votes: 1, rank: 1, elected: true }]);
    const stored = new Map((await candidates(id)).map((x) => [x.userId, x]));
    expect(stored.get(a)).toMatchObject({ votes: 0, elected: false });
    expect((await seats(id)).map((x) => x.userId)).toEqual([b]);
    expect((await audits(id))[0]?.details).toMatchObject({ ineligibleCandidates: [a] });
  });

  test("elections tally only their own ballots and class", async () => {
    const viewerElection = await election({ class: "viewer", seats: 1 });
    const streamerElection = await election({ class: "streamer", seats: 1 });
    const v = await user("viewer");
    const st = await user("streamer");
    await nominate(viewerElection, [v]);
    await nominate(streamerElection, [st]);
    await vote(viewerElection, await user("viewer"), [v]);
    await vote(streamerElection, await user("streamer"), [st]);
    await vote(streamerElection, await user("streamer"), [st]);

    const rv = await closeElection(app, viewerElection, NOW);
    const rs = await closeElection(app, streamerElection, NOW);
    expect(rv.results).toEqual([{ userId: v, votes: 1, rank: 1, elected: true }]);
    expect(rs.results).toEqual([{ userId: st, votes: 2, rank: 1, elected: true }]);
    expect((await seats(streamerElection))[0]?.class).toBe("streamer");
  });
});

describe("closeElection: ties", () => {
  test("equal approvals: the earlier nomination wins the last seat", async () => {
    const id = await election({ seats: 1 });
    const [late, early] = [await user(), await user()];
    await app.insert(s.electionCandidates).values([
      { electionId: id, userId: late, nominatedAt: new Date(NOW.getTime() - 10 * DAY) },
      { electionId: id, userId: early, nominatedAt: new Date(NOW.getTime() - 11 * DAY) },
    ]);
    await vote(id, await user(), [late]);
    await vote(id, await user(), [early]);

    const r = await closeElection(app, id, NOW);
    expect(r.results).toEqual([
      { userId: early, votes: 1, rank: 1, elected: true },
      { userId: late, votes: 1, rank: 2, elected: false },
    ]);
  });

  test("equal approvals and nomination time: the lower user id wins", async () => {
    const id = await election({ seats: 1 });
    const [x, y] = [await user(), await user()];
    await nominate(id, [x, y], new Date(NOW.getTime() - 10 * DAY));
    await vote(id, await user(), [x]);
    await vote(id, await user(), [y]);
    const [first, second] = [x, y].sort();

    const r = await closeElection(app, id, NOW);
    expect(r.results.map((c) => [c.userId, c.elected])).toEqual([
      [first, true],
      [second, false],
    ]);
    // Re-reading the stored outcome orders the tie the same way.
    const again = await closeElection(app, id, NOW);
    expect(again.results.map((c) => c.userId)).toEqual([first, second]);
  });

  test("a tie within the seats elects everyone tied", async () => {
    const id = await election({ seats: 2 });
    const [a, b, c] = [await user(), await user(), await user()];
    await nominate(id, [a, b, c]);
    await vote(id, await user(), [a, b]);
    await vote(id, await user(), [c]);
    await vote(id, await user(), [a, b]);
    const r = await closeElection(app, id, NOW);
    expect(r.results.filter((x) => x.elected).map((x) => x.userId)).toEqual([a, b]);
  });
});

describe("closeElection: turnout (approval elections have no quorum)", () => {
  test("no ballots: closed, nobody elected, no seats, still audited", async () => {
    const id = await election({ seats: 2 });
    await nominate(id, [await user(), await user()]);
    const r = await closeElection(app, id, NOW);
    expect(r.ballotsCounted).toBe(0);
    expect(r.results.every((x) => !x.elected && x.votes === 0)).toBe(true);
    expect(await status(id)).toBe("closed");
    expect(await seats(id)).toHaveLength(0);
    expect((await audits(id))[0]?.details).toMatchObject({ elected: [], ballotsCounted: 0 });
  });

  test("only spoiled ballots: nobody elected", async () => {
    const id = await election({ seats: 1 });
    const a = await user();
    await nominate(id, [a]);
    await vote(id, await user(null), [a]);
    const r = await closeElection(app, id, NOW);
    expect(r.ballotsCounted).toBe(0);
    expect(r.spoiled).toHaveLength(1);
    expect(r.results).toEqual([{ userId: a, votes: 0, rank: 1, elected: false }]);
  });

  test("a single approval is enough to win an uncontested seat; open seats stay empty", async () => {
    const id = await election({ seats: 3 });
    const [a, b] = [await user(), await user()];
    await nominate(id, [a, b]);
    await vote(id, await user(), [a]);
    const r = await closeElection(app, id, NOW);
    expect(r.results.filter((x) => x.elected).map((x) => x.userId)).toEqual([a]);
    expect(await seats(id)).toHaveLength(1);
  });

  test("no candidates at all: closes cleanly", async () => {
    const id = await election({ seats: 2 });
    const r = await closeElection(app, id, NOW);
    expect(r.results).toEqual([]);
    expect(await status(id)).toBe("closed");
  });
});

describe("closeElection: idempotence", () => {
  test("a second close returns the stored outcome and writes nothing", async () => {
    const id = await election({ seats: 1 });
    const [a, b] = [await user(), await user()];
    await nominate(id, [a, b]);
    await vote(id, await user(), [a]);
    await vote(id, await user(), [a]);
    await vote(id, await user(), [b]);
    const first = await closeElection(app, id, NOW);

    // A late ballot and a later clock change nothing once closed.
    await vote(id, await user(), [b]);
    await vote(id, await user(), [b]);
    const second = await closeElection(app, id, new Date(NOW.getTime() + 30 * DAY));
    expect(second.alreadyClosed).toBe(true);
    expect(second.results).toEqual(first.results);
    expect(second.results[0]).toEqual({ userId: a, votes: 2, rank: 1, elected: true });
    expect(await seats(id)).toHaveLength(1);
    expect((await seats(id))[0]?.termStart.toISOString()).toBe(NOW.toISOString());
    expect(await audits(id)).toHaveLength(1);
  });

  test("two concurrent closes: one tallies, the other sees it closed; seats are written once", async () => {
    const id = await election({ seats: 1 });
    const a = await user();
    await nominate(id, [a]);
    await vote(id, await user(), [a]);
    const results = await Promise.all([closeElection(app, id, NOW), closeElection(app, id, NOW)]);
    expect(results.filter((r) => r.alreadyClosed)).toHaveLength(1);
    expect(results[0]?.results).toEqual(results[1]?.results);
    expect(await seats(id)).toHaveLength(1);
    expect(await audits(id)).toHaveLength(1);
  });
});

describe("closeElection: timing", () => {
  test("before voting ends it refuses with still_open and changes nothing", async () => {
    const ends = new Date(NOW.getTime() + 60_000);
    const id = await election({ seats: 1, votingEndsAt: ends });
    const a = await user();
    await nominate(id, [a]);
    await vote(id, await user(), [a]);

    const early = closeElection(app, id, NOW);
    await expect(early).rejects.toBeInstanceOf(ElectionError);
    await expect(closeElection(app, id, new Date(ends.getTime() - 1))).rejects.toMatchObject({ code: "still_open" });
    expect(await status(id)).toBe("voting");
    expect((await candidates(id))[0]).toMatchObject({ votes: 0, elected: false });
    expect(await seats(id)).toHaveLength(0);
    expect(await audits(id)).toHaveLength(0);

    // Exactly at the end time, voting is over.
    const r = await closeElection(app, id, ends);
    expect(r.alreadyClosed).toBe(false);
    expect(r.results[0]?.elected).toBe(true);
  });

  test("an unknown election is not_found", async () => {
    await expect(closeElection(app, "01900000-0000-7000-8000-00000000dead", NOW)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("terms start at close and run termMonths in UTC", async () => {
    const id = await election({ seats: 1, termMonths: 6 });
    const a = await user();
    await nominate(id, [a]);
    await vote(id, await user(), [a]);
    const close = new Date("2026-11-30T23:30:00.000Z");
    await closeElection(app, id, close);
    const [seat] = await seats(id);
    expect(seat?.termStart.toISOString()).toBe(close.toISOString());
    expect(seat?.termEnd.toISOString()).toBe("2027-05-30T23:30:00.000Z");
  });

  test("a term ending in a shorter month ends on that month's last day, not in the next month", async () => {
    const id = await election({ seats: 1, termMonths: 1 });
    const a = await user();
    await nominate(id, [a]);
    await vote(id, await user(), [a]);
    const close = new Date("2027-01-31T12:00:00.000Z");
    await closeElection(app, id, close);
    expect((await seats(id))[0]?.termEnd.toISOString()).toBe("2027-02-28T12:00:00.000Z");
  });
});
