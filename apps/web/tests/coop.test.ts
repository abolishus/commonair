// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PROPOSAL_STATUSES } from "@commonair/contracts/enums";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import {
  activeClasses,
  appointError,
  authorActions,
  canBuyShare,
  changeKeyOptions,
  changesFromRows,
  changesOnItsOwn,
  defaultRunWindow,
  deriveKind,
  draftFromProposal,
  editableBy,
  errorReason,
  errorRequirement,
  exitRefundsShare,
  governanceOutcomes,
  isAdmin,
  isDecided,
  isMember,
  isOpenProposal,
  isSecondApproverRefusal,
  membersByClass,
  parseProposalFilter,
  patronageMonths,
  proposalFilterOptions,
  proposalInput,
  proposalSaveError,
  proposalTimeline,
  rowError,
  runWindow,
  settingJson,
  shareRules,
  statementInputAttrs,
  tallyReasonText,
  tallyRows,
  tallyRuleLabel,
  utcFromLocalInput,
  voteRefusal,
  votingOpen,
} from "../src/lib/coop.ts";
import {
  ME,
  NOW,
  OTHER,
  membershipView,
  month,
  proposal,
  rejectedProtected,
  settings,
  statement,
  usd,
  votingProposal,
} from "./coop-fixtures.ts";

const refusal = (code: string, data?: Record<string, unknown>) => Object.assign(new Error(code), { code, data });

describe("membership", () => {
  it("active classes in contract order; member only with one", () => {
    expect(activeClasses(membershipView())).toEqual(["streamer", "viewer"]);
    expect(activeClasses(null)).toEqual([]);
    expect(isMember(membershipView({ memberships: [] }))).toBe(false);
    expect(isMember(membershipView())).toBe(true);
  });

  it("offers the share only when the API would accept it", () => {
    const none = membershipView({ memberships: [], share: null });
    expect(canBuyShare(none)).toBe(true);
    for (const status of ["pending", "held", "refund_pending"] as const)
      expect(canBuyShare({ ...none, share: { id: "s", status, amount: usd(2500) } }), status).toBe(false);
    for (const status of ["refunded", "cancelled"] as const)
      expect(canBuyShare({ ...none, share: { id: "s", status, amount: usd(2500) } }), status).toBe(true);
    // An active viewer membership (by subscription, say) already makes the user a viewer member.
    expect(
      canBuyShare({
        memberships: [{ id: "m", class: "viewer", status: "active", basis: "subscription", joinedAt: "x" }],
        share: null,
      }),
    ).toBe(false);
    expect(
      canBuyShare({
        memberships: [{ id: "m", class: "viewer", status: "exited", basis: "share", joinedAt: "x" }],
        share: null,
      }),
    ).toBe(true);
  });

  it("reads the share price and the refund rule from membership.classes", () => {
    expect(shareRules(settings)).toEqual({ shareCents: 2500, refundableOnExit: true });
    expect(shareRules(null)).toBeNull();
    expect(shareRules([{ key: "membership.classes", value: { viewer: { shareCents: "x" } } }])).toBeNull();
  });

  it("an exit refunds only a held share in the viewer class when the rule says so", () => {
    const view = membershipView();
    expect(exitRefundsShare(view, "viewer", true)).toBe(true);
    expect(exitRefundsShare(view, "viewer", false)).toBe(false);
    expect(exitRefundsShare(view, "viewer", null)).toBe(false);
    expect(exitRefundsShare(view, "streamer", true)).toBe(false);
    expect(exitRefundsShare({ share: { id: "s", status: "pending", amount: usd(1) } }, "viewer", true)).toBe(false);
  });

  it("members by class from the newest month, zeros without one", () => {
    expect(
      membersByClass([month("2026-10"), month("2026-09", { members: { streamer: 9, viewer: 9, worker: 9 } })]),
    ).toEqual({ streamer: 2, viewer: 1, worker: 1 });
    expect(membersByClass(null)).toEqual({ streamer: 0, viewer: 0, worker: 0 });
    expect(membersByClass([])).toEqual({ streamer: 0, viewer: 0, worker: 0 });
  });

  it("admin is the platform role only", () => {
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin({ role: "treasurer" })).toBe(false);
    expect(isAdmin({ role: "moderator" })).toBe(false);
    expect(isAdmin({ role: "admin" })).toBe(true);
  });
});

