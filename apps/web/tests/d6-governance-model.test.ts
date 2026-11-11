// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d6-governance: the pure decisions behind readable votes, next steps and council shares. */
import { describe, expect, it } from "vite-plus/test";
import {
  COUNCIL_GRID,
  checkThreshold,
  contributionShare,
  decidingBar,
  electionsInOrder,
  excerpt,
  hasOpenElection,
  nextStep,
  resultBars,
  seatingFacts,
  turnout,
  voteRule,
} from "../src/components/governance/model.ts";
import type { CouncilDto, ElectionDto } from "../src/lib/coop.ts";
import { NOW, council, elections, proposal, rejectedProtected, votingProposal } from "./coop-fixtures.ts";

const settings = [
  { key: "governance.ordinary", value: { threshold: 0.5, quorum: 0.1 } },
  {
    key: "governance.protections",
    value: { memberWideThreshold: 2 / 3, streamerClassThreshold: 0.5, quorum: 0.2, streamerClassQuorum: 0.25 },
  },
];

describe("voteRule", () => {
  it("reads the ordinary and protected rules", () => {
    expect(voteRule("ordinary", settings)).toEqual({
      quorum: 0.1,
      threshold: 0.5,
      streamerQuorum: null,
      streamerThreshold: null,
    });
    expect(voteRule("protected", settings)).toEqual({
      quorum: 0.2,
      threshold: 2 / 3,
      streamerQuorum: 0.25,
      streamerThreshold: 0.5,
    });
  });

  it("null while loading or when the setting is missing or malformed", () => {
    expect(voteRule("ordinary", null)).toBeNull();
    expect(voteRule("ordinary", [])).toBeNull();
    expect(voteRule("ordinary", [{ key: "governance.ordinary", value: { quorum: "x", threshold: 0.5 } }])).toBeNull();
    expect(voteRule("protected", [{ key: "governance.protections", value: null }])).toBeNull();
    expect(
      voteRule("protected", [{ key: "governance.protections", value: { quorum: 0.2, memberWideThreshold: 0.7 } }]),
    ).toEqual({
      quorum: 0.2,
      threshold: 0.7,
      streamerQuorum: null,
      streamerThreshold: null,
    });
  });
});

describe("checkThreshold", () => {
  it("reads the rule the tally used from its detail", () => {
    expect(checkThreshold("turnout 4/4 (100.00%), at least 20.00% required")).toBe(0.2);
    expect(checkThreshold("yes 3/4 (75.00%), at least 66.67% required")).toBeCloseTo(0.6667);
    expect(checkThreshold("streamer yes 1/2 (50.00%), more than 50.00% required")).toBe(0.5);
    expect(checkThreshold("streamer turnout 2/2 (100.00%)")).toBeNull();
    expect(checkThreshold("")).toBeNull();
  });
});

describe("resultBars", () => {
  it("one bar per check, thresholds from the detail, else the current rule", () => {
    const tally = rejectedProtected().tally!;
    const bars = resultBars(tally, voteRule("protected", settings));
    expect(
      bars.map((b) => [b.rule, b.measure, b.scope, b.value, b.threshold, b.passed, b.numerator, b.denominator]),
    ).toEqual([
      ["member_wide_quorum", "turnout", "member_wide", 1, 0.01, true, 4, 4],
      ["member_wide_threshold", "yes", "member_wide", 0.75, 0.6667, true, 3, 4],
      // No "required" clause in this check's detail: the rule from the settings.
      ["streamer_class_quorum", "turnout", "streamer", 1, 0.25, true, 2, 2],
      ["streamer_class_majority", "yes", "streamer", 0.5, expect.any(Number), false, 1, 2],
    ]);
    expect(bars[3]?.strict).toBe(true);
    expect(resultBars(tally, null)[2]?.threshold).toBeNull();
  });

  it("an unknown rule is left out; nobody eligible reads 0", () => {
    const tally = {
      passed: false,
      reason: "x",
      breakdown: {
        memberWide: { eligible: 0, yes: 0, no: 0, abstain: 0 },
        byClass: {},
        checks: [
          { rule: "member_wide_quorum", passed: false, detail: "" },
          { rule: "something_new", passed: true, detail: "" },
          { rule: "streamer_class_majority", passed: false, detail: "" },
        ],
      },
    };
    const bars = resultBars(tally as never, null);
    expect(bars.map((b) => [b.rule, b.value, b.denominator])).toEqual([
      ["member_wide_quorum", 0, 0],
      ["streamer_class_majority", 0, 0],
    ]);
    expect(turnout(1, 0)).toBe(0);
    expect(turnout(1, 4)).toBe(0.25);
  });

  it("the deciding rule: the first failed check, else the yes threshold", () => {
    const bars = resultBars(rejectedProtected().tally!, null);
    expect(decidingBar(bars, false)?.rule).toBe("streamer_class_majority");
    expect(decidingBar(bars, true)?.rule).toBe("member_wide_threshold");
    expect(decidingBar([], true)).toBeNull();
    expect(decidingBar(bars.slice(0, 1), true)?.rule).toBe("member_wide_quorum");
  });
});

