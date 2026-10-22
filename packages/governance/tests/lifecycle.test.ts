// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers of the proposal lifecycle, council reseating and voluntary exits. */
import { describe, expect, test } from "vite-plus/test";
import { councilVacancies, newTermWindow, reseatReason } from "../src/council.ts";
import { decisionRule, nextStep, votingSeconds, type ProposalClock } from "../src/lifecycle.ts";
import { exitRespected, exitWindowDays } from "../src/membership.ts";
import { pgCode } from "../src/outbox.ts";
import type { ProposalStatus } from "../src/rules.ts";
import { TALLY_REASONS, TALLY_RULES, type TallyReason } from "../src/tally.ts";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

const clock = (o: Partial<ProposalClock> & { status: ProposalStatus }): ProposalClock => ({
  affectsCreators: false,
  discussionEndsAt: null,
  councilReviewEndsAt: null,
  votingEndsAt: null,
  ...o,
});

describe("nextStep", () => {
  test("discussion moves on only once its end has strictly passed", () => {
    expect(nextStep(clock({ status: "discussion", discussionEndsAt: at(1) }), NOW)).toBeNull();
    expect(nextStep(clock({ status: "discussion", discussionEndsAt: NOW }), NOW)).toBeNull();
    expect(nextStep(clock({ status: "discussion", discussionEndsAt: at(-1) }), NOW)).toBe("voting");
    expect(nextStep(clock({ status: "discussion", discussionEndsAt: null }), NOW)).toBeNull();
  });

  test("creator-affecting proposals go to council review, the rest straight to voting", () => {
    const p = { status: "discussion" as const, discussionEndsAt: at(-1000) };
    expect(nextStep(clock({ ...p, affectsCreators: true }), NOW)).toBe("council_review");
    expect(nextStep(clock({ ...p, affectsCreators: false }), NOW)).toBe("voting");
  });

  test("council review opens voting when it ends, whether or not the council responded", () => {
    expect(nextStep(clock({ status: "council_review", councilReviewEndsAt: at(5) }), NOW)).toBeNull();
    expect(nextStep(clock({ status: "council_review", councilReviewEndsAt: NOW }), NOW)).toBeNull();
    expect(nextStep(clock({ status: "council_review", councilReviewEndsAt: at(-5) }), NOW)).toBe("voting");
  });

  test("voting is decided only after voting_ends_at; passed is applied", () => {
    expect(nextStep(clock({ status: "voting", votingEndsAt: NOW }), NOW)).toBeNull();
    expect(nextStep(clock({ status: "voting", votingEndsAt: at(-1) }), NOW)).toBe("decide");
    expect(nextStep(clock({ status: "voting", votingEndsAt: null }), NOW)).toBeNull();
    expect(nextStep(clock({ status: "passed" }), NOW)).toBe("apply");
  });

  test("terminal and pre-submit states have no step", () => {
    for (const status of ["draft", "rejected", "withdrawn", "applied"] as const) {
      expect(nextStep(clock({ status, discussionEndsAt: at(-1), votingEndsAt: at(-1) }), NOW)).toBeNull();
    }
  });
});

describe("votingSeconds", () => {
  const settings = (votingSeconds: number, ordinaryMin: number, protectedMin: number) => ({
    "governance.ordinary": {
      threshold: 0.5,
      quorum: 0.1,
      discussionSeconds: 30,
      minVotingSeconds: ordinaryMin,
      votingSeconds,
    },
    "governance.protections": {
      protectedKeys: ["governance.protections"],
      memberWideThreshold: 2 / 3,
      streamerClassThreshold: 0.5,
      quorum: 0.2,
      streamerClassQuorum: 0.2,
      councilReviewSeconds: 30,
      minVotingSeconds: protectedMin,
    },
  });

  test("ordinary proposals use governance.ordinary.votingSeconds", () => {
    expect(votingSeconds("ordinary", settings(45, 45, 600))).toBe(45);
    expect(votingSeconds("ordinary", settings(120, 45, 600))).toBe(120);
  });

  test("protected proposals are raised to governance.protections.minVotingSeconds", () => {
    expect(votingSeconds("protected", settings(45, 45, 600))).toBe(600);
    expect(votingSeconds("protected", settings(900, 45, 600))).toBe(900);
    expect(votingSeconds("protected", settings(45, 45, 45))).toBe(45);
  });

  test("a malformed setting fails loudly", () => {
    expect(() => votingSeconds("ordinary", {})).toThrow(/governance.ordinary/);
  });
});

