// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E5 co-op pages, rendered from the app's components with contract-shaped fixtures: every spec
 * test id and `data-*` attribute that reaches the DOM through a composition prop
 * (E5_COMPOSITION_TEST_IDS), the states that matter (secret ballot, author-only actions, the
 * runner's disabled approve) and the actions' wiring.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AdminCoopPage } from "../src/components/coop/admin.tsx";
import { CouncilPage, SettingsPage } from "../src/components/coop/council.tsx";
import { MembershipPanel } from "../src/components/coop/membership.tsx";
import { CoopOverview } from "../src/components/coop/overview.tsx";
import { ProposalForm, emptyDraft } from "../src/components/coop/proposal-form.tsx";
import { ProposalPage, type ProposalPageProps } from "../src/components/coop/proposal.tsx";
import { ProposalList } from "../src/components/coop/proposals.tsx";
import { StatementPage, StatementsPage } from "../src/components/coop/statements.tsx";
import { CoopTransparency } from "../src/components/coop/transparency.tsx";
import { PatronagePanel, SharesPanel, TreasuryCoopTabs } from "../src/components/coop/treasury.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { ProposalDto } from "../src/lib/coop.ts";
import {
  ME,
  NOW,
  OTHER,
  PERIOD_ID,
  PROPOSAL_ID,
  board,
  comments,
  council,
  elections,
  membershipView,
  month,
  period,
  proposal,
  rejectedProtected,
  settings,
  share,
  statement,
  usd,
  votingProposal,
} from "./coop-fixtures.ts";
import { E5_COMPOSITION_TEST_IDS } from "./composition-ids.ts";

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

afterEach(cleanup);

const seen = new Set<string>();
const noop = () => undefined;
const asyncNoop = async () => undefined;
const id = (testId: string) => screen.getByTestId(testId);
const all = (testId: string) => screen.queryAllByTestId(testId);
const attrs = (el: Element, names: string[]) => names.map((n) => el.getAttribute(n));
/** Exactly one element with the id; records it as proven when it is composition-delivered. */
function one(testId: string): HTMLElement {
  const found = all(testId);
  expect(found, testId).toHaveLength(1);
  seen.add(testId);
  return found[0] as HTMLElement;
}
function many(testId: string): HTMLElement[] {
  const found = all(testId);
  expect(found.length, testId).toBeGreaterThan(0);
  seen.add(testId);
  return found;
}

function proposalPage(p: ProposalDto, over: Partial<ProposalPageProps> = {}) {
  const props: ProposalPageProps = {
    proposal: p,
    comments,
    hasMoreComments: false,
    loadingMoreComments: false,
    onLoadMoreComments: noop,
    meId: ME,
    member: true,
    councilMember: false,
    now: NOW,
    votingClosed: false,
    onSubmitProposal: asyncNoop,
    onWithdraw: asyncNoop,
    onActionError: noop,
    onComment: asyncNoop,
    onVote: asyncNoop,
    onCouncilRespond: asyncNoop,
    ...over,
  };
  return wrap(<ProposalPage {...props} />);
}

describe("/coop", () => {
  it("signed in: membership card, open proposals, council seats, members by class", () => {
    wrap(
      <CoopOverview
        signedIn
        membership={membershipView()}
        openProposals={[votingProposal()]}
        council={council}
        months={[month("2026-10")]}
      />,
    );
    one("coop");
    expect(one("coop-membership-card").getAttribute("data-classes")).toBe("streamer,viewer");
    expect(one("coop-membership-link").getAttribute("href")).toBe("/coop/membership");
    expect(attrs(one("coop-open-proposal"), ["data-proposal-id", "data-status", "data-kind"])).toEqual([
      PROPOSAL_ID,
      "voting",
      "ordinary",
    ]);
    expect(many("coop-council-member").map((s) => attrs(s, ["data-user-id", "data-rank"]))).toEqual([
      [ME, "1"],
      [OTHER, "2"],
    ]);
    expect(attrs(one("coop-members-by-class"), ["data-streamer", "data-viewer", "data-worker"])).toEqual([
      "2",
      "1",
      "1",
    ]);
    // Participation only: no yes/no counts on an open proposal.
    expect(id("coop-open-proposal").textContent).toContain("3 of 4 voted");
  });

  it("signed out: no membership card; not a member: an empty data-classes", () => {
    wrap(<CoopOverview signedIn={false} membership={null} openProposals={[]} council={council} months={[]} />);
    expect(all("coop-membership-card")).toHaveLength(0);
    expect(attrs(one("coop-members-by-class"), ["data-streamer", "data-viewer", "data-worker"])).toEqual([
      "0",
      "0",
      "0",
    ]);
    cleanup();
    wrap(
      <CoopOverview
        signedIn
        membership={membershipView({ memberships: [], share: null })}
        openProposals={[]}
        council={null}
        months={null}
      />,
    );
    expect(one("coop-membership-card").getAttribute("data-classes")).toBe("");
  });
});