describe("proposals", () => {
  it("open, decided and self-moving statuses", () => {
    expect(PROPOSAL_STATUSES.filter(isOpenProposal)).toEqual(["discussion", "council_review", "voting"]);
    expect(PROPOSAL_STATUSES.filter(isDecided)).toEqual(["passed", "rejected", "applied"]);
    expect(PROPOSAL_STATUSES.filter(changesOnItsOwn)).toEqual(["discussion", "council_review", "voting", "passed"]);
  });

  it.each([
    ["draft", { submit: true, edit: true, withdraw: true }],
    ["discussion", { submit: false, edit: true, withdraw: true }],
    ["council_review", { submit: false, edit: false, withdraw: true }],
    ["voting", { submit: false, edit: false, withdraw: false }],
    ["passed", { submit: false, edit: false, withdraw: false }],
    ["withdrawn", { submit: false, edit: false, withdraw: false }],
  ] as const)("the author in %s may %o", (status, expected) => {
    expect(authorActions(proposal({ status }), ME)).toEqual(expected);
    expect(editableBy(proposal({ status }), ME)).toBe(expected.edit);
  });

  it("nobody else (signed out included) gets author actions", () => {
    const none = { submit: false, edit: false, withdraw: false };
    expect(authorActions(proposal(), OTHER)).toEqual(none);
    expect(authorActions(proposal(), null)).toEqual(none);
    expect(editableBy(proposal(), OTHER)).toBe(false);
  });

  it("the ballot is open only while voting and before votingEndsAt", () => {
    const p = votingProposal();
    const ends = Date.parse(p.timeline.votingEndsAt ?? "");
    expect(votingOpen(p, NOW)).toBe(true);
    expect(votingOpen(p, ends - 1)).toBe(true);
    expect(votingOpen(p, ends)).toBe(false);
    expect(votingOpen({ ...p, status: "passed" }, NOW)).toBe(false);
    expect(votingOpen({ ...p, timeline: { ...p.timeline, votingEndsAt: null } }, NOW)).toBe(true);
  });

  it("filter options: all, then every status, each with its test id", () => {
    const options = proposalFilterOptions();
    expect(options.map((o) => o.value)).toEqual(["all", ...PROPOSAL_STATUSES]);
    expect(options.map((o) => o["data-testid"])).toContain("proposals-filter-council_review");
    expect(parseProposalFilter("voting")).toBe("voting");
    expect(parseProposalFilter("all")).toBe("all");
    expect(parseProposalFilter("nope")).toBeNull();
  });
});

describe("timeline", () => {
  const states = (p: Parameters<typeof proposalTimeline>[0]) =>
    proposalTimeline(p).map((s) => [s.id, s.state] as const);

  it("skips council review for proposals that do not affect creators", () => {
    expect(states(proposal({ affectsCreators: false, status: "discussion" }))).toEqual([
      ["draft", "done"],
      ["discussion", "current"],
      ["voting", "upcoming"],
    ]);
  });

  it("dates each reached step by when it began, empty when unknown or upcoming", () => {
    const p = votingProposal();
    const steps = proposalTimeline(p);
    expect(steps.map((s) => s.at)).toEqual([p.createdAt, "", p.timeline.discussionEndsAt, p.timeline.votingStartsAt]);
    expect(steps.find((s) => s.id === "voting")?.until).toBe(p.timeline.votingEndsAt);
  });

  it("decided: rejected is the last step; passed waits for applied", () => {
    expect(states(rejectedProtected()).at(-1)).toEqual(["rejected", "done"]);
    expect(states({ ...rejectedProtected(), status: "passed" }).slice(-2)).toEqual([
      ["passed", "current"],
      ["applied", "upcoming"],
    ]);
    expect(states({ ...rejectedProtected(), status: "applied" }).slice(-2)).toEqual([
      ["passed", "done"],
      ["applied", "done"],
    ]);
    expect(proposalTimeline({ ...rejectedProtected(), status: "applied" }).every((s) => s.state === "done")).toBe(true);
  });

  it("withdrawn: only the steps it reached, then withdrawn", () => {
    expect(states(proposal({ status: "withdrawn" }))).toEqual([
      ["draft", "done"],
      ["withdrawn", "done"],
    ]);
    const inReview = proposal({
      status: "withdrawn",
      timeline: { ...proposal().timeline, discussionEndsAt: "a", councilReviewEndsAt: "b" },
    });
    expect(states(inReview).map(([id]) => id)).toEqual(["draft", "discussion", "council_review", "withdrawn"]);
  });
});

