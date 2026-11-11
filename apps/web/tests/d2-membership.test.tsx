// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 2 (d2-membership): the public membership pitch (numbers from the co-op's settings,
 * the join CTA), "Your first vote" picked from the real electorate, the ballot's reason for a new
 * member, and the Support dialog's "a {minSub}+ sub makes you a member" line.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  FirstVoteNote,
  NEW_MEMBER_DAYS,
  cannotVoteReason,
  isNewMember,
  opensAt,
  pickFirstVote,
  type FirstVoteChoice,
} from "../src/components/coop/first-vote.tsx";
import {
  JOIN_SIGNUP_HREF,
  MemberVoteCard,
  MembershipPanel,
  MembershipPitch,
  MembershipPitchLead,
  endLine,
  formatShare,
  isMember,
  pitchFacts,
  type PitchFacts,
} from "../src/components/coop/membership.tsx";
import {
  SubMemberNotice,
  subMakesMember,
  subMemberRule,
  subMemberRuleFor,
} from "../src/components/support/member-notice.tsx";
import { SupportForm, type SupportFormProps } from "../src/components/support/support-dialog.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { CoopMonthDto, ProposalDto, SettingDto } from "../src/lib/coop.ts";
import type { CheckoutResult } from "../src/lib/support.ts";
import { resetUiMetricsForTests } from "../src/lib/ui-metrics.ts";
import { membershipView, month, proposal } from "./coop-fixtures.ts";
import { supportInfo } from "./support-fixtures.ts";

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

/** The UI counters sent, as `surface|action|step`. */
let sent: string[] = [];
beforeEach(() => {
  resetUiMetricsForTests();
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string) as { surface: string; action: string; step: string };
      sent.push(`${b.surface}|${b.action}|${b.step}`);
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setting = (key: string, value: unknown): SettingDto => ({
  key,
  value,
  protected: false,
  description: "",
  updatedAt: "2026-10-01T00:00:00.000Z",
  updatedByProposalId: null,
});
/** The seeded co-op (packages/db/src/seed.ts). */
const SEEDED: SettingDto[] = [
  setting("membership.classes", {
    streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2, lapseGraceDays: 14 },
    viewer: {
      shareCents: 500,
      shareRefundableOnExit: true,
      activeSubscriptionQualifies: true,
      minSubscriptionCents: 300,
    },
    worker: { appointedBy: "board" },
  }),
  setting("platform.cut", { streamerShare: 0.9, coopShare: 0.1 }),
  setting("governance.ordinary", {
    threshold: 0.5,
    quorum: 0.1,
    discussionSeconds: 1,
    minVotingSeconds: 1,
    votingSeconds: 1,
  }),
  setting("governance.protections", {
    protectedKeys: ["governance.protections"],
    memberWideThreshold: 2 / 3,
    streamerClassThreshold: 0.5,
    quorum: 0.2,
    streamerClassQuorum: 0.2,
    councilReviewSeconds: 1,
    minVotingSeconds: 1,
  }),
  setting("board.seats", { streamer: 3, viewer: 3, worker: 1, termMonths: 24 }),
];
const facts = pitchFacts(SEEDED) as PitchFacts;

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const timeline = (over: Partial<ProposalDto["timeline"]> = {}): ProposalDto["timeline"] => ({
  discussionEndsAt: null,
  councilReviewEndsAt: null,
  votingStartsAt: null,
  votingEndsAt: null,
  decidedAt: null,
  appliedAt: null,
  ...over,
});
const p = (id: string, over: Partial<ProposalDto>) => proposal({ id, title: `P ${id}`, myVote: null, ...over });