describe("/coop/membership", () => {
  const panel = (over: Partial<React.ComponentProps<typeof MembershipPanel>> = {}) =>
    wrap(
      <MembershipPanel
        view={membershipView()}
        rules={{ shareCents: 2500, refundableOnExit: true }}
        currency="usd"
        instructions={null}
        buying={false}
        onBuy={noop}
        onExit={asyncNoop}
        onExitError={noop}
        {...over}
      />,
    );

  it("memberships, eligibility and the held share; exit only for active classes", () => {
    panel();
    one("membership");
    const rows = many("membership-row");
    expect(rows.map((r) => attrs(r, ["data-membership-id", "data-class", "data-status", "data-basis"]))).toEqual([
      ["m-streamer", "streamer", "active", "streaming_hours"],
      ["m-viewer", "viewer", "active", "share"],
      ["m-worker", "worker", "exited", "board_appointment"],
    ]);
    one("membership-exit-streamer");
    one("membership-exit-viewer");
    expect(all("membership-exit-worker")).toHaveLength(0);
    const classes = many("membership-eligibility");
    expect(
      classes.map((c) =>
        attrs(c, ["data-class", "data-eligible", "data-basis", "data-have", "data-need", "data-unit"]),
      ),
    ).toEqual([
      ["streamer", "true", "streaming_hours", "12.5", "10", "hours"],
      ["viewer", "true", "share", "2500", "2500", "cents"],
      ["worker", "false", "", "", "", ""],
    ]);
    expect(attrs(one("membership-share"), ["data-status", "data-cents"])).toEqual(["held", "2500"]);
    // A held share and a viewer membership: no second share.
    expect(all("membership-buy-share")).toHaveLength(0);
  });

  it("the exit dialog says whether the share is refunded, and confirming exits that class", async () => {
    const onExit = vi.fn<(cls: string) => Promise<void>>(async () => undefined);
    panel({ onExit });
    fireEvent.click(id("membership-exit-viewer"));
    const dialog = await waitFor(() => one("membership-exit-confirm"));
    expect(dialog.textContent).toContain(en["coop.exit.refunded"]);
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(onExit).toHaveBeenCalledWith("viewer"));
  });

  it("an exit that keeps the share says so; a streamer exit has no share to refund", async () => {
    panel({ rules: { shareCents: 2500, refundableOnExit: false } });
    fireEvent.click(id("membership-exit-viewer"));
    expect((await waitFor(() => one("membership-exit-confirm"))).textContent).toContain(en["coop.exit.notRefunded"]);
    cleanup();
    panel();
    fireEvent.click(id("membership-exit-streamer"));
    expect((await waitFor(() => one("membership-exit-confirm"))).textContent).toContain(en["coop.exit.noShare"]);
  });

  it("an appointed worker can leave the worker class too", () => {
    const view = membershipView();
    panel({
      view: {
        ...view,
        memberships: view.memberships.map((m) => (m.class === "worker" ? { ...m, status: "active" as const } : m)),
      },
    });
    expect(one("membership-exit-worker").textContent).toBe(en["coop.exit.label"]);
  });

  it("no share: buy is offered at the share price; after buying, the manual instructions", () => {
    const onBuy = vi.fn<() => void>();
    const view = membershipView({ memberships: [], share: null });
    panel({ view, onBuy });
    expect(attrs(one("membership-share"), ["data-status", "data-cents"])).toEqual(["none", "2500"]);
    fireEvent.click(one("membership-buy-share"));
    expect(onBuy).toHaveBeenCalledOnce();
    cleanup();
    panel({
      view,
      instructions: {
        paymentId: "pay-1",
        reference: "CA-ABC123",
        instructions: "Transfer to the co-op.",
        amount: usd(2500),
      },
    });
    expect(id("membership-share").getAttribute("data-status")).toBe("pending");
    const box = one("membership-share-instructions");
    expect(attrs(box, ["data-reference", "data-payment-id", "data-cents"])).toEqual(["CA-ABC123", "pay-1", "2500"]);
    expect(box.textContent).toContain("Transfer to the co-op.");
    expect(all("membership-buy-share")).toHaveLength(0);
  });

  it("a pending or refund_pending share hides buy; a refunded one offers it again", () => {
    for (const [status, offered] of [
      ["pending", false],
      ["refund_pending", false],
      ["refunded", true],
      ["cancelled", true],
    ] as const) {
      panel({ view: membershipView({ memberships: [], share: { id: "s", status, amount: usd(2500) } }) });
      expect(all("membership-buy-share").length, status).toBe(offered ? 1 : 0);
      expect(id("membership-share").getAttribute("data-status")).toBe(status);
      cleanup();
    }
  });
});

