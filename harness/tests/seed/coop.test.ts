// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-coop's plans: memberships and shares, proposals in every status with votes that tally as
 * planned, the elections, the jury's inputs and votes, and the patronage window. The API steps that
 * carry them out are exercised by `seed full` live.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  E5_GOVERNANCE_BOOTSTRAP,
  PROPOSAL_ORDER,
  STREAMER_MAJORITY_NOT_MET,
  expectedTally,
  qualifyingTier,
} from "../../src/coop.ts";
import { FIXED_ACCOUNTS, bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { subscriptionsFromStore, unit } from "../../src/seed/coop.ts";
import { governanceSignIns } from "../../src/seed/coop/api.ts";
import {
  type CoopFacts,
  type ElectorateMember,
  type GovernancePlan,
  type MembershipPlan,
  DEFAULT_PERIODS,
  JURY_K,
  JURY_MIN_OPTINS,
  changeFor,
  choiceMix,
  expectedBoardSeats,
  fillerTitles,
  forbiddenSamples,
  inRevenuePeriod,
  isAdult,
  juryInputProblems,
  juryOptInTarget,
  patronageWindow,
  planGovernance,
  planJuryVotes,
  planMemberships,
  plannedOutcome,
  qualifyingViewers,
  rulesOf,
  seatsOf,
  subscriptionQualifies,
} from "../../src/seed/coop/plan.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";
import type { SeededChannel, SeededUser } from "../../src/seed/types.ts";
import { SEED_UNITS, orderUnits } from "../../src/seed/units.ts";

const NOW = new Date("2026-11-01T12:00:00Z");
const SMALL = SEED_SCALES.small;
const SEATS = { streamer: 3, viewer: 3, worker: 1 } as const;
const PRICES = [
  { tier: 1 as const, price: { cents: 499 } },
  { tier: 2 as const, price: { cents: 999 } },
  { tier: 3 as const, price: { cents: 2499 } },
];

/** A store as seed-social leaves it: fixed logins, bulk streamers and viewers (half adults). */
function fixture(scale: Pick<SeedScale, "streamers" | "viewers">) {
  const users: SeededUser[] = [];
  const add = (handle: string, kind: SeededUser["kind"], role = "user") =>
    users.push({
      id: `00000000-0000-7000-8000-${String(users.length).padStart(12, "0")}`,
      handle,
      username: `demo_${handle}`,
      email: `demo_${handle}@demo-seed.invalid`,
      kind,
      platformRole: role,
    });
  for (const a of FIXED_ACCOUNTS) add(a.handle, a.bot ? "bot" : "fixed", a.platformRole);
  for (let i = 1; i <= scale.streamers; i++) add(bulkStreamerHandle(i), "bulk-streamer");
  for (let i = 1; i <= scale.viewers; i++) add(bulkViewerHandle(i), "bulk-viewer");
  const streamers = [
    ...FIXED_ACCOUNTS.filter((a) => a.streamer).map((a) => a.handle),
    ...users.filter((u) => u.kind === "bulk-streamer").map((u) => u.handle),
  ];
  const channels: SeededChannel[] = streamers.map((h) => ({
    id: `c-${h}`,
    ownerId: users.find((u) => u.handle === h)?.id ?? "",
    ownerHandle: h,
    slug: `demo_${h}`,
  }));
  const bulk = users.filter((u) => u.kind === "bulk-viewer").map((u) => u.handle);
  const adults = new Set([
    ...FIXED_ACCOUNTS.filter((a) => !a.bot).map((a) => a.handle),
    ...bulk.filter((_, i) => i % 2 === 0),
  ]);
  const subscriptionsByUser: CoopFacts["subscriptionsByUser"] = Object.fromEntries([
    ["viewer1", [{ channelSlug: "demo_streamer1", tier: 1, status: "active" }]],
    ...bulk
      .filter((_, i) => i % 3 === 0)
      .map((h, i) => [
        h,
        [
          {
            channelSlug: `demo_${streamers[i % streamers.length] ?? "streamer1"}`,
            tier: (i % 3) + 1,
            status: i % 5 === 4 ? "canceled" : "active",
          },
        ],
      ]),
  ]);
  const facts: CoopFacts = {
    users,
    channels,
    adults,
    subscriptionsByUser,
    tierPrices: Object.fromEntries(channels.map((c) => [c.slug, PRICES])),
    minSubscriptionCents: 300,
  };
  return { facts, streamers };
}

/** The active electorate after the sync: streamers by hours, workers, viewers by subscription or share. */
function electorateOf(facts: CoopFacts, streamers: readonly string[], m: MembershipPlan): ElectorateMember[] {
  const classes = new Map<string, Set<"streamer" | "viewer" | "worker">>();
  const add = (h: string, c: "streamer" | "viewer" | "worker") => classes.set(h, (classes.get(h) ?? new Set()).add(c));
  for (const h of streamers) add(h, "streamer");
  for (const h of m.workers) add(h, "worker");
  for (const h of m.expectedViewerMembers) add(h, "viewer");
  void facts;
  return [...classes].map(([handle, cs]) => ({ handle, classes: [...cs].sort() }));
}

function plansFor(seed: number, scale: SeedScale = SMALL) {
  const { facts, streamers } = fixture(scale);
  const rng = createRng(seed).fork("coop");
  const membership = planMemberships(rng.fork("memberships"), scale, facts);
  const electorate = electorateOf(facts, streamers, membership);
  const governance = planGovernance(rng.fork("governance"), scale, { electorate, seats: SEATS });
  return { facts, membership, electorate, governance };
}

const statuses = (g: GovernancePlan) => new Set(g.proposals.map((p) => p.target));
const counts = (g: GovernancePlan, m: MembershipPlan) => ({
  proposals: g.proposals.length,
  votes: g.proposals.reduce((n, p) => n + p.votes.length, 0),
  comments: g.proposals.reduce((n, p) => n + p.comments.length, 0),
  elections: g.elections.length,
  ballots: g.elections.reduce((n, e) => n + e.ballots.length, 0),
  workers: m.workers.length,
  pendingShares: m.shares.pending.length,
});

describe("determinism and scale", () => {
  test("the same seed and facts give the same plans", () => {
    const a = plansFor(7);
    const b = plansFor(7);
    expect(b.membership).toEqual(a.membership);
    expect(b.governance).toEqual(a.governance);
  });

  test("another seed changes the content, not the counts", () => {
    const a = plansFor(7);
    const b = plansFor(8);
    expect(counts(b.governance, b.membership)).toEqual(counts(a.governance, a.membership));
    expect(JSON.stringify(b.governance)).not.toBe(JSON.stringify(a.governance));
  });

  test("counts grow with the factor", () => {
    const small = plansFor(3, SMALL);
    const medium = plansFor(3, SEED_SCALES.medium);
    const s = counts(small.governance, small.membership);
    const m = counts(medium.governance, medium.membership);
    expect(m.proposals).toBeGreaterThan(s.proposals);
    expect(m.votes).toBeGreaterThan(s.votes);
    expect(m.workers).toBe(juryOptInTarget(SEED_SCALES.medium));
    expect(m.pendingShares).toBe(2 * SEED_SCALES.medium.factor);
    expect(s.pendingShares).toBe(2);
  });

  test("the largest preset plans without writing anything", () => {
    const { governance, membership } = plansFor(5, SEED_SCALES.large);
    expect(membership.workers).toHaveLength(juryOptInTarget(SEED_SCALES.large));
    expect(governance.proposals.filter((p) => p.ref.startsWith("filler-"))).toHaveLength(4 * SEED_SCALES.large.factor);
  });

  test("zero bulk accounts: member1 alone opts in and governance still plans", () => {
    const zero = { ...SMALL, streamers: 0, viewers: 0 };
    const { governance, membership } = plansFor(4, zero);
    expect(membership.juryOptIns).toEqual(["member1"]);
    expect(membership.shares.pending).toEqual([]);
    expect(membership.shares.refunded).toEqual([]);
    expect(juryInputProblems({ caseIds: [], reportIds: [], optIns: membership.juryOptIns })).toHaveLength(2);
    expect(statuses(governance).has("rejected")).toBe(true);
  });

  test("seed-coop runs after social, money and safety, acyclically", () => {
    expect(unit.after).toEqual(["social", "money", "safety"]);
    const order = orderUnits(SEED_UNITS).map((u) => u.name);
    for (const dep of unit.after) expect(order.indexOf(dep)).toBeLessThan(order.indexOf("coop"));
    // Shares are manual transfers under COOP_TEST_HOOKS, on stripe-mock too: nothing stays pending.
    expect(unit.pending).toEqual([]);
    expect(unit.tables).toContain("membership_shares");
  });
});

describe("fixed logins", () => {
  const { governance, membership, electorate } = plansFor(11);

  test("member1: worker, held share, jury opt-in, a draft, votes on both sides", () => {
    expect(membership.workers[0]).toBe("member1");
    expect(membership.shares.held).toEqual(["member1"]);
    expect(membership.juryOptIns).toContain("member1");
    const draft = governance.proposals.find((p) => p.ref === governance.draft);
    expect(draft?.author).toBe("member1");
    expect(draft?.target).toBe("draft");
    const choices = governance.proposals.flatMap((p) =>
      p.votes.filter((v) => v.handle === "member1").map((v) => v.choice),
    );
    expect(choices).toContain("yes");
    expect(choices).toContain("no");
    expect(electorate.find((m) => m.handle === "member1")?.classes).toEqual(["viewer", "worker"]);
  });

  test("council1 and council2: candidates in the streamer election, authors, council stances", () => {
    const streamer = governance.elections.find((e) => e.cls === "streamer");
    expect(streamer?.candidates.map((c) => c.handle)).toEqual(expect.arrayContaining(["council1", "council2"]));
    expect(governance.proposals.some((p) => p.author === "council1")).toBe(true);
    expect(governance.proposals.some((p) => p.author === "council2")).toBe(true);
    expect(governance.proposals.filter((p) => p.councilStance !== null).length).toBeGreaterThanOrEqual(4);
  });

  test("the showcase proposal is decided, with comments and a council response", () => {
    const s = governance.proposals.find((p) => p.ref === governance.showcase);
    expect(s?.target).toBe("applied");
    expect(s?.comments.length).toBeGreaterThanOrEqual(3);
    expect(s?.councilStance).toBe("support");
    expect(new Set(s?.comments.map((c) => c.author)).size).toBeGreaterThanOrEqual(3);
  });

  test("the plan refuses an electorate without council1 as a streamer member", () => {
    const without = electorate.map((m) => (m.handle === "council1" ? { ...m, classes: ["worker" as const] } : m));
    expect(() => planGovernance(createRng(1), SMALL, { electorate: without, seats: SEATS })).toThrow(/council1/);
  });
});

describe("states at small", () => {
  const { governance, membership, electorate } = plansFor(21);

  test("every proposal status of PROPOSAL_ORDER (passed shows as applied)", () => {
    const want = Object.keys(PROPOSAL_ORDER).map((s) => (s === "passed" ? "applied" : s));
    for (const s of want) expect(statuses(governance), s).toContain(s);
  });

  test("a protected proposal fails on the streamer-class majority", () => {
    const p = governance.proposals.find((x) => x.reason === STREAMER_MAJORITY_NOT_MET);
    expect(p?.protected).toBe(true);
    expect(p?.change).toBe("platformCut");
    expect(plannedOutcome(p?.votes ?? [], electorate, true)).toEqual({
      passed: false,
      reason: STREAMER_MAJORITY_NOT_MET,
    });
    const t = expectedTally(p?.votes ?? []);
    expect(t.memberWide.yes / (t.memberWide.yes + t.memberWide.no)).toBeGreaterThanOrEqual(2 / 3);
  });

  test("an election in each state, and the closed one fills board seats", () => {
    expect(governance.elections.map((e) => e.target).sort()).toEqual(["closed", "nominating", "voting"]);
    const closed = governance.elections.find((e) => e.target === "closed");
    expect(closed && expectedBoardSeats(closed, SEATS.streamer)).toBeGreaterThan(0);
    for (const e of governance.elections) {
      const pool = electorate.filter((m) => m.classes.includes(e.cls)).map((m) => m.handle);
      for (const c of e.candidates) expect(pool).toContain(c.handle);
      for (const b of e.ballots) {
        expect(pool).toContain(b.voter);
        expect(b.approve.length).toBeLessThanOrEqual(SEATS[e.cls]);
        expect(b.approve.length).toBeGreaterThan(0);
      }
    }
    expect(governance.elections.find((e) => e.target === "voting")?.ballots.length).toBeGreaterThan(0);
  });

  test("shares: held, pending and refunded; nobody in two of them", () => {
    const all = [...membership.shares.held, ...membership.shares.pending, ...membership.shares.refunded];
    expect(membership.shares.pending.length).toBeGreaterThan(0);
    expect(membership.shares.refunded).toHaveLength(1);
    expect(new Set(all).size).toBe(all.length);
    for (const h of membership.shares.pending) expect(membership.juryOptIns).not.toContain(h);
  });

  test("the open states are gated behind the restorations of the default periods", () => {
    const ref = (r: string) => governance.proposals.find((p) => p.ref === r);
    expect(ref("councilReview")?.gate).toMatchObject({ after: "votingEndsWithin", ref: "protectionsDefaults" });
    expect(ref("voting")?.gate).toMatchObject({ after: "votingEndsWithin", ref: "ordinaryDefaults" });
    expect(ref("discussion")?.gate).toEqual({ after: "applied", ref: "ordinaryDefaults" });
    expect(ref("ordinaryDefaults")?.gate).toEqual({ after: "status", ref: "protectionsDefaults", status: "voting" });
    expect(ref("discussion")?.comments.length).toBeGreaterThanOrEqual(3);
    expect(ref("voting")?.votes.length).toBeGreaterThan(0);
  });
});

describe("votes and tallies", () => {
  const { governance, electorate } = plansFor(31);

  test("every decided proposal's votes give its planned outcome", () => {
    for (const p of governance.proposals.filter((x) => x.target === "applied" || x.target === "rejected")) {
      const o = plannedOutcome(p.votes, electorate, p.protected);
      expect(o.passed, p.ref).toBe(p.target === "applied");
      expect(o.reason, p.ref).toBe(p.reason);
    }
  });

  test("the planned votes give the planned tallies (expectedTally)", () => {
    for (const p of governance.proposals) {
      const t = expectedTally(p.votes);
      expect(t.memberWide.yes + t.memberWide.no + t.memberWide.abstain).toBe(p.votes.length);
      for (const c of ["streamer", "viewer", "worker"] as const) {
        const voters = p.votes.filter((v) => v.classes.includes(c)).length;
        expect(t.byClass[c].yes + t.byClass[c].no + t.byClass[c].abstain).toBe(voters);
      }
      expect(new Set(p.votes.map((v) => v.handle)).size, p.ref).toBe(p.votes.length);
      for (const v of p.votes) expect(electorate.some((m) => m.handle === v.handle)).toBe(true);
    }
  });

  test("votes are cast across classes", () => {
    const classes = new Set(governance.proposals.flatMap((p) => p.votes.flatMap((v) => v.classes)));
    expect([...classes].sort()).toEqual(["streamer", "viewer", "worker"]);
  });

  test("choiceMix passes or fails the ordinary threshold for every size", () => {
    for (let n = 1; n <= 40; n++) {
      const pass = choiceMix(createRng(n), n, "pass");
      const fail = choiceMix(createRng(n), n, "fail");
      const ratio = (c: string[]) =>
        c.filter((x) => x === "yes").length / Math.max(1, c.filter((x) => x !== "abstain").length);
      expect(pass).toHaveLength(n);
      expect(ratio(pass)).toBeGreaterThanOrEqual(0.5);
      expect(ratio(fail)).toBeLessThan(0.5);
    }
  });

  test("plannedOutcome follows the rule order and quorums", () => {
    const e: ElectorateMember[] = Array.from({ length: 200 }, (_, i) => ({ handle: `m${i}`, classes: ["viewer"] }));
    const yes = { handle: "m0", classes: ["viewer" as const], choice: "yes" as const };
    expect(plannedOutcome([yes], e, false).passed).toBe(false);
    expect(plannedOutcome([yes], e, false).reason).toBe("member-wide quorum not met");
    expect(plannedOutcome([yes, { ...yes, handle: "m1" }], e, false).passed).toBe(true);
    expect(plannedOutcome([yes, { ...yes, handle: "m1" }], e, true).reason).toBe("streamer-class quorum not met");
  });
});

describe("electorate eligibility", () => {
  const { facts } = fixture(SMALL);

  test("a subscription qualifies when its tier is priced at or above minSubscriptionCents", () => {
    expect(qualifyingTier(PRICES, 300)).toBe(1);
    expect(subscriptionQualifies({ channelSlug: "demo_streamer1", tier: 1, status: "active" }, "viewer1", facts)).toBe(
      true,
    );
    const dear = { ...facts, minSubscriptionCents: 900 };
    expect(qualifyingTier(PRICES, 900)).toBe(2);
    expect(subscriptionQualifies({ channelSlug: "demo_streamer1", tier: 1, status: "active" }, "viewer1", dear)).toBe(
      false,
    );
    expect(subscriptionQualifies({ channelSlug: "demo_streamer1", tier: 2, status: "active" }, "viewer1", dear)).toBe(
      true,
    );
    expect(qualifyingTier(PRICES, 5_000)).toBeNull();
    expect(
      subscriptionQualifies({ channelSlug: "demo_streamer1", tier: 3, status: "active" }, "viewer1", {
        ...facts,
        minSubscriptionCents: 5_000,
      }),
    ).toBe(false);
  });

  test("inactive subscriptions, own channels and unknown channels never qualify", () => {
    expect(
      subscriptionQualifies({ channelSlug: "demo_streamer1", tier: 3, status: "canceled" }, "viewer1", facts),
    ).toBe(false);
    expect(
      subscriptionQualifies({ channelSlug: "demo_streamer1", tier: 3, status: "active" }, "streamer1", facts),
    ).toBe(false);
    expect(subscriptionQualifies({ channelSlug: "demo_nobody", tier: 3, status: "active" }, "viewer1", facts)).toBe(
      false,
    );
  });

  test("qualifyingViewers lists exactly the holders of a qualifying subscription", () => {
    const q = qualifyingViewers(facts);
    expect(q).toContain("viewer1");
    for (const [h, subs] of Object.entries(facts.subscriptionsByUser))
      expect(q.includes(h)).toBe(subs.some((s) => s.status === "active"));
    expect(qualifyingViewers({ ...facts, minSubscriptionCents: 5_000 })).toEqual([]);
  });

  test("subscriptionsFromStore keeps only well-formed entries", () => {
    expect(subscriptionsFromStore(undefined)).toEqual({});
    expect(
      subscriptionsFromStore({ a: [{ channelSlug: "x", tier: 1, status: "active" }, { tier: "1" }], b: "no" }),
    ).toEqual({
      a: [{ channelSlug: "x", tier: 1, status: "active" }],
    });
  });

  test("isAdult: 18 on the day, unknown dates are not adults", () => {
    expect(isAdult("2008-11-01", NOW)).toBe(true);
    expect(isAdult("2008-11-02", NOW)).toBe(false);
    expect(isAdult(null, NOW)).toBe(false);
    expect(isAdult("not a date", NOW)).toBe(false);
  });
});

describe("jury", () => {
  const { membership, facts } = plansFor(41);

  test("at least 12 eligible opt-ins: adults, all appointed workers", () => {
    expect(membership.juryOptIns.length).toBeGreaterThanOrEqual(JURY_MIN_OPTINS);
    for (const h of membership.juryOptIns) {
      expect(facts.adults.has(h), h).toBe(true);
      expect(membership.workers).toContain(h);
      const u = facts.users.find((x) => x.handle === h);
      expect(u?.kind === "bot" || u?.platformRole !== "user").toBe(false);
    }
  });

  test("the planned jury reaches k = 10 cases with seed-safety's lists", () => {
    const caseIds = Array.from({ length: 6 }, (_, i) => `case-${i}`);
    const reportIds = Array.from({ length: 4 }, (_, i) => `report-${i}`);
    expect(juryInputProblems({ caseIds, reportIds, optIns: membership.juryOptIns })).toEqual([]);
    expect(juryInputProblems({ caseIds: caseIds.slice(0, 5), reportIds, optIns: membership.juryOptIns })[0]).toMatch(
      new RegExp(`k = ${JURY_K}`),
    );
  });

  test("everyone disagrees on the shared case only; no other case gets a disagree majority", () => {
    const lists = Array.from({ length: 7 }, (_, j) => ["a", "b", "c", "d", ...(j % 2 ? ["e"] : [])]);
    const votes = planJuryVotes(createRng(5), lists, "b");
    expect(votes).toHaveLength(lists.flat().length);
    expect(votes.filter((v) => v.caseId === "b").every((v) => v.vote === "disagree")).toBe(true);
    for (const id of ["a", "c", "d", "e"]) {
      const on = votes.filter((v) => v.caseId === id);
      expect(on.filter((v) => v.vote === "disagree")).toHaveLength(0);
      expect(on.filter((v) => v.vote === "unsure").length).toBeLessThanOrEqual(1);
    }
    expect(planJuryVotes(createRng(5), lists, "b")).toEqual(votes);
  });

  test("no T0 or NCII id passes the sample check", () => {
    const rows = [
      { subjectId: "ok", tier: "t1", listCategory: null, ruleRef: "safety.weapons@1" },
      { subjectId: "report", tier: null, listCategory: null, ruleRef: "conduct.harassment@1" },
      { subjectId: "t0", tier: "t0", listCategory: null, ruleRef: null },
      { subjectId: "hash", tier: "t1", listCategory: "csam", ruleRef: null },
      { subjectId: "ncii", tier: "t1", listCategory: null, ruleRef: "decency.intimate-images@1" },
      { subjectId: "minor", tier: "t2", listCategory: null, ruleRef: "safety.minors@2" },
    ];
    expect(forbiddenSamples(rows)).toEqual(["hash", "minor", "ncii", "t0"]);
    expect(forbiddenSamples(rows.slice(0, 2))).toEqual([]);
  });
});

describe("settings and patronage", () => {
  const settings = [
    { key: "discovery.ranking", value: { spotlightSlots: 4, other: true } },
    { key: "governance.ordinary", value: { threshold: 0.5, ...E5_GOVERNANCE_BOOTSTRAP["governance.ordinary"] } },
    {
      key: "governance.protections",
      value: {
        protectedKeys: ["platform.cut"],
        memberWideThreshold: 2 / 3,
        streamerClassThreshold: 0.5,
        ...E5_GOVERNANCE_BOOTSTRAP["governance.protections"],
      },
    },
    { key: "platform.cut", value: { streamerShare: 0.9, coopShare: 0.1 } },
    { key: "board.seats", value: { streamer: 3, viewer: 3, worker: 1, termMonths: 24 } },
  ];

  test("each change carries the whole new value", () => {
    expect(changeFor("spotlight", settings)).toEqual({
      key: "discovery.ranking",
      value: { spotlightSlots: 5, other: true },
    });
    expect(changeFor("juryOn", settings)).toEqual({ key: "jury.enabled", value: { enabled: true } });
    expect(changeFor("platformCut", settings).value).toEqual({ streamerShare: 0.85, coopShare: 0.15 });
    expect(changeFor("ordinaryDefaults", settings).value).toEqual({
      threshold: 0.5,
      ...DEFAULT_PERIODS["governance.ordinary"],
    });
    expect(changeFor("protectionsDefaults", settings).value).toMatchObject({
      protectedKeys: ["platform.cut"],
      ...DEFAULT_PERIODS["governance.protections"],
    });
    expect(() => changeFor("spotlight", [])).toThrow(/discovery.ranking/);
  });

  test("seats and rules read from the settings", () => {
    expect(seatsOf(settings)).toEqual({ streamer: 3, viewer: 3, worker: 1 });
    expect(seatsOf([])).toEqual({ streamer: 0, viewer: 0, worker: 0 });
    expect(rulesOf(settings).ordinary).toEqual({ threshold: 0.5, quorum: 0.01 });
    expect(rulesOf(settings).protected.memberWideThreshold).toBeCloseTo(2 / 3);
  });

  test("the patronage window runs from the seed's start to a second ago, after existing periods", () => {
    const start = new Date("2026-11-01T10:00:00.400Z");
    const w = patronageWindow(start, NOW, []);
    expect(w?.start.toISOString()).toBe("2026-11-01T10:00:01.000Z");
    expect(w?.end.toISOString()).toBe("2026-11-01T11:59:59.000Z");
    expect(patronageWindow(start, NOW, [{ periodEnd: "2026-11-01T12:00:00Z" }])).toBeNull();
    expect(w && inRevenuePeriod(w, "2026-11")).toBe(true);
    expect(w && inRevenuePeriod(w, "2026-10")).toBe(false);
    expect(w && inRevenuePeriod(w, null)).toBe(true);
  });
});

describe("seed-safety's restricted accounts", () => {
  test("no worker, juror or share buyer is an account seed-safety suspended", () => {
    const { facts } = fixture(SMALL);
    const free = planMemberships(createRng(5).fork("memberships"), SMALL, facts);
    const picked = (m: MembershipPlan) => [...m.workers, ...m.shares.held, ...m.shares.pending, ...m.shares.refunded];
    const idOf = new Map(facts.users.map((u) => [u.handle, u.id]));
    const restricted = new Set(
      picked(free)
        .filter((h) => h !== "member1")
        .map((h) => idOf.get(h) ?? h),
    );
    expect(restricted.size).toBeGreaterThan(0);
    const m = planMemberships(createRng(5).fork("memberships"), SMALL, { ...facts, restrictedUserIds: restricted });
    for (const h of picked(m)) expect(restricted.has(idOf.get(h) ?? h)).toBe(false);
  });
});

describe("governanceSignIns", () => {
  test("every voter, ballot voter and responder once, so none signs in inside a voting window", () => {
    const { governance } = plansFor(7, SEED_SCALES.medium);
    const list = governanceSignIns(governance, ["council1", "council2"]);
    expect(new Set(list).size).toBe(list.length);
    for (const p of governance.proposals) for (const v of p.votes) expect(list).toContain(v.handle);
    for (const e of governance.elections) for (const b of e.ballots) expect(list).toContain(b.voter);
    expect(list).toEqual(expect.arrayContaining(["council1", "council2"]));
  });
});

describe("filler proposals", () => {
  test("never list member1, so no one voter casts dozens of votes as the fillers open together", () => {
    const { governance } = plansFor(7, SEED_SCALES.medium);
    const fillers = governance.proposals.filter((p) => p.ref.startsWith("filler-"));
    expect(fillers.length).toBeGreaterThan(0);
    for (const f of fillers) expect(f.votes.map((v) => v.handle)).not.toContain("member1");
    const perVoter = new Map<string, number>();
    for (const p of governance.proposals)
      for (const v of p.votes) perVoter.set(v.handle, (perVoter.get(v.handle) ?? 0) + 1);
    expect(Math.max(...perVoter.values())).toBeLessThan(fillers.length);
  });

  test("every proposal title is unique at every scale, with no numbered repeats (F19)", () => {
    for (const scale of [SMALL, SEED_SCALES.medium, SEED_SCALES.large]) {
      const titles = plansFor(7, scale).governance.proposals.map((p) => p.title);
      expect(new Set(titles).size, `factor ${scale.factor}`).toBe(titles.length);
      for (const t of titles) {
        expect(t).not.toMatch(/\(\d+\)$/);
        expect(t.length).toBeGreaterThanOrEqual(5);
        expect(t.length).toBeLessThanOrEqual(140);
      }
    }
  });

  test("fillerTitles: distinct, the hand-written topics first, and still distinct past every pairing", () => {
    const small = fillerTitles(4);
    expect(small[0]).toBe("Publish the moderation handbook in more languages");
    const many = fillerTitles(1_000);
    expect(many).toHaveLength(1_000);
    expect(new Set(many).size).toBe(1_000);
    expect(fillerTitles(400).every((t) => !t.includes("phase"))).toBe(true);
    expect(fillerTitles(0)).toEqual([]);
  });
});