describe("pickFirstVote", () => {
  it("names the open proposal the caller can still vote on, the one closing soonest", () => {
    const choice = pickFirstVote(
      [
        p("late", { status: "voting", canVote: true, timeline: timeline({ votingEndsAt: iso(48) }) }),
        p("frozen", { status: "voting", canVote: false, timeline: timeline({ votingEndsAt: iso(1) }) }),
        p("voted", { status: "voting", canVote: true, myVote: "yes", timeline: timeline({ votingEndsAt: iso(2) }) }),
        p("soon", { status: "voting", canVote: true, timeline: timeline({ votingEndsAt: iso(5) }) }),
        p("past", { status: "voting", canVote: true, timeline: timeline({ votingEndsAt: iso(-1) }) }),
        p("next", { status: "discussion", timeline: timeline({ discussionEndsAt: iso(3) }) }),
      ],
      NOW,
    );
    expect(choice).toMatchObject({ kind: "vote", proposal: { id: "soon" }, closesAt: iso(5), votedBefore: true });
  });

  it("with no ballot open to the caller: the next proposal to open, soonest known date first", () => {
    const choice = pickFirstVote(
      [
        p("frozen", { status: "voting", canVote: false, timeline: timeline({ votingEndsAt: iso(10) }) }),
        p("undated", { status: "discussion", timeline: timeline() }),
        p("later", { status: "discussion", timeline: timeline({ discussionEndsAt: iso(72) }) }),
        p("review", { status: "council_review", timeline: timeline({ councilReviewEndsAt: iso(24) }) }),
      ],
      NOW,
    );
    expect(choice).toEqual({
      kind: "next",
      proposal: expect.objectContaining({ id: "review" }),
      opensAt: iso(24),
      votedBefore: false,
      votedAllOpen: false,
    });
  });

  it("a next proposal without a future date is named without one; nothing open or coming is none", () => {
    expect(
      pickFirstVote([p("old", { status: "discussion", timeline: timeline({ discussionEndsAt: iso(-5) }) })], NOW),
    ).toMatchObject({ kind: "next", proposal: { id: "old" }, opensAt: null });
    const none = { kind: "none", votedBefore: false, votedAllOpen: false };
    expect(pickFirstVote([], NOW)).toEqual(none);
    expect(pickFirstVote([p("done", { status: "passed", canVote: false })], NOW)).toEqual(none);
  });

  it("voted on every ballot open to them: votedAllOpen, with the next proposal when there is one", () => {
    const voted = p("v", {
      status: "voting",
      canVote: true,
      myVote: "yes",
      timeline: timeline({ votingEndsAt: iso(5) }),
    });
    expect(pickFirstVote([voted], NOW)).toEqual({ kind: "none", votedBefore: true, votedAllOpen: true });
    expect(
      pickFirstVote([voted, p("n", { status: "discussion", timeline: timeline({ discussionEndsAt: iso(3) }) })], NOW),
    ).toMatchObject({ kind: "next", proposal: { id: "n" }, votedBefore: true, votedAllOpen: true });
    // A closed-out ballot the caller voted on is history, not an open one.
    const past = p("old", {
      status: "voting",
      canVote: true,
      myVote: "no",
      timeline: timeline({ votingEndsAt: iso(-1) }),
    });
    expect(pickFirstVote([past], NOW)).toEqual({ kind: "none", votedBefore: true, votedAllOpen: false });
  });

  it("opensAt: voting start when known, else the end of the current stage", () => {
    expect(
      opensAt({
        status: "council_review",
        timeline: timeline({ votingStartsAt: iso(1), councilReviewEndsAt: iso(2) }),
      }),
    ).toBe(iso(1));
    expect(opensAt({ status: "council_review", timeline: timeline({ councilReviewEndsAt: iso(2) }) })).toBe(iso(2));
    expect(opensAt({ status: "discussion", timeline: timeline({ discussionEndsAt: iso(3) }) })).toBe(iso(3));
    expect(opensAt({ status: "voting", timeline: timeline({ votingStartsAt: iso(-1) }) })).toBeNull();
  });
});

describe("isNewMember", () => {
  const m = (status: "active" | "exited" | "lapsed", days: number) => ({
    status,
    joinedAt: new Date(NOW - days * 86_400_000).toISOString(),
  });
  it("new while the earliest active membership is within NEW_MEMBER_DAYS", () => {
    expect(isNewMember([m("active", 2)], NOW)).toBe(true);
    expect(isNewMember([m("active", NEW_MEMBER_DAYS)], NOW)).toBe(true);
    expect(isNewMember([m("active", NEW_MEMBER_DAYS + 1)], NOW)).toBe(false);
    // A long-standing member who just gained another class is not new.
    expect(isNewMember([m("active", 400), m("active", 1)], NOW)).toBe(false);
    // An old exit does not age a fresh membership.
    expect(isNewMember([m("exited", 400), m("active", 1)], NOW)).toBe(true);
    expect(isNewMember([m("exited", 1)], NOW)).toBe(false);
    expect(isNewMember([], NOW)).toBe(false);
    expect(isNewMember(null, NOW)).toBe(false);
  });
});