describe("/coop/proposals", () => {
  it("the filter, items and New proposal for members", () => {
    const onFilterChange = vi.fn<(filter: string) => void>();
    wrap(
      <ProposalList
        proposals={[proposal({ status: "discussion" }), rejectedProtected()]}
        filter="all"
        onFilterChange={onFilterChange}
        member
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
      />,
    );
    one("proposals");
    one("proposals-filter");
    for (const status of [
      "all",
      "draft",
      "discussion",
      "council_review",
      "voting",
      "passed",
      "rejected",
      "withdrawn",
      "applied",
    ])
      one(`proposals-filter-${status}`);
    expect(many("proposal-item").map((p) => attrs(p, ["data-proposal-id", "data-status", "data-kind"]))).toEqual([
      [PROPOSAL_ID, "discussion", "ordinary"],
      [PROPOSAL_ID, "rejected", "protected"],
    ]);
    expect(one("proposals-new").getAttribute("href")).toBe("/coop/proposals/new");
    fireEvent.click(id("proposals-filter-voting"));
    expect(onFilterChange).toHaveBeenCalledWith("voting");
  });

  it("not a member: no New proposal; nothing matches: the empty state", () => {
    wrap(
      <ProposalList
        proposals={[]}
        filter="voting"
        onFilterChange={noop}
        member={false}
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
      />,
    );
    expect(all("proposals-new")).toHaveLength(0);
    one("proposals-empty");
  });
});

