// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { GovernanceRuleSnapshot } from "@commonair/contracts/shapes";
import { TallyBreakdown } from "@commonair/contracts/shapes";
import {
  type Ballot,
  type ElectorateMember,
  type VoteChoice,
  countVotes,
  rulesWellFormed,
  tally,
} from "../src/tally.ts";

const protectedRules: GovernanceRuleSnapshot = {
  ruleVersion: "test",
  protected: true,
  memberWideThreshold: 2 / 3,
  streamerClassThreshold: 0.5,
  quorum: 0.2,
  streamerClassQuorum: 0.2,
  councilReviewRequired: true,
};
const ordinaryRules: GovernanceRuleSnapshot = {
  ...protectedRules,
  protected: false,
  memberWideThreshold: 0.5,
  quorum: 0.1,
};

/** Build an electorate: `v` viewers, `s` streamers, `b` members holding both. */
function people(v: number, s: number, b = 0): ElectorateMember[] {
  return [
    ...Array.from({ length: v }, (_, i) => ({ userId: `v${i}`, classes: ["viewer" as const] })),
    ...Array.from({ length: s }, (_, i) => ({ userId: `s${i}`, classes: ["streamer" as const] })),
    ...Array.from({ length: b }, (_, i) => ({ userId: `b${i}`, classes: ["streamer" as const, "viewer" as const] })),
  ];
}
const ballots = (prefix: string, choices: VoteChoice[]): Ballot[] =>
  choices.map((choice, i) => ({ userId: `${prefix}${i}`, choice }));
const rep = (choice: VoteChoice, n: number): VoteChoice[] => Array.from({ length: n }, () => choice);

describe("tally rule order and reasons (mirrors commonair_governance_tally)", () => {
  test("no electorate fails the member-wide quorum", () => {
    const r = tally(protectedRules, [], []);
    expect(r).toMatchObject({ passed: false, reason: "member-wide quorum not met" });
  });

  test("zero votes fail quorum", () => {
    expect(tally(protectedRules, people(5, 5), []).reason).toBe("member-wide quorum not met");
  });

  test("quorum is met exactly at the threshold (>=)", () => {
    // 2 of 10 = 0.2 turnout
    const r = tally(ordinaryRules, people(10, 0), ballots("v", ["yes", "yes"]));
    expect(r.passed).toBe(true);
    const below = tally({ ...ordinaryRules, quorum: 0.21 }, people(10, 0), ballots("v", ["yes", "yes"]));
    expect(below.reason).toBe("member-wide quorum not met");
  });

  test("all abstain meets quorum but fails the threshold (yes+no = 0)", () => {
    const r = tally(ordinaryRules, people(4, 0), ballots("v", rep("abstain", 4)));
    expect(r.reason).toBe("member-wide threshold not met");
    expect(r.breakdown.checks.find((c) => c.rule === "member_wide_quorum")?.passed).toBe(true);
  });

  test("exactly 2/3 yes passes the 2/3 supermajority; just under fails", () => {
    const pass = tally(protectedRules, people(0, 3), ballots("s", ["yes", "yes", "no"]));
    expect(pass).toMatchObject({ passed: true, reason: "passed" });
    const fail = tally(protectedRules, people(0, 3), ballots("s", ["yes", "no", "no"]));
    expect(fail.reason).toBe("member-wide threshold not met");
  });

  test("abstentions count for quorum but not for the threshold", () => {
    const r = tally(protectedRules, people(0, 5), ballots("s", ["yes", "yes", "no", "abstain", "abstain"]));
    expect(r.passed).toBe(true);
    expect(r.breakdown.memberWide).toEqual({ eligible: 5, yes: 2, no: 1, abstain: 2 });
  });

  test("protected: passes member-wide but fails in the streamer class (the harness scenario)", () => {
    // 9 viewers yes; 3 streamers: 1 yes 2 no. Member-wide 10/12 = 83% yes; streamer class 33%.
    const votes = [...ballots("v", rep("yes", 9)), ...ballots("s", ["yes", "no", "no"])];
    const r = tally(protectedRules, people(9, 3), votes);
    expect(r).toMatchObject({ passed: false, reason: "streamer-class majority not met" });
    // The same votes pass as an ordinary decision: the streamer class is not consulted.
    expect(tally(ordinaryRules, people(9, 3), votes).passed).toBe(true);
  });

  test("protected: an exact streamer tie is not a majority (strictly greater)", () => {
    const votes = [...ballots("v", rep("yes", 8)), ...ballots("s", ["yes", "no"])];
    expect(tally(protectedRules, people(8, 2), votes).reason).toBe("streamer-class majority not met");
    const win = [...ballots("v", rep("yes", 8)), ...ballots("s", ["yes", "yes", "no"])];
    expect(tally(protectedRules, people(8, 3), win).passed).toBe(true);
  });

  test("protected with no streamers fails the streamer-class quorum", () => {
    const r = tally(protectedRules, people(5, 0), ballots("v", rep("yes", 5)));
    expect(r.reason).toBe("streamer-class quorum not met");
  });

  test("protected: streamers who all abstain fail the streamer-class majority", () => {
    const votes = [...ballots("v", rep("yes", 5)), ...ballots("s", rep("abstain", 2))];
    expect(tally(protectedRules, people(5, 2), votes).reason).toBe("streamer-class majority not met");
  });

  test("protected: low streamer turnout fails the streamer-class quorum", () => {
    const votes = [...ballots("v", rep("yes", 10)), ...ballots("s", ["yes"])];
    expect(tally(protectedRules, people(10, 10), votes).reason).toBe("streamer-class quorum not met");
  });

  test("members holding several classes count once member-wide and in each class", () => {
    const r = tally(protectedRules, people(1, 0, 2), ballots("b", ["yes", "no"]));
    expect(r.breakdown.memberWide).toEqual({ eligible: 3, yes: 1, no: 1, abstain: 0 });
    expect(r.breakdown.byClass.streamer).toEqual({ eligible: 2, yes: 1, no: 1, abstain: 0 });
    expect(r.breakdown.byClass.viewer).toEqual({ eligible: 3, yes: 1, no: 1, abstain: 0 });
    expect(r.breakdown.byClass.worker).toEqual({ eligible: 0, yes: 0, no: 0, abstain: 0 });
  });

  test("checks report every applicable rule; the reason is the first failure", () => {
    const r = tally(protectedRules, people(10, 10), []);
    expect(r.breakdown.checks.map((c) => [c.rule, c.passed])).toEqual([
      ["member_wide_quorum", false],
      ["member_wide_threshold", false],
      ["streamer_class_quorum", false],
      ["streamer_class_majority", false],
    ]);
    expect(r.reason).toBe("member-wide quorum not met");
    expect(tally(ordinaryRules, people(1, 0), []).breakdown.checks).toHaveLength(2);
  });

  test("the breakdown validates against the shared TallyBreakdown schema", () => {
    const r = tally(protectedRules, people(3, 3, 1), ballots("v", ["yes", "no", "abstain"]));
    expect(() => TallyBreakdown.parse(r.breakdown)).not.toThrow();
    expect(r.breakdown.checks[0]?.detail).toMatch(/turnout 3\/7/);
  });
});