describe("decisionRule", () => {
  test("names the failing TALLY_RULES id for every rule failure, and passed when passed", () => {
    const expected: Partial<Record<TallyReason, string>> = {
      passed: "passed",
      "member-wide quorum not met": "member_wide_quorum",
      "member-wide threshold not met": "member_wide_threshold",
      "streamer-class quorum not met": "streamer_class_quorum",
      "streamer-class majority not met": "streamer_class_majority",
    };
    for (const [reason, rule] of Object.entries(expected)) {
      expect(decisionRule({ reason: reason as TallyReason })).toBe(rule);
    }
    // Every rule is reachable from exactly one reason.
    const rules = TALLY_REASONS.map((r) => decisionRule({ reason: r })).filter((r) =>
      (TALLY_RULES as readonly string[]).includes(r),
    );
    expect(rules.toSorted()).toEqual([...TALLY_RULES].sort());
  });

  test("timeline and snapshot reasons map to their pseudo-rules", () => {
    expect(decisionRule({ reason: "voting never opened" })).toBe("timeline");
    expect(decisionRule({ reason: "voting has not ended" })).toBe("timeline");
    expect(decisionRule({ reason: "proposal not found" })).toBe("timeline");
    expect(decisionRule({ reason: "malformed rules" })).toBe("snapshot");
  });
});

describe("council reseating", () => {
  const active = new Set(["a", "b", "c"]);

  test("vacancies are seated members who are no longer active streamer members", () => {
    expect(councilVacancies(["a", "b"], active)).toEqual([]);
    expect(councilVacancies(["a", "x", "b", "y"], active)).toEqual(["x", "y"]);
    expect(councilVacancies([], active)).toEqual([]);
  });

  test("a new term is due with no current term, a new UTC month, or a vacancy", () => {
    expect(reseatReason(null, NOW, active)).toBe("no_term");
    const june = new Date("2026-06-01T00:00:00Z");
    expect(reseatReason({ startsAt: june, seated: ["a", "b"] }, NOW, active)).toBeNull();
    expect(reseatReason({ startsAt: june, seated: [] }, NOW, active)).toBeNull();
    expect(reseatReason({ startsAt: june, seated: ["a", "gone"] }, NOW, active)).toBe("vacancy");
    // Month change wins over a vacancy (both reseat; the reason names the first cause).
    const may = new Date("2026-05-31T23:59:59Z");
    expect(reseatReason({ startsAt: may, seated: ["a", "gone"] }, NOW, active)).toBe("month_changed");
    // Same month number, another year.
    expect(reseatReason({ startsAt: new Date("2025-06-20T00:00:00Z"), seated: [] }, NOW, active)).toBe("month_changed");
  });

  test("a term seated now starts now and ends at the end of the UTC month", () => {
    expect(newTermWindow(NOW)).toEqual({ startsAt: NOW, endsAt: new Date("2026-07-01T00:00:00Z") });
    const lastInstant = new Date("2026-12-31T23:59:59.999Z");
    expect(newTermWindow(lastInstant)).toEqual({ startsAt: lastInstant, endsAt: new Date("2027-01-01T00:00:00Z") });
  });
});

describe("voluntary exits", () => {
  const rules = { streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2, lapseGraceDays: 14 } };
  const DAY = 86_400_000;

  test("the exit window is the membership window", () => {
    expect(exitWindowDays(rules)).toBe(90);
  });

  test("an exit inside the window is respected; an older exit or a lapse is not", () => {
    const row = (status: string, exitedDaysAgo: number | null) => ({
      status,
      exitedAt: exitedDaysAgo === null ? null : new Date(NOW.getTime() - exitedDaysAgo * DAY),
      createdAt: new Date(NOW.getTime() - 200 * DAY),
    });
    expect(exitRespected(row("exited", 1), NOW, 90)).toBe(true);
    expect(exitRespected(row("exited", 89), NOW, 90)).toBe(true);
    expect(exitRespected(row("exited", 90), NOW, 90)).toBe(false);
    expect(exitRespected(row("exited", 120), NOW, 90)).toBe(false);
    expect(exitRespected(row("lapsed", 1), NOW, 90)).toBe(false);
    expect(exitRespected(row("active", 1), NOW, 90)).toBe(false);
    expect(exitRespected(undefined, NOW, 90)).toBe(false);
    // Without exitedAt, the exit counts from the row's creation.
    expect(exitRespected(row("exited", null), NOW, 90)).toBe(false);
    expect(exitRespected({ status: "exited", exitedAt: null, createdAt: NOW }, NOW, 90)).toBe(true);
  });
});

describe("pgCode", () => {
  test("finds the SQLSTATE on the error or its causes", () => {
    expect(pgCode({ code: "42501" })).toBe("42501");
    expect(pgCode(Object.assign(new Error("wrapped"), { cause: { code: "23514" } }))).toBe("23514");
    expect(pgCode(new Error("plain"))).toBeUndefined();
    expect(pgCode({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(pgCode(null)).toBeUndefined();
  });
});