describe("/coop/proposals/new", () => {
  const form = (rows: { id: string; key: string; value: string }[], affectsCreators = false) => {
    const onSave = vi.fn<(input: unknown) => void>();
    const onDraftChange = vi.fn<(draft: unknown) => void>();
    wrap(
      <ProposalForm
        mode="new"
        settings={settings}
        draft={{ title: "Five spotlight slots", body: "Because.", affectsCreators, rows }}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onCancel={noop}
        saving={false}
        error={null}
      />,
    );
    return { onSave, onDraftChange };
  };

  it("every form id; an ordinary change keeps the kind ordinary and saves the whole value", () => {
    const { onSave } = form([{ id: "r1", key: "discovery.ranking", value: '{"spotlightSlots":5}' }]);
    one("proposal-form");
    expect(one("proposal-title").tagName).toBe("INPUT");
    expect(one("proposal-body").tagName).toBe("TEXTAREA");
    const affects = one("proposal-affects-creators");
    expect(affects.getAttribute("aria-checked")).toBe("false");
    one("proposal-change-add");
    expect(attrs(one("proposal-change"), ["data-key", "data-protected"])).toEqual(["discovery.ranking", "false"]);
    one("proposal-change-key");
    expect(one("proposal-change-value").tagName).toBe("TEXTAREA");
    one("proposal-change-remove");
    expect(one("proposal-kind").getAttribute("data-kind")).toBe("ordinary");
    const save = one("proposal-save");
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({
      title: "Five spotlight slots",
      body: "Because.",
      changes: [{ key: "discovery.ranking", value: { spotlightSlots: 5 } }],
      affectsCreators: false,
    });
  });

  it("a protected key makes it protected and forces affects creators on", () => {
    const { onSave } = form([{ id: "r1", key: "platform.cut", value: '{"streamerShare":0.85}' }]);
    expect(id("proposal-kind").getAttribute("data-kind")).toBe("protected");
    expect(id("proposal-change").getAttribute("data-protected")).toBe("true");
    const affects = id("proposal-affects-creators");
    expect(affects.getAttribute("aria-checked")).toBe("true");
    expect(affects.hasAttribute("data-disabled") || affects.hasAttribute("disabled")).toBe(true);
    fireEvent.click(id("proposal-save"));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ affectsCreators: true });
  });

  it("invalid JSON or a missing key keeps save disabled and says why", () => {
    form([{ id: "r1", key: "discovery.ranking", value: "{spotlightSlots: 5" }]);
    expect(id("proposal-save").hasAttribute("disabled")).toBe(true);
    expect(id("proposal-form").textContent).toContain(en["coop.form.change.invalidJson"]);
    cleanup();
    form([{ id: "r1", key: "", value: "" }]);
    expect(id("proposal-save").hasAttribute("disabled")).toBe(true);
    expect(id("proposal-change").hasAttribute("data-protected")).toBe(false);
  });

  it("no changes is a valid ordinary statement; a short title is not", () => {
    form([]);
    expect(id("proposal-save").hasAttribute("disabled")).toBe(false);
    cleanup();
    wrap(
      <ProposalForm
        mode="new"
        settings={settings}
        draft={{ ...emptyDraft(), title: "Hi", body: "x" }}
        onDraftChange={noop}
        onSave={noop}
        onCancel={noop}
        saving={false}
        error={null}
      />,
    );
    expect(id("proposal-save").hasAttribute("disabled")).toBe(true);
  });
});