describe("joins, timing and malformed rules", () => {
  test("votes from outside the electorate are ignored", () => {
    const votes = [{ userId: "stranger", choice: "yes" as const }, ...ballots("v", ["no"])];
    const r = tally(ordinaryRules, people(1, 0), votes);
    expect(r.breakdown.memberWide).toEqual({ eligible: 1, yes: 0, no: 1, abstain: 0 });
  });

  test("votes cast after the voting window are ignored; the latest valid one counts", () => {
    const end = new Date("2026-01-02T00:00:00Z");
    const votes: Ballot[] = [
      { userId: "v0", choice: "yes", castAt: new Date("2026-01-01T00:00:00Z") },
      { userId: "v0", choice: "no", castAt: new Date("2026-01-01T12:00:00Z") },
      { userId: "v0", choice: "abstain", castAt: new Date("2026-01-03T00:00:00Z") },
    ];
    const counts = countVotes(people(1, 0), votes, end);
    expect(counts.memberWide).toEqual({ eligible: 1, yes: 0, no: 1, abstain: 0 });
  });

  test("duplicate electorate rows count once", () => {
    const e = [...people(1, 0), ...people(1, 0)];
    expect(countVotes(e, []).memberWide.eligible).toBe(1);
  });

  test("timeline reasons come before the counts, in SQL order", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(tally(protectedRules, [], [], { votingEndsAt: null }).reason).toBe("voting never opened");
    expect(tally(null, [], [], { votingEndsAt: null }).reason).toBe("voting never opened");
    expect(tally({ protected: "yes" }, [], [], { votingEndsAt: now, now }).reason).toBe("malformed rules");
    const future = new Date(now.getTime() + 1000);
    expect(tally(protectedRules, [], [], { votingEndsAt: future, now }).reason).toBe("voting has not ended");
    expect(tally({}, [], [], { votingEndsAt: future, now }).reason).toBe("malformed rules");
  });

  test("rulesWellFormed requires typed values", () => {
    expect(rulesWellFormed(protectedRules)).toBe(true);
    expect(rulesWellFormed([])).toBe(false);
    expect(rulesWellFormed({ ...protectedRules, quorum: "0.2" })).toBe(false);
    expect(rulesWellFormed({ ...protectedRules, councilReviewRequired: undefined })).toBe(false);
    const { streamerClassQuorum: _, ...missing } = protectedRules;
    expect(rulesWellFormed(missing)).toBe(false);
    expect(tally(missing, people(3, 3), [])).toMatchObject({ passed: false, reason: "malformed rules" });
  });
});
