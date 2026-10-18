// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Equivalence: the TypeScript tally must agree with `commonair_governance_tally` on the
 * same data. Every case goes through the real state machine as the least-privilege
 * application role: memberships are set, the proposal is opened for voting (so the
 * database builds the electorate itself), members vote inside the window, and after
 * the window both tallies are compared. Each proposal is then moved to passed or
 * rejected according to the TypeScript verdict, which the trigger must accept.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { GovernanceRuleSnapshot } from "@commonair/contracts/shapes";
import { schema as s, type Database } from "@commonair/db";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { ratioAtMost, ratioBelow } from "../src/numeric.ts";
import { type Ballot, type ElectorateMember, type MemberClass, type VoteChoice, tally } from "../src/tally.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await createTestDatabase({ governance: FAST_GOVERNANCE });
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("Postgres numeric emulation", () => {
  test("ratioBelow / ratioAtMost match Postgres on random and boundary inputs", async () => {
    const rand = prng(7);
    const nums: number[] = [];
    const dens: number[] = [];
    const ts: number[] = [];
    const thresholds = [0, 0.1, 0.2, 0.25, 1 / 3, 0.5, 0.6, 2 / 3, 0.7, 0.75, 0.9, 1, 0.123456789, 1e-7];
    for (let i = 0; i < 3000; i++) {
      const big = rand() < 0.2;
      const den = 1 + Math.floor(rand() * (big ? 50_000_000 : 400));
      const num = Math.floor(rand() * (den + 1));
      nums.push(num);
      dens.push(den);
      ts.push(thresholds[Math.floor(rand() * thresholds.length)]!);
    }
    for (const [n, d] of [
      [2, 3],
      [4, 6],
      [1, 2],
      [200_000_000, 300_000_000],
      [1, 3],
      [0, 1],
    ] as const) {
      for (const th of thresholds) {
        nums.push(n);
        dens.push(d);
        ts.push(th);
      }
    }
    const rows = (await t.db.execute(sql`
      select (x.n::numeric / x.d) < x.t::numeric as below, (x.n::numeric / x.d) <= x.t::numeric as at_most
        from unnest(${`{${nums.join(",")}}`}::bigint[], ${`{${dens.join(",")}}`}::bigint[],
                    ${`{${ts.map(String).join(",")}}`}::text[]) with ordinality as x(n, d, t, i)
       order by x.i`)) as unknown as { below: boolean; at_most: boolean }[];
    expect(rows).toHaveLength(nums.length);
    rows.forEach((r, i) => {
      expect(ratioBelow(nums[i]!, dens[i]!, ts[i]!), `${nums[i]}/${dens[i]} < ${ts[i]}`).toBe(r.below);
      expect(ratioAtMost(nums[i]!, dens[i]!, ts[i]!), `${nums[i]}/${dens[i]} <= ${ts[i]}`).toBe(r.at_most);
    });
  });
});

interface Case {
  name: string;
  rules: GovernanceRuleSnapshot;
  /** Pool index → classes held. */
  members: Map<number, MemberClass[]>;
  /** Pool index → choice. */
  votes: Map<number, VoteChoice>;
  proposalId?: string;
  votingEndsAt?: Date;
}

const CLASS_SETS: MemberClass[][] = [
  ["viewer"],
  ["streamer"],
  ["streamer", "viewer"],
  ["worker"],
  ["viewer", "worker"],
];

const protectedRules = (o: Partial<GovernanceRuleSnapshot> = {}): GovernanceRuleSnapshot => ({
  ruleVersion: "equivalence",
  protected: true,
  memberWideThreshold: 2 / 3,
  streamerClassThreshold: 0.5,
  quorum: 0.2,
  streamerClassQuorum: 0.2,
  councilReviewRequired: true,
  ...o,
});
const ordinaryRules = (o: Partial<GovernanceRuleSnapshot> = {}): GovernanceRuleSnapshot => ({
  ...protectedRules(),
  protected: false,
  memberWideThreshold: 0.5,
  quorum: 0.1,
  streamerClassQuorum: 0,
  councilReviewRequired: false,
  ...o,
});

const POOL = 40;
/** Pool index of a banned user: the database leaves them out of every electorate. */
const BANNED = POOL - 1;