describe("/coop/proposals/$id", () => {
  it("draft, seen by its author: submit, edit, withdraw; no discussion yet; the timeline", () => {
    proposalPage(proposal());
    expect(attrs(one("proposal"), ["data-proposal-id", "data-status", "data-kind", "data-affects-creators"])).toEqual([
      PROPOSAL_ID,
      "draft",
      "ordinary",
      "true",
    ]);
    one("proposal-submit");
    expect(one("proposal-edit").getAttribute("href")).toBe(`/coop/proposals/${PROPOSAL_ID}/edit`);
    one("proposal-withdraw");
    expect(all("proposal-comment")).toHaveLength(0);
    expect(attrs(one("proposal-change-summary"), ["data-key", "data-protected"])).toEqual([
      "discovery.ranking",
      "false",
    ]);
    one("proposal-timeline");
    const steps = ["draft", "discussion", "council_review", "voting"].map((s) => one(`proposal-timeline-${s}`));
    expect(steps.map((s) => s.getAttribute("data-state"))).toEqual(["current", "upcoming", "upcoming", "upcoming"]);
    expect(steps.map((s) => s.getAttribute("data-at"))).toEqual(["2026-10-01T00:00:00.000Z", "", "", ""]);
  });

  it("someone else's proposal: no author actions; a member comments while discussion is open", async () => {
    const onComment = vi.fn<(body: string) => Promise<void>>(async () => undefined);
    proposalPage(
      proposal({ status: "discussion", author: { id: OTHER, username: "ohmslaw", displayName: "ohmslaw" } }),
      {
        onComment,
      },
    );
    for (const action of ["proposal-submit", "proposal-edit", "proposal-withdraw"])
      expect(all(action), action).toHaveLength(0);
    expect(many("proposal-comment").map((c) => attrs(c, ["data-comment-id", "data-author-id"]))).toEqual([
      ["c1", OTHER],
      ["c2", ME],
    ]);
    fireEvent.change(one("proposal-comment-body"), { target: { value: "  I agree.  " } });
    fireEvent.click(one("proposal-comment-submit"));
    await waitFor(() => expect(onComment).toHaveBeenCalledWith("I agree."));
    await waitFor(() => expect((id("proposal-comment-body") as HTMLTextAreaElement).value).toBe(""));
  });

  it("the author in discussion may edit and withdraw but not submit again; non-members cannot comment", () => {
    proposalPage(proposal({ status: "discussion" }), { member: false });
    expect(all("proposal-submit")).toHaveLength(0);
    one("proposal-edit");
    one("proposal-withdraw");
    expect(all("proposal-comment-body")).toHaveLength(0);
  });

  it("council review: council members get the respond form; others see that review is under way", async () => {
    const onCouncilRespond = vi.fn<(value: { stance: string; body: string }) => Promise<void>>(async () => undefined);
    const p = proposal({ status: "council_review" });
    proposalPage(p, { councilMember: true, onCouncilRespond });
    one("council-respond");
    one("council-respond-stance");
    for (const s of ["support", "oppose", "mixed", "neutral"]) one(`council-respond-stance-${s}`);
    fireEvent.click(id("council-respond-stance-support"));
    fireEvent.change(one("council-respond-body"), { target: { value: "We back it." } });
    fireEvent.click(one("council-respond-submit"));
    await waitFor(() => expect(onCouncilRespond).toHaveBeenCalledWith({ stance: "support", body: "We back it." }));
    // Council review: author may withdraw, not edit.
    expect(all("proposal-edit")).toHaveLength(0);
    one("proposal-withdraw");
    cleanup();
    proposalPage(p, { councilMember: false });
    expect(all("council-respond")).toHaveLength(0);
  });

  it("voting: the ballot with the caller's vote and participation only, never a running tally", async () => {
    const onVote = vi.fn<(choice: string) => Promise<void>>(async () => undefined);
    proposalPage(votingProposal(), { onVote });
    const panel = one("vote-panel");
    expect(attrs(panel, ["data-my-vote", "data-can-vote"])).toEqual(["yes", "true"]);
    one("vote-choice");
    for (const c of ["yes", "no", "abstain"]) one(`vote-choice-${c}`);
    expect(attrs(one("vote-participation"), ["data-voted", "data-eligible"])).toEqual(["3", "4"]);
    expect(all("tally")).toHaveLength(0);
    expect(all("tally-row")).toHaveLength(0);
    expect(document.querySelector("[data-yes],[data-no],[data-abstain]")).toBeNull();
    expect(attrs(one("council-response"), ["data-stance"])).toEqual(["support"]);
    fireEvent.click(id("vote-choice-no"));
    fireEvent.click(one("vote-submit"));
    await waitFor(() => expect(onVote).toHaveBeenCalledWith("no"));
    const steps = ["draft", "discussion", "council_review", "voting"].map((s) =>
      id(`proposal-timeline-${s}`).getAttribute("data-state"),
    );
    expect(steps).toEqual(["done", "done", "done", "current"]);
    expect(all("proposal-timeline-passed")).toHaveLength(0);
  });

  it("voting, not in the electorate: the ballot is disabled with the reason", () => {
    proposalPage(votingProposal({ myVote: null, canVote: false }), { councilMember: false });
    expect(attrs(id("vote-panel"), ["data-my-vote", "data-can-vote"])).toEqual(["", "false"]);
    expect(id("vote-submit").hasAttribute("disabled")).toBe(true);
    expect(id("vote-panel").textContent).toContain(en["coop.vote.notInElectorate"]);
  });

  it("voting past its window (or refused as closed): no ballot, a closed notice and participation", () => {
    const p = votingProposal();
    const ends = Date.parse(p.timeline.votingEndsAt ?? "");
    proposalPage(p, { now: ends + 1 });
    expect(all("vote-panel")).toHaveLength(0);
    one("vote-closed");
    one("vote-participation");
    cleanup();
    proposalPage(p, { votingClosed: true });
    expect(all("vote-panel")).toHaveLength(0);
  });

  it("the council missed its review: council-response-missed", () => {
    proposalPage(votingProposal({ councilResponse: null, councilResponseMissed: true }));
    one("council-response-missed");
    expect(all("council-response")).toHaveLength(0);
  });

  it("decided: the tally per class with every check, the reason as the API gave it", () => {
    proposalPage(rejectedProtected());
    const tally = one("tally");
    expect(attrs(tally, ["data-passed", "data-reason"])).toEqual(["false", "streamer-class majority not met"]);
    expect(
      many("tally-row").map((r) => attrs(r, ["data-scope", "data-yes", "data-no", "data-abstain", "data-eligible"])),
    ).toEqual([
      ["member_wide", "3", "1", "0", "4"],
      ["streamer", "1", "1", "0", "2"],
      ["viewer", "1", "0", "0", "1"],
      ["worker", "1", "0", "0", "1"],
    ]);
    expect(many("tally-check").map((c) => attrs(c, ["data-rule", "data-passed"]))).toEqual([
      ["member_wide_quorum", "true"],
      ["member_wide_threshold", "true"],
      ["streamer_class_quorum", "true"],
      ["streamer_class_majority", "false"],
    ]);
    expect(all("vote-panel")).toHaveLength(0);
    expect(all("proposal-comment-body")).toHaveLength(0);
    expect(one("proposal-timeline-rejected").getAttribute("data-state")).toBe("done");
    expect(id("proposal").getAttribute("data-kind")).toBe("protected");
    expect(id("proposal-change-summary").getAttribute("data-protected")).toBe("true");
  });

  it("passed then applied: the outcome steps; withdrawn: the steps it reached", () => {
    const decided = rejectedProtected();
    const tally = decided.tally ? { ...decided.tally, passed: true, reason: "passed" } : null;
    proposalPage({ ...decided, status: "passed", tally });
    expect(one("proposal-timeline-passed").getAttribute("data-state")).toBe("current");
    expect(one("proposal-timeline-applied").getAttribute("data-state")).toBe("upcoming");
    cleanup();
    proposalPage({
      ...decided,
      status: "applied",
      tally,
      timeline: { ...decided.timeline, appliedAt: "2026-10-20T12:00:00.000Z" },
    });
    expect(id("proposal-timeline-applied").getAttribute("data-state")).toBe("done");
    expect(id("proposal-timeline-applied").getAttribute("data-at")).toBe("2026-10-20T12:00:00.000Z");
    expect(id("tally").getAttribute("data-passed")).toBe("true");
    cleanup();
    proposalPage(
      proposal({
        status: "withdrawn",
        timeline: { ...proposal().timeline, discussionEndsAt: "2026-10-03T00:00:00.000Z" },
      }),
    );
    expect(one("proposal-timeline-withdrawn").getAttribute("data-state")).toBe("done");
    expect(all("proposal-timeline-voting")).toHaveLength(0);
    expect(id("proposal-timeline-discussion").getAttribute("data-state")).toBe("done");
    for (const action of ["proposal-submit", "proposal-edit", "proposal-withdraw"]) expect(all(action)).toHaveLength(0);
  });
});