describe("nextStep", () => {
  it("names the step and its deadline for every status", () => {
    const tl = votingProposal().timeline;
    expect(nextStep(proposal(), NOW)).toEqual({ kind: "draft" });
    expect(nextStep(proposal({ status: "discussion", timeline: tl }), NOW)).toEqual({
      kind: "discussionEnds",
      at: tl.discussionEndsAt,
    });
    expect(nextStep(proposal({ status: "council_review", timeline: tl }), NOW)).toEqual({
      kind: "councilResponds",
      at: tl.councilReviewEndsAt,
    });
    expect(nextStep(votingProposal(), NOW)).toEqual({ kind: "votingCloses", at: tl.votingEndsAt });
    expect(nextStep(votingProposal(), Date.parse(tl.votingEndsAt!) + 1)).toEqual({ kind: "counting" });
    expect(nextStep(proposal({ status: "voting" }), NOW)).toEqual({ kind: "votingCloses", at: null });
    expect(nextStep(proposal({ status: "passed" }), NOW)).toEqual({ kind: "applying" });
    const decided = rejectedProtected();
    expect(nextStep(decided, NOW)).toEqual({ kind: "rejected", at: decided.timeline.decidedAt });
    expect(nextStep({ ...decided, status: "applied" }, NOW)).toEqual({
      kind: "applied",
      at: decided.timeline.decidedAt,
    });
    expect(
      nextStep(
        { ...decided, status: "applied", timeline: { ...decided.timeline, appliedAt: "2026-10-21T00:00:00.000Z" } },
        NOW,
      ),
    ).toEqual({ kind: "applied", at: "2026-10-21T00:00:00.000Z" });
    expect(nextStep(proposal({ status: "withdrawn" }), NOW)).toEqual({ kind: "withdrawn" });
  });
});

describe("excerpt", () => {
  it("the first non-empty line, cut at a word", () => {
    expect(excerpt("\n\n  First line.  \nSecond")).toBe("First line.");
    expect(excerpt("")).toBe("");
    expect(excerpt("   \n  ")).toBe("");
    const long = `${"word ".repeat(40)}end`;
    const cut = excerpt(long, 50);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut).not.toContain("wor…");
    expect(excerpt("x".repeat(60), 50)).toBe(`${"x".repeat(50)}…`);
  });
});

describe("contributionShare", () => {
  const term = (
    scores: number[],
    weights: unknown = { revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 },
  ) =>
    ({
      members: scores.map((s, i) => ({
        user: { id: `u${i}`, username: `u${i}`, displayName: `U${i}` },
        rank: i + 1,
        contributionScore: s,
      })),
      method: { weights },
    }) as Pick<CouncilDto, "members" | "method">;

  it("the score is a weighted share of the eligible total: divide by the weights' sum", () => {
    expect(contributionShare(0.0347, term([0.0347, 0.02]))).toBeCloseTo(0.0347);
    expect(contributionShare(0.2, term([0.2], { revenue: 0.25, streamingHours: 0.25 }))).toBeCloseTo(0.4);
  });

  it("without readable weights, or a score past the whole, a share of the seated scores", () => {
    expect(contributionShare(41.5, council)).toBeCloseTo(41.5 / 53.5);
    expect(contributionShare(1, term([1, 3], null))).toBe(0.25);
    expect(contributionShare(1, term([1, 3], { revenue: "x" }))).toBe(0.25);
  });

  it("null for nothing to divide by or a bad score", () => {
    expect(contributionShare(0, term([0, 0], null))).toBeNull();
    expect(contributionShare(Number.NaN, council)).toBeNull();
    expect(contributionShare(-1, council)).toBeNull();
    expect(contributionShare(1, null)).toBeNull();
  });
});

describe("seatingFacts", () => {
  it("reads the term's method, the legacy windowDays too, each part null when unreadable", () => {
    expect(
      seatingFacts({
        size: 7,
        eligibilityWindowDays: 90,
        minStreamingHours: 10,
        weights: { revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 },
        eligible: 12,
        candidates: 40,
      }),
    ).toEqual({
      size: 7,
      windowDays: 90,
      minHours: 10,
      weights: { revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 },
      eligible: 12,
      candidates: 40,
    });
    expect(seatingFacts(council.method)).toEqual({
      size: 7,
      windowDays: 30,
      minHours: null,
      weights: null,
      eligible: 2,
      candidates: null,
    });
    expect(seatingFacts(null)).toMatchObject({ size: null, weights: null });
    expect(seatingFacts({ size: "7" })).toMatchObject({ size: null });
  });
});

describe("elections", () => {
  const e = (id: string, status: ElectionDto["status"], close: string, end: string): ElectionDto => ({
    ...elections[0]!,
    id,
    status,
    nominationsCloseAt: close,
    votingEndsAt: end,
  });

  it("open ones first by the deadline that matters now, then closed ones as listed", () => {
    const list = [
      e("closed", "closed", "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z"),
      e("voting", "voting", "2026-10-01T00:00:00Z", "2026-10-25T00:00:00Z"),
      e("nominating", "nominating", "2026-10-22T00:00:00Z", "2026-11-30T00:00:00Z"),
    ];
    expect(electionsInOrder(list).map((x) => x.id)).toEqual(["nominating", "voting", "closed"]);
    expect(hasOpenElection(list)).toBe(true);
    expect(hasOpenElection([list[0]!])).toBe(false);
    expect(hasOpenElection(null)).toBe(false);
    expect(COUNCIL_GRID).toBe(12);
  });
});