describe("the change editor", () => {
  it("offers every key with its protected flag and test id", () => {
    expect(changeKeyOptions(settings).map((o) => [o.value, o.protected, o["data-testid"]])).toEqual([
      ["discovery.ranking", false, "proposal-change-key-discovery.ranking"],
      ["platform.cut", true, "proposal-change-key-platform.cut"],
      ["membership.classes", true, "proposal-change-key-membership.classes"],
    ]);
  });

  it("derives protected from any protected key", () => {
    expect(deriveKind([], settings)).toBe("ordinary");
    expect(deriveKind([{ key: "discovery.ranking" }, { key: "" }], settings)).toBe("ordinary");
    expect(deriveKind([{ key: "discovery.ranking" }, { key: "platform.cut" }], settings)).toBe("protected");
  });

  it("starts a key from its whole current value", () => {
    expect(JSON.parse(settingJson(settings, "discovery.ranking"))).toEqual({
      spotlightSlots: 4,
      newChannelBoostDays: 14,
    });
    expect(settingJson(settings, "nope")).toBe("");
  });

  it("names each row's problem; changes only when every row is fine", () => {
    const rows = [
      { id: "a", key: "discovery.ranking", value: '{"spotlightSlots":5}' },
      { id: "b", key: "discovery.ranking", value: "{}" },
      { id: "c", key: "", value: "" },
      { id: "d", key: "platform.cut", value: "{oops" },
    ];
    expect(rows.map((r) => rowError(r, rows))).toEqual([null, "duplicate", "noKey", "invalidJson"]);
    expect(changesFromRows(rows)).toBeNull();
    expect(changesFromRows([rows[0] as (typeof rows)[number]])).toEqual([
      { key: "discovery.ranking", value: { spotlightSlots: 5 } },
    ]);
    expect(changesFromRows([])).toEqual([]);
  });

  it("the input trims, bounds the title and forces affectsCreators for protected", () => {
    const draft = { title: "  A good title  ", body: " Body ", affectsCreators: false, rows: [] };
    expect(proposalInput(draft, "ordinary")).toEqual({
      title: "A good title",
      body: "Body",
      changes: [],
      affectsCreators: false,
    });
    expect(proposalInput(draft, "protected")?.affectsCreators).toBe(true);
    expect(proposalInput({ ...draft, title: "Shrt" }, "ordinary")).toBeNull();
    expect(proposalInput({ ...draft, title: "x".repeat(141) }, "ordinary")).toBeNull();
    expect(proposalInput({ ...draft, body: "   " }, "ordinary")).toBeNull();
  });

  it("an edit starts from the saved proposal", () => {
    const d = draftFromProposal(proposal());
    expect(d.title).toBe("Five spotlight slots");
    expect(d.rows.map((r) => [r.key, JSON.parse(r.value)])).toEqual([["discovery.ranking", { spotlightSlots: 5 }]]);
  });
});

describe("tally", () => {
  it("member-wide first, then every class", () => {
    const tally = rejectedProtected().tally;
    if (!tally) throw new Error("fixture");
    expect(tallyRows(tally.breakdown).map((r) => [r.scope, r.yes, r.no, r.abstain, r.eligible])).toEqual([
      ["member_wide", 3, 1, 0, 4],
      ["streamer", 1, 1, 0, 2],
      ["viewer", 1, 0, 0, 1],
      ["worker", 1, 0, 0, 1],
    ]);
    const noWorker = { ...tally.breakdown, byClass: { streamer: tally.breakdown.byClass.streamer } };
    expect(tallyRows(noWorker as typeof tally.breakdown).at(-1)).toMatchObject({ scope: "worker", eligible: 0 });
  });

  it("reasons and rules in words; unknown ones as given", () => {
    expect(tallyReasonText("streamer-class majority not met")).toBe(en["coop.tally.reason.streamerClassMajority"]);
    expect(tallyReasonText("passed")).toBe(en["coop.tally.reason.passed"]);
    expect(tallyReasonText("something new")).toBe("something new");
    expect(tallyRuleLabel("streamer_class_quorum")).toBe(en["coop.tally.rule.streamer_class_quorum"]);
    expect(tallyRuleLabel("other_rule")).toBe("other_rule");
  });
});