describe("/coop/council and /coop/settings", () => {
  it("the term, its seats with rank and score, the method, board seats and elections", () => {
    wrap(<CouncilPage council={council} board={board} elections={elections} />);
    expect(attrs(one("council"), ["data-term-id", "data-starts-at", "data-ends-at"])).toEqual([
      "term-1",
      "2026-10-01T00:00:00.000Z",
      "2026-10-31T23:59:59.000Z",
    ]);
    expect(many("council-member").map((m) => attrs(m, ["data-user-id", "data-rank", "data-score"]))).toEqual([
      [ME, "1", "41.5"],
      [OTHER, "2", "12"],
    ]);
    expect(one("council-method").textContent).toContain("windowDays");
    expect(attrs(one("board-seat"), ["data-user-id", "data-class"])).toEqual([OTHER, "viewer"]);
    expect(attrs(one("election-item"), ["data-election-id", "data-class", "data-status"])).toEqual([
      "e1",
      "viewer",
      "nominating",
    ]);
  });

  it("no term yet: empty term attributes and no seats", () => {
    wrap(
      <CouncilPage
        council={{ termId: null, startsAt: null, endsAt: null, members: [], method: {} }}
        board={[]}
        elections={[]}
      />,
    );
    expect(attrs(id("council"), ["data-term-id", "data-starts-at", "data-ends-at"])).toEqual(["", "", ""]);
    expect(all("council-member")).toHaveLength(0);
  });

  it("settings: protected flags and the decision that last set each", () => {
    wrap(<SettingsPage settings={settings} />);
    one("settings");
    expect(many("setting-row").map((r) => attrs(r, ["data-key", "data-protected", "data-updated-by"]))).toEqual([
      ["discovery.ranking", "false", PROPOSAL_ID],
      ["platform.cut", "true", ""],
      ["membership.classes", "true", ""],
    ]);
  });
});