describe("FirstVoteNote and MemberVoteCard", () => {
  const open: FirstVoteChoice = {
    kind: "vote",
    proposal: p("a", { title: "Weekly office hours", status: "voting", canVote: true }),
    closesAt: iso(30),
    votedBefore: false,
  };
  it("vote: 'Your first vote' with the proposal's link and its closing time", () => {
    wrap(<MemberVoteCard choice={open} newMember />);
    const note = screen.getByTestId("first-vote");
    expect(note.dataset.kind).toBe("vote");
    expect(note.textContent).toContain(en["d2Membership.firstVote.open"]);
    expect(note.textContent).toContain(en["d2Membership.firstVote.closes"]);
    expect(screen.getByTestId("first-vote-link").getAttribute("href")).toBe("/coop/proposals/a");
    expect(screen.getByTestId("membership-first-vote").textContent).toContain(en["d2Membership.member.voteTitle"]);
  });
  it("next: votes from now on, the next proposal and when it opens; none: nothing open", () => {
    wrap(
      <FirstVoteNote
        choice={{
          kind: "next",
          proposal: p("b", { title: "Clip length", status: "discussion" }),
          opensAt: iso(48),
          votedBefore: false,
          votedAllOpen: false,
        }}
      />,
    );
    const note = screen.getByTestId("first-vote");
    expect(note.textContent).toContain(en["d2Membership.firstVote.fromNow"]);
    expect(note.textContent).toContain("Clip length");
    expect(note.textContent).toContain(en["d2Membership.firstVote.opens"]);
    cleanup();
    wrap(<FirstVoteNote choice={{ kind: "none", votedBefore: false, votedAllOpen: false }} />);
    expect(screen.getByTestId("first-vote").textContent).toContain(en["d2Membership.firstVote.nothingOpen"]);
    cleanup();
    const { container } = wrap(<MemberVoteCard choice={null} newMember />);
    expect(container.textContent).toBe("");
  });

  it("an established member: 'Open for your vote', never 'first' or 'from now on'", () => {
    wrap(<MemberVoteCard choice={open} newMember={false} />);
    const note = screen.getByTestId("first-vote");
    expect(note.dataset.first).toBe("false");
    expect(note.textContent).toContain(en["d2Membership.firstVote.openForYou"]);
    expect(note.textContent).not.toContain(en["d2Membership.firstVote.open"]);
    cleanup();
    wrap(<MemberVoteCard choice={{ kind: "none", votedBefore: false, votedAllOpen: false }} newMember={false} />);
    const none = screen.getByTestId("first-vote");
    expect(none.textContent).not.toContain(en["d2Membership.firstVote.fromNow"]);
    expect(none.textContent).toContain(en["d2Membership.firstVote.nothingOpen"]);
  });

  it("a new member who already voted is not told 'first'", () => {
    wrap(<MemberVoteCard choice={{ ...open, votedBefore: true }} newMember />);
    expect(screen.getByTestId("first-vote").textContent).toContain(en["d2Membership.firstVote.openForYou"]);
  });

  it("voted on everything open: says so, without the joined-late or nothing-open lines", () => {
    wrap(<MemberVoteCard choice={{ kind: "none", votedBefore: true, votedAllOpen: true }} newMember />);
    const note = screen.getByTestId("first-vote");
    expect(note.textContent).toBe(en["d2Membership.firstVote.votedAll"]);
    cleanup();
    wrap(
      <MemberVoteCard
        choice={{
          kind: "next",
          proposal: p("b", { title: "Clip length", status: "discussion" }),
          opensAt: iso(48),
          votedBefore: true,
          votedAllOpen: true,
        }}
        newMember={false}
      />,
    );
    const next = screen.getByTestId("first-vote");
    expect(next.textContent).toContain(en["d2Membership.firstVote.votedAll"]);
    expect(next.textContent).toContain("Clip length");
    expect(next.textContent).not.toContain(en["d2Membership.firstVote.fromNow"]);
  });
});

describe("cannotVoteReason", () => {
  it("signed out, a member who joined after the vote opened, a non-member, unknown membership", () => {
    expect(cannotVoteReason({ signedIn: false, member: null })).toBe(t("coop.vote.signIn"));
    expect(cannotVoteReason({ signedIn: true, member: true })).toBe(t("d2Membership.vote.joinedAfter"));
    expect(cannotVoteReason({ signedIn: true, member: false })).toBe(t("d2Membership.vote.notMember"));
    expect(cannotVoteReason({ signedIn: true, member: null })).toBe(t("coop.vote.notInElectorate"));
  });
});