describe("refusals", () => {
  it("reads data.reason and data.requirement", () => {
    expect(errorReason(refusal("CONFLICT", { reason: "voting_closed" }))).toBe("voting_closed");
    expect(errorReason(new Error("x"))).toBeNull();
    expect(errorReason(null)).toBeNull();
    expect(errorRequirement(refusal("PRECONDITION_FAILED", { requirement: "membership" }))).toBe("membership");
    expect(errorRequirement(refusal("PRECONDITION_FAILED", { requirement: 3 }))).toBeNull();
  });

  it("vote refusals by code and reason", () => {
    expect(voteRefusal(refusal("CONFLICT", { reason: "voting_closed" }))).toBe("voting_closed");
    expect(voteRefusal(refusal("FORBIDDEN", { reason: "not_in_electorate" }))).toBe("not_in_electorate");
    expect(voteRefusal(refusal("CONFLICT"))).toBeNull();
    expect(voteRefusal(refusal("FORBIDDEN", { reason: "voting_closed" }))).toBeNull();
  });

  it("the second-approver refusal", () => {
    expect(isSecondApproverRefusal(refusal("FORBIDDEN", { reason: "second_approver" }))).toBe(true);
    expect(isSecondApproverRefusal(refusal("FORBIDDEN"))).toBe(false);
  });

  it("proposal save and appointment refusals in words", () => {
    expect(proposalSaveError(refusal("PRECONDITION_FAILED", { requirement: "membership" }))).toBe(
      en["coop.form.notMember"],
    );
    expect(proposalSaveError(refusal("BAD_REQUEST"))).toBe(en["coop.form.invalid"]);
    expect(proposalSaveError(refusal("CONFLICT"))).toBe(en["coop.form.notEditable"]);
    expect(proposalSaveError(new Error("network"))).toBe(en["coop.form.failed"]);
    expect(appointError(refusal("NOT_FOUND"))).toBe(en["coop.admin.noUser"]);
    expect(appointError(refusal("PRECONDITION_FAILED", { requirement: "account_active" }))).toBe(
      en["coop.admin.suspended"],
    );
    expect(appointError(refusal("CONFLICT"))).toBe(en["coop.admin.alreadyWorker"]);
    expect(appointError(refusal("BAD_REQUEST"))).toBe(en["coop.admin.invalid"]);
    expect(appointError(refusal("INTERNAL_SERVER_ERROR"))).toBe(en["coop.admin.failed"]);
  });
});

describe("patronage", () => {
  it("reads datetime-local text as UTC", () => {
    expect(utcFromLocalInput("2026-10-01T00:00")).toBe("2026-10-01T00:00:00.000Z");
    expect(utcFromLocalInput("2026-10-20T23:59:30")).toBe("2026-10-20T23:59:30.000Z");
    expect(utcFromLocalInput("2026-02-30T00:00")).toBeNull();
    expect(utcFromLocalInput("")).toBeNull();
    expect(utcFromLocalInput("2026-10-01")).toBeNull();
  });

  it("defaults to the start of the UTC month until now", () => {
    expect(defaultRunWindow(Date.parse("2026-10-20T12:34:56.789Z"))).toEqual({
      start: "2026-10-01T00:00:00",
      end: "2026-10-20T12:34:56",
    });
  });

  it("refuses what the API would: a future end, start not before end, bad text", () => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    expect(runWindow("2026-10-01T00:00", "2026-10-20T11:59", now)).toEqual({
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-10-20T11:59:00.000Z",
    });
    expect(runWindow("2026-10-01T00:00", "2026-10-20T12:00", now)).toMatchObject({
      periodEnd: "2026-10-20T12:00:00.000Z",
    });
    expect(runWindow("2026-10-01T00:00", "2026-10-20T12:01", now)).toEqual({ error: "endInFuture" });
    expect(runWindow("2026-10-20T11:00", "2026-10-20T11:00", now)).toEqual({ error: "endBeforeStart" });
    expect(runWindow("x", "2026-10-20T11:00", now)).toEqual({ error: "invalidTimes" });
  });

  it("statement inputs as the spec's data attributes", () => {
    expect(statementInputAttrs(statement.inputs)).toEqual({
      "data-revenue-cents": 1000,
      "data-hours": 2,
      "data-relay-bytes": 0,
      "data-viewer-hours": 7.5,
    });
  });

  it("transparency: patronage only for months that distributed; outcomes with their month", () => {
    const months = [
      month("2026-10", {
        patronageDistributed: usd(9000),
        governance: [
          {
            proposalId: "p",
            title: "t",
            status: "applied",
            kind: "ordinary",
            passed: true,
            reason: "passed",
            decidedAt: null,
          },
        ],
      }),
      month("2026-09"),
    ];
    expect(patronageMonths(months)).toEqual([{ month: "2026-10", cents: 9000, currency: "usd" }]);
    expect(governanceOutcomes(months).map((g) => [g.proposalId, g.month])).toEqual([["p", "2026-10"]]);
  });
});