function edgeCases(): Case[] {
  const m = (entries: [number, MemberClass[]][]) => new Map(entries);
  const v = (entries: [number, VoteChoice][]) => new Map(entries);
  const streamers = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => [from + i, ["streamer"]] as [number, MemberClass[]]);
  const viewers = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => [from + i, ["viewer"]] as [number, MemberClass[]]);
  return [
    { name: "no electorate", rules: protectedRules(), members: m([]), votes: v([]) },
    { name: "zero votes", rules: protectedRules(), members: m(streamers(5)), votes: v([]) },
    { name: "zero votes ordinary", rules: ordinaryRules(), members: m(viewers(5)), votes: v([]) },
    {
      name: "all abstain",
      rules: ordinaryRules(),
      members: m(viewers(4)),
      votes: v([0, 1, 2, 3].map((i) => [i, "abstain"])),
    },
    {
      name: "exactly 2/3",
      rules: protectedRules(),
      members: m(streamers(3)),
      votes: v([
        [0, "yes"],
        [1, "yes"],
        [2, "no"],
      ]),
    },
    {
      name: "4 of 6 = 2/3",
      rules: protectedRules(),
      members: m(streamers(6)),
      votes: v([0, 1, 2, 3, 4, 5].map((i) => [i, i < 4 ? "yes" : "no"])),
    },
    {
      name: "streamer tie 0.5",
      rules: protectedRules(),
      members: m([...viewers(8), ...streamers(2, 8)]),
      votes: v([...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, "yes"] as [number, VoteChoice]), [8, "yes"], [9, "no"]]),
    },
    {
      name: "ordinary exactly 0.5",
      rules: ordinaryRules(),
      members: m(viewers(4)),
      votes: v([
        [0, "yes"],
        [1, "no"],
      ]),
    },
    {
      name: "no streamers protected",
      rules: protectedRules(),
      members: m(viewers(5)),
      votes: v([0, 1, 2, 3, 4].map((i) => [i, "yes"])),
    },
    {
      name: "no streamers ordinary",
      rules: ordinaryRules(),
      members: m(viewers(5)),
      votes: v([0, 1, 2, 3, 4].map((i) => [i, "yes"])),
    },
    {
      name: "exact quorum 0.2",
      rules: ordinaryRules({ quorum: 0.2 }),
      members: m(viewers(10)),
      votes: v([
        [0, "yes"],
        [1, "yes"],
      ]),
    },
    {
      name: "unanimous threshold 1",
      rules: protectedRules({ memberWideThreshold: 1 }),
      members: m(streamers(4)),
      votes: v([0, 1, 2, 3].map((i) => [i, i === 3 ? "no" : "yes"])),
    },
    {
      name: "banned member excluded",
      rules: ordinaryRules({ quorum: 0.5 }),
      members: m([...viewers(2), [BANNED, ["viewer"]]]),
      votes: v([[0, "yes"]]),
    },
  ];
}

function randomCases(n: number, rand: () => number): Case[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const out: Case[] = [];
  for (let i = 0; i < n; i++) {
    const isProtected = rand() < 0.6;
    const rules = isProtected
      ? protectedRules({
          memberWideThreshold: pick([2 / 3, 0.7, 0.75, 0.8, 0.9, 1]),
          streamerClassThreshold: pick([0.5, 0.5, 0.6, 2 / 3, 0.75]),
          quorum: pick([0.2, 0.25, 1 / 3, 0.5, 0.75]),
          streamerClassQuorum: pick([0.2, 0.25, 0.5, 1]),
        })
      : ordinaryRules({ memberWideThreshold: pick([0.5, 0.6, 2 / 3, 0.75]), quorum: pick([0.1, 0.2, 0.5, 1]) });
    const size = Math.floor(rand() * rand() * POOL);
    const members = new Map<number, MemberClass[]>();
    const votes = new Map<number, VoteChoice>();
    const streamerBias = rand();
    const turnout = rand();
    const yesBias = rand();
    for (let k = 0; k < size; k++) {
      const idx = Math.floor(rand() * POOL);
      if (members.has(idx)) continue;
      const classes = rand() < streamerBias ? pick(CLASS_SETS.slice(1, 3)) : pick(CLASS_SETS);
      members.set(idx, classes);
      if (rand() < turnout) votes.set(idx, rand() < 0.15 ? "abstain" : rand() < yesBias ? "yes" : "no");
    }
    out.push({ name: `random #${i}`, rules, members, votes });
  }
  return out;
}