describe("/coop/patronage", () => {
  it("the statements list, and its empty state", () => {
    wrap(<StatementsPage statements={[statement]} />);
    one("patronage");
    expect(attrs(one("patronage-item"), ["data-period-id", "data-status", "data-cents"])).toEqual([
      PERIOD_ID,
      "approved",
      "4200",
    ]);
    expect(all("patronage-empty")).toHaveLength(0);
    cleanup();
    wrap(<StatementsPage statements={[]} />);
    one("patronage-empty");
  });

  it("one statement: total, lines with explanations, inputs", () => {
    wrap(<StatementPage statement={statement} />);
    expect(attrs(one("statement"), ["data-period-id", "data-status", "data-cents", "data-formula-version"])).toEqual([
      PERIOD_ID,
      "approved",
      "4200",
      "patronage-2026.1",
    ]);
    const lines = many("statement-line");
    expect(lines.map((l) => attrs(l, ["data-component", "data-cents", "data-share", "data-cap-applied"]))).toEqual([
      ["revenue", "2500", "0.5", "false"],
      ["streamingHours", "1000", "0.5", "true"],
    ]);
    expect(many("statement-line-explanation").map((e) => e.textContent)).toEqual([
      statement.lines[0]?.explanation,
      statement.lines[1]?.explanation,
    ]);
    expect(
      attrs(one("statement-inputs"), ["data-revenue-cents", "data-hours", "data-relay-bytes", "data-viewer-hours"]),
    ).toEqual(["1000", "2", "0", "7.5"]);
  });
});

describe("/treasury co-op tabs", () => {
  it("the shares and patronage tabs after the E4b ones", () => {
    wrap(
      <TreasuryCoopTabs
        value="shares"
        onValueChange={noop}
        panels={{ payments: null, payouts: null, accounts: null, costs: null, shares: <p>shares</p>, patronage: null }}
      />,
    );
    for (const tab of ["payments", "payouts", "accounts", "costs"]) expect(all(`treasury-tab-${tab}`)).toHaveLength(1);
    expect(one("treasury-tab-shares").getAttribute("role")).toBe("tab");
    expect(one("treasury-tab-patronage").getAttribute("role")).toBe("tab");
  });

  it("shares: rows by status; refund_pending rows record the refund with a note", async () => {
    const onRefund = vi.fn<(share: unknown, note: string) => Promise<void>>(async () => undefined);
    wrap(
      <SharesPanel
        shares={[share("sh1", "refund_pending"), share("sh2", "held")]}
        status="refund_pending"
        onStatusChange={noop}
        onRefund={onRefund}
        onRefundError={noop}
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
      />,
    );
    const rows = many("treasury-share-row");
    expect(rows.map((r) => attrs(r, ["data-share-id", "data-user-id", "data-status", "data-cents"]))).toEqual([
      ["sh1", OTHER, "refund_pending", "2500"],
      ["sh2", OTHER, "held", "2500"],
    ]);
    expect(rows.map((r) => r.querySelector('[data-testid="treasury-share-refund"]') !== null)).toEqual([true, false]);
    fireEvent.click(one("treasury-share-refund"));
    const note = await waitFor(() => one("treasury-share-refund-note"));
    fireEvent.change(note, { target: { value: " wire 42 " } });
    fireEvent.click(one("treasury-share-refund-submit"));
    await waitFor(() => expect(onRefund).toHaveBeenCalledWith(expect.objectContaining({ id: "sh1" }), "wire 42"));
  });

  it("patronage: run form, result, periods; approve is disabled with the reason for the runner", async () => {
    const onApprove = vi.fn<(period: unknown) => Promise<void>>(async () => undefined);
    const onRun = vi.fn<(submission: unknown) => void>();
    wrap(
      <PatronagePanel
        meId={ME}
        currency="usd"
        values={{ start: "2026-10-01T00:00:00", end: "2026-10-20T00:00:00", surplus: "50.00" }}
        onValuesChange={noop}
        onRun={onRun}
        running={false}
        runError={null}
        result={{ periodId: "p-new", members: 3, total: usd(9000), surplus: usd(10_000) }}
        periods={[
          period("p-mine", "computed", ME),
          period("p-theirs", "computed", OTHER),
          period("p-old", "approved", OTHER),
        ]}
        onApprove={onApprove}
        onApproveError={noop}
      />,
    );
    one("patronage-run-form");
    for (const f of ["patronage-run-start", "patronage-run-end", "patronage-run-surplus"])
      expect(one(f).tagName).toBe("INPUT");
    expect(id("patronage-run-surplus").getAttribute("data-cents")).toBe("5000");
    fireEvent.click(one("patronage-run-submit"));
    expect(onRun).toHaveBeenCalledWith({
      start: "2026-10-01T00:00:00",
      end: "2026-10-20T00:00:00",
      surplusCents: 5000,
    });
    expect(attrs(one("patronage-run-result"), ["data-period-id", "data-members", "data-cents"])).toEqual([
      "p-new",
      "3",
      "9000",
    ]);
    const rows = many("patronage-period-row");
    expect(
      rows.map((r) =>
        attrs(r, ["data-period-id", "data-status", "data-cents", "data-computed-by", "data-approved-by"]),
      ),
    ).toEqual([
      ["p-mine", "computed", "9000", ME, ""],
      ["p-theirs", "computed", "9000", OTHER, ""],
      ["p-old", "approved", "9000", OTHER, OTHER],
    ]);
    const approves = many("patronage-approve");
    expect(approves).toHaveLength(2);
    const [mine, theirs] = approves as [HTMLElement, HTMLElement];
    expect(mine.hasAttribute("disabled") || mine.getAttribute("aria-disabled") === "true").toBe(true);
    const reason = document.getElementById(mine.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(en["coop.periods.secondApprover"]);
    expect(theirs.hasAttribute("disabled")).toBe(false);
    fireEvent.click(theirs);
    fireEvent.click(await waitFor(() => screen.getByTestId("confirm-dialog-confirm")));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: "p-theirs" })));
  });
});