describe("pitchFacts", () => {
  it("reads every number from the settings", () => {
    expect(facts).toEqual({
      shareCents: 500,
      refundable: true,
      subQualifies: true,
      minSubCents: 300,
      streamerHours: 10,
      streamerViewers: 2,
      streamerDays: 90,
      creatorShare: 0.9,
      ordinary: { threshold: 0.5, quorum: 0.1 },
      protections: { memberWideThreshold: 2 / 3, streamerClassThreshold: 0.5, quorum: 0.2, streamerClassQuorum: 0.2 },
      seats: { streamer: 3, viewer: 3, worker: 1 },
    });
  });
  it("null without membership.classes; the optional parts drop out alone; defaulted fields default", () => {
    expect(pitchFacts(null)).toBeNull();
    expect(pitchFacts(SEEDED.filter((s) => s.key !== "membership.classes"))).toBeNull();
    const bare = pitchFacts([
      setting("membership.classes", {
        streamer: { minStreamingHours: 4, windowDays: 30 },
        viewer: { shareCents: 1000, shareRefundableOnExit: false, activeSubscriptionQualifies: false },
      }),
      setting("platform.cut", "not a cut"),
    ]);
    expect(bare).toMatchObject({
      streamerViewers: 2,
      minSubCents: 300,
      creatorShare: null,
      ordinary: null,
      protections: null,
      seats: null,
    });
  });
  it("formatShare, isMember and the closing line", () => {
    expect(formatShare(0.9, "en")).toBe("90%");
    expect(formatShare(2 / 3, "en")).toBe("66.7%");
    expect(isMember(null)).toBe(false);
    expect(isMember(membershipView())).toBe(true);
    expect(isMember(membershipView({ memberships: [] }))).toBe(false);
    expect(endLine(facts, "usd", "en")).toBe(t("d2Membership.end.body", { shareAmount: "$5.00", minSub: "$3.00" }));
    expect(endLine({ ...facts, subQualifies: false }, "usd", "en")).toBe(
      t("d2Membership.end.shareOnly", { shareAmount: "$5.00" }),
    );
    expect(endLine({ ...facts, refundable: false }, "usd", "en")).toBe(
      t("d2Membership.end.bodyKept", { shareAmount: "$5.00", minSub: "$3.00" }),
    );
    expect(endLine({ ...facts, refundable: false, subQualifies: false }, "usd", "en")).toBe(
      t("d2Membership.end.shareOnlyKept", { shareAmount: "$5.00" }),
    );
  });
});

const months: CoopMonthDto[] = [
  month("2026-10", {
    members: { streamer: 12, viewer: 200, worker: 3 },
    surplus: { cents: -5000, currency: "usd" },
  }),
];

describe("MembershipPitch (signed out)", () => {
  it("states the share, the sub, the streamer rule and the real vote thresholds, with one join CTA per band", () => {
    wrap(
      <MembershipPitch
        facts={facts}
        currency="usd"
        siteName="CommonAir"
        sourceUrl="https://code.example/commonair"
        months={months}
        signedIn={false}
      />,
    );
    const page = screen.getByTestId("membership-pitch");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(en["d2Membership.pitch.title"]);
    expect(page.textContent).toContain("Creators keep 90% of every sub and tip.");
    expect(screen.getByTestId("membership-pitch-members").textContent).toBe("215");
    expect(screen.getByTestId("membership-way-viewer").textContent).toContain(
      t("d2Membership.way.viewer.share", { shareAmount: "$5.00" }),
    );
    expect(screen.getByTestId("membership-way-viewer").textContent).toContain(
      t("d2Membership.way.viewer.sub", { minSub: "$3.00" }),
    );
    expect(screen.getByTestId("membership-way-streamer").textContent).toContain(
      "Automatic once you've streamed 10 hours to 2 or more verified viewers.",
    );
    expect(screen.getByTestId("membership-pitch-patronage").textContent).toContain(en["d2Membership.patronageNone"]);
    const ctas = screen.getAllByTestId("membership-pitch-cta");
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe(JOIN_SIGNUP_HREF);
      expect(cta.hasAttribute("data-filled-cta")).toBe(true);
    }
    expect(JOIN_SIGNUP_HREF).toBe("/signup?intent=join&redirect=%2Fcoop%2Fmembership");
    expect(page.textContent).toContain(en["d2Membership.faq.vote.q"]);
    expect(sent).toContain("coop.membership|view|none");
    fireEvent.click(ctas[0] as HTMLElement);
    expect(sent).toContain("coop.membership|click|join");
  });

  it("the FAQ's vote rule uses the settings' quorum and thresholds", async () => {
    wrap(
      <MembershipPitch
        facts={facts}
        currency="usd"
        siteName="CommonAir"
        sourceUrl={null}
        months={null}
        signedIn={false}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText(en["d2Membership.faq.vote.q"]));
    });
    await waitFor(() => expect(screen.queryByTestId("membership-faq-vote")).not.toBeNull());
    const vote = screen.getByTestId("membership-faq-vote").textContent ?? "";
    expect(vote).toContain(t("d2Membership.faq.vote.ordinary", { quorum: "10%", threshold: "50%" }));
    expect(vote).toContain(
      t("d2Membership.faq.vote.protected", {
        quorum: "20%",
        threshold: "66.7%",
        streamerQuorum: "20%",
        streamerThreshold: "50%",
      }),
    );
    // Without the months the stats and decisions are left out, not zeros.
    expect(screen.queryByTestId("membership-pitch-members")).toBeNull();
    expect(screen.queryByTestId("membership-pitch-decisions")).toBeNull();
  });

  it("loading settings: a skeleton, no CTA", () => {
    wrap(
      <MembershipPitch
        facts={null}
        currency="usd"
        siteName="CommonAir"
        sourceUrl={null}
        months={null}
        signedIn={false}
      />,
    );
    expect(screen.queryByTestId("membership-pitch-cta")).toBeNull();
  });
});