describe("tally equivalence with commonair_governance_tally", () => {
  test("TypeScript and SQL agree on >= 200 electorates, and the state machine accepts the verdict", async () => {
    const pool: string[] = [];
    for (let i = 0; i < POOL; i++) {
      const name = `eq${i}`;
      const [u] = await app
        .insert(s.users)
        .values({ name, email: `${name}@example.test`, username: name, banned: i === BANNED })
        .returning({ id: s.users.id });
      pool.push(u!.id);
    }
    const cases = [...edgeCases(), ...randomCases(200, prng(2026))];
    expect(cases.length).toBeGreaterThanOrEqual(200);

    // Drafts → discussion (0 s) → council review for protected ones; one shared wait.
    for (const [i, c] of cases.entries()) {
      const kind = c.rules.protected ? "protected" : "ordinary";
      const [p] = await app
        .insert(s.proposals)
        .values({
          authorId: pool[0]!,
          title: `Equivalence ${i}`,
          body: c.name,
          kind,
          affectsCreators: kind === "protected",
          changes: [{ key: "discovery.ranking", value: { case: i } }],
        })
        .returning({ id: s.proposals.id });
      c.proposalId = p!.id;
      await app.update(s.proposals).set({ status: "discussion" }).where(eq(s.proposals.id, c.proposalId));
      if (kind === "protected") {
        await app.update(s.proposals).set({ status: "council_review" }).where(eq(s.proposals.id, c.proposalId));
      }
    }
    await sleep(1200);

    // One case at a time: the electorate is whoever is an active member when voting opens.
    for (const c of cases) {
      await app.update(s.memberships).set({ status: "lapsed" }).where(eq(s.memberships.status, "active"));
      const rows = [...c.members].flatMap(([idx, classes]) =>
        classes.map((cls) => ({
          userId: pool[idx]!,
          class: cls,
          basis:
            cls === "streamer"
              ? ("streaming_hours" as const)
              : cls === "worker"
                ? ("board_appointment" as const)
                : ("share" as const),
        })),
      );
      if (rows.length) await app.insert(s.memberships).values(rows);
      const [opened] = await app
        .update(s.proposals)
        .set({ status: "voting", rules: c.rules, votingEndsAt: new Date(Date.now() + 1500) })
        .where(eq(s.proposals.id, c.proposalId!))
        .returning({ votingEndsAt: s.proposals.votingEndsAt });
      c.votingEndsAt = opened!.votingEndsAt!;
      const votes = [...c.votes]
        .filter(([idx]) => idx !== BANNED)
        .map(([idx, choice]) => ({ proposalId: c.proposalId!, userId: pool[idx]!, choice }));
      if (votes.length) await app.insert(s.votes).values(votes);
    }

    const lastEnd = Math.max(...cases.map((c) => c.votingEndsAt!.getTime()));
    await sleep(Math.max(0, lastEnd - Date.now()) + 300);

    const outcomes = { passed: 0, rejected: 0 };
    const reasons = new Set<string>();
    for (const c of cases) {
      const id = c.proposalId!;
      const [dbResult] = (await app.execute(
        sql`select passed, reason from commonair_governance_tally(${id}::uuid)`,
      )) as unknown as { passed: boolean; reason: string }[];

      // The electorate the database built must be exactly the intended one (banned user excluded).
      const electorateRows = await app
        .select({ userId: s.proposalElectorate.userId, classes: s.proposalElectorate.classes })
        .from(s.proposalElectorate)
        .where(eq(s.proposalElectorate.proposalId, id));
      const intended: ElectorateMember[] = [...c.members]
        .filter(([idx]) => idx !== BANNED)
        .map(([idx, classes]) => ({ userId: pool[idx]!, classes: [...classes].sort() }));
      expect(
        electorateRows
          .map((r) => ({ userId: r.userId, classes: [...r.classes].sort() }))
          .sort((a, b) => a.userId.localeCompare(b.userId)),
        c.name,
      ).toEqual(intended.sort((a, b) => a.userId.localeCompare(b.userId)));

      const intendedVotes: Ballot[] = [...c.votes]
        .filter(([idx]) => idx !== BANNED)
        .map(([idx, choice]) => ({ userId: pool[idx]!, choice }));
      const ts = tally(c.rules, intended, intendedVotes, { votingEndsAt: c.votingEndsAt!, now: new Date() });
      expect({ passed: ts.passed, reason: ts.reason }, `${c.name}: ${JSON.stringify(ts.breakdown.memberWide)}`).toEqual(
        dbResult,
      );

      // Same result from the rows as stored (votes with cast_at, electorate as built).
      const voteRows = await app
        .select({ userId: s.votes.userId, choice: s.votes.choice, castAt: s.votes.castAt })
        .from(s.votes)
        .where(eq(s.votes.proposalId, id));
      const fromRows = tally(c.rules, electorateRows, voteRows, { votingEndsAt: c.votingEndsAt!, now: new Date() });
      expect(fromRows.reason, c.name).toBe(dbResult!.reason);

      await app
        .update(s.proposals)
        .set({ status: ts.passed ? "passed" : "rejected" })
        .where(eq(s.proposals.id, id));
      outcomes[ts.passed ? "passed" : "rejected"]++;
      reasons.add(ts.reason);
    }
    // The random cases must exercise every rule, not just one outcome.
    expect(outcomes.passed).toBeGreaterThan(10);
    expect(outcomes.rejected).toBeGreaterThan(10);
    expect([...reasons].sort()).toEqual(
      [
        "member-wide quorum not met",
        "member-wide threshold not met",
        "passed",
        "streamer-class majority not met",
        "streamer-class quorum not met",
      ].sort(),
    );
  });
});