describe("/admin/coop and /transparency", () => {
  it("the appointment form", async () => {
    const onAppoint = vi.fn<(values: unknown) => void>();
    wrap(
      <AdminCoopPage
        values={{ username: " wren ", minute: " BM-2026-14 " }}
        onValuesChange={noop}
        onAppoint={onAppoint}
        pending={false}
        error={null}
      />,
    );
    one("admin-coop");
    expect(one("appoint-worker-username").tagName).toBe("INPUT");
    expect(one("appoint-worker-minute").tagName).toBe("INPUT");
    await act(async () => {
      fireEvent.click(one("appoint-worker-submit"));
    });
    expect(onAppoint).toHaveBeenCalledWith({ username: "wren", minute: "BM-2026-14" });
  });

  it("governance outcomes per month and patronage distributed (only months that distributed)", () => {
    wrap(
      <CoopTransparency
        months={[
          month("2026-10", {
            patronageDistributed: usd(9000),
            governance: [
              {
                proposalId: "pa",
                title: "Five slots",
                status: "applied",
                kind: "ordinary",
                passed: true,
                reason: "passed",
                decidedAt: "2026-10-10T00:00:00.000Z",
              },
              {
                proposalId: "pb",
                title: "Cut",
                status: "rejected",
                kind: "protected",
                passed: false,
                reason: "streamer-class majority not met",
                decidedAt: "2026-10-11T00:00:00.000Z",
              },
            ],
          }),
          month("2026-09"),
        ]}
      />,
    );
    expect(
      many("transparency-governance").map((g) =>
        attrs(g, ["data-proposal-id", "data-status", "data-kind", "data-passed", "data-month"]),
      ),
    ).toEqual([
      ["pa", "applied", "ordinary", "true", "2026-10"],
      ["pb", "rejected", "protected", "false", "2026-10"],
    ]);
    expect(attrs(one("transparency-patronage"), ["data-month", "data-cents"])).toEqual(["2026-10", "9000"]);
  });
});

describe("coverage", () => {
  it("found every E5 composition-only id in the DOM (the tests above run first)", () => {
    const missing = (E5_COMPOSITION_TEST_IDS as readonly string[]).filter((testId) => !seen.has(testId));
    expect(missing).toEqual([]);
  });
});