describe("signed in, not a member", () => {
  it("the hero sits above today's page; its CTA scrolls to the share, and the sub route is offered", () => {
    const view = membershipView({ memberships: [] });
    wrap(
      <MembershipPanel
        view={view}
        rules={{ shareCents: 500, refundableOnExit: true }}
        currency="usd"
        instructions={null}
        buying={false}
        onBuy={() => undefined}
        onExit={async () => undefined}
        onExitError={() => undefined}
        lead={
          <MembershipPitchLead
            facts={facts}
            currency="usd"
            siteName="CommonAir"
            sourceUrl={null}
            months={months}
            signedIn
          />
        }
      />,
    );
    expect(screen.getByTestId("membership")).toBeTruthy();
    expect(screen.getByTestId("membership-share")).toBeTruthy();
    const cta = screen.getByTestId("membership-pitch-cta");
    expect(cta.getAttribute("href")).toBe("#membership-options");
    expect(cta.textContent).toBe(en["d2Membership.pitch.cta.signedIn"]);
    expect(document.getElementById("membership-options")?.contains(screen.getByTestId("membership-share"))).toBe(true);
    expect(screen.getByTestId("membership-pitch-sub").textContent).toContain(
      t("d2Membership.options.subTitle", { minSub: "$3.00" }),
    );
    // The page's h1 stays "Membership"; the pitch headline is an h2 under it.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(en["coop.membership.title"]);
  });
});

describe("Support: the co-op line", () => {
  const rule = subMemberRule(SEEDED);
  it("subMemberRule and subMakesMember", () => {
    expect(rule).toEqual({ qualifies: true, minSubscriptionCents: 300 });
    expect(subMemberRule(null)).toBeNull();
    expect(subMakesMember(rule, 300)).toBe(true);
    expect(subMakesMember(rule, 299)).toBe(false);
    expect(subMakesMember({ qualifies: false, minSubscriptionCents: 0 }, 999)).toBe(false);
    expect(subMakesMember(null, 999)).toBe(false);
  });

  it("subMemberRuleFor: no claim for an active viewer member, a latest exit, or an unread membership", () => {
    const viewer = (status: "active" | "exited" | "lapsed", joinedAt: string, id = "v") => ({
      id,
      class: "viewer" as const,
      status,
      basis: "subscription" as const,
      joinedAt,
    });
    const streamer = membershipView().memberships[0];
    expect(subMemberRuleFor(rule, { memberships: [] })).toEqual(rule);
    expect(subMemberRuleFor(rule, { memberships: [streamer!] })).toEqual(rule);
    expect(subMemberRuleFor(rule, { memberships: [viewer("lapsed", "2026-10-01T00:00:00.000Z")] })).toEqual(rule);
    expect(subMemberRuleFor(rule, { memberships: [viewer("active", "2026-10-01T00:00:00.000Z")] })).toBeNull();
    expect(subMemberRuleFor(rule, { memberships: [viewer("exited", "2026-10-01T00:00:00.000Z")] })).toBeNull();
    // An exit older than a later lapse is history: the latest row decides.
    expect(
      subMemberRuleFor(rule, {
        memberships: [viewer("exited", "2026-01-01T00:00:00.000Z", "a"), viewer("lapsed", "2026-10-01T00:00:00.000Z")],
      }),
    ).toEqual(rule);
    expect(
      subMemberRuleFor(rule, {
        memberships: [viewer("lapsed", "2026-01-01T00:00:00.000Z", "a"), viewer("exited", "2026-10-01T00:00:00.000Z")],
      }),
    ).toBeNull();
    expect(subMemberRuleFor(rule, null)).toBeNull();
    expect(subMemberRuleFor(null, { memberships: [] })).toBeNull();
  });

  it("an exited or already-member caller (rule narrowed to null): no line, and the transfer makes no promise", async () => {
    const instructions: CheckoutResult = {
      kind: "instructions",
      paymentId: "0192f000-0000-7000-8000-0000000000ab",
      reference: "CA-7K2M9QXB",
      instructions: "Pay the co-op by bank transfer.",
      amount: { cents: 499, currency: "usd" },
    };
    for (const view of [
      membershipView(),
      {
        memberships: [
          { id: "x", class: "viewer" as const, status: "exited" as const, basis: "share" as const, joinedAt: iso(-48) },
        ],
      },
    ]) {
      const onInstructions = vi.fn<SupportFormProps["onInstructions"]>();
      wrap(
        <SupportForm
          channel="rivertide"
          info={supportInfo()}
          checkout={async () => instructions}
          memberRule={subMemberRuleFor(rule, view)}
          onInstructions={onInstructions}
        />,
      );
      expect(screen.queryByTestId("support-member-notice")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByTestId("support-submit"));
      });
      await waitFor(() => expect(onInstructions).toHaveBeenCalledWith(instructions, false));
      cleanup();
    }
  });

  it("on the Subscribe tab: the line with the minimum, counted once; bank transfer says when membership starts", async () => {
    const instructions: CheckoutResult = {
      kind: "instructions",
      paymentId: "0192f000-0000-7000-8000-0000000000aa",
      reference: "CA-7K2M9QXA",
      instructions: "Pay the co-op by bank transfer.",
      amount: { cents: 499, currency: "usd" },
    };
    const onInstructions = vi.fn<SupportFormProps["onInstructions"]>();
    wrap(
      <SupportForm
        channel="rivertide"
        info={supportInfo()}
        checkout={async () => instructions}
        memberRule={rule}
        onInstructions={onInstructions}
      />,
    );
    const line = screen.getByTestId("support-member-notice");
    expect(line.textContent).toContain(t("d2Membership.support.memberNotice", { minSub: "$3.00" }));
    expect(line.dataset.qualifies).toBe("true");
    expect(sent.filter((s) => s === "support.subMemberNotice|view|none")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId("support-submit"));
    });
    await waitFor(() => expect(onInstructions).toHaveBeenCalledWith(instructions, true));
  });

  it("no line for the channel's owner, a co-op that does not count subs, or tiers all below the minimum", () => {
    wrap(
      <SupportForm
        channel="rivertide"
        info={supportInfo({ viewer: { subscription: null, isOwner: true } })}
        checkout={async () => ({ kind: "redirect", url: "https://x.test", paymentId: "p" }) as CheckoutResult}
        memberRule={rule}
        onInstructions={() => undefined}
      />,
    );
    expect(screen.queryByTestId("support-member-notice")).toBeNull();
    cleanup();
    wrap(
      <SubMemberNotice
        rule={{ qualifies: false, minSubscriptionCents: 300 }}
        currency="usd"
        cents={999}
        tierCents={[999]}
      />,
    );
    expect(screen.queryByTestId("support-member-notice")).toBeNull();
    cleanup();
    wrap(<SubMemberNotice rule={rule} currency="usd" cents={200} tierCents={[100, 200]} />);
    expect(screen.queryByTestId("support-member-notice")).toBeNull();
    cleanup();
    wrap(<SubMemberNotice rule={rule} currency="usd" cents={200} tierCents={[200, 500]} />);
    expect(screen.getByTestId("support-member-notice").dataset.qualifies).toBe("false");
    expect(sent).toEqual(["support.subMemberNotice|view|none"]);
  });
});
