// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d6-governance (overhaul D6.2, D6.3): the readable governance pages rendered from the app's
 * components: settings in words by theme with "Changed by", "90% → 85%" with the JSON behind a
 * disclosure, ProposalCard v2, result bars with threshold ticks, the signed-out join prompt, the
 * typed change editor, and the council as people.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CouncilPage, SettingsPage } from "../src/components/coop/council.tsx";
import { CoopOverview } from "../src/components/coop/overview.tsx";
import { ProposalForm } from "../src/components/coop/proposal-form.tsx";
import { ProposalPage, type ProposalPageProps } from "../src/components/coop/proposal.tsx";
import { ProposalList } from "../src/components/coop/proposals.tsx";
import { ProposalChanges } from "../src/components/governance/changes.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { CouncilDto, ProposalDraft, ProposalDto, SettingDto } from "../src/lib/coop.ts";
import {
  ME,
  NOW,
  OTHER,
  PROPOSAL_ID,
  board,
  comments,
  council,
  elections,
  rejectedProtected,
  settings,
  votingProposal,
} from "./coop-fixtures.ts";

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
/** Countdowns read the live clock: pin it to the fixtures' NOW. */
const atNow = () => vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

const id = (testId: string) => screen.getByTestId(testId);
const all = (testId: string) => screen.queryAllByTestId(testId);
const noop = () => undefined;
const asyncNoop = async () => undefined;

const rules: SettingDto[] = [
  {
    key: "governance.ordinary",
    value: {
      threshold: 0.5,
      quorum: 0.1,
      discussionSeconds: 1_209_600,
      minVotingSeconds: 259_200,
      votingSeconds: 604_800,
    },
    protected: false,
    description: "",
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedByProposalId: null,
    updatedByProposalTitle: null,
  },
  {
    key: "governance.protections",
    value: {
      protectedKeys: ["platform.cut", "governance.protections"],
      memberWideThreshold: 2 / 3,
      streamerClassThreshold: 0.5,
      quorum: 0.2,
      streamerClassQuorum: 0.2,
      councilReviewSeconds: 604_800,
      minVotingSeconds: 604_800,
    },
    protected: true,
    description: "",
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedByProposalId: null,
    updatedByProposalTitle: null,
  },
];

describe("/coop/settings in words", () => {
  it("groups by theme, says each value in words, the lock and who changed it; the key is meta", () => {
    const list: SettingDto[] = [
      ...settings.map((s) =>
        s.key === "discovery.ranking" ? { ...s, updatedByProposalTitle: "Five spotlight slots" } : s,
      ),
      ...rules,
      { ...rules[0]!, key: "brand.new", value: { level: 3 } },
    ];
    wrap(<SettingsPage settings={list} />);
    expect(all("settings-group").map((g) => g.getAttribute("data-theme"))).toEqual([
      "money",
      "governance",
      "membership",
      "discovery",
      "other",
    ]);
    const row = (key: string) => all("setting-row").find((r) => r.getAttribute("data-key") === key)!;
    expect(within(row("platform.cut")).getByTestId("setting-value").textContent).toBe("Creator share: 71%");
    expect(row("platform.cut").textContent).toContain("Creator share of revenue");
    expect(row("platform.cut").textContent).toContain("Protected");
    expect(row("platform.cut").textContent).toContain("Founding value");
    expect(row("platform.cut").textContent).toContain("Setting key platform.cut");
    expect(within(row("governance.ordinary")).getByTestId("setting-value").textContent).toBe(
      "10% quorum · simple majority · 14-day discussion · 7-day vote",
    );
    expect(row("governance.ordinary").textContent).not.toContain("Protected");
    const changed = within(row("discovery.ranking")).getByTestId("setting-changed-by");
    expect(changed.textContent).toBe("Five spotlight slots");
    expect(changed.getAttribute("href")).toBe(`/coop/proposals/${PROPOSAL_ID}`);
    expect(row("discovery.ranking").textContent).toMatch(/^.*Changed by Five spotlight slots · /);
    expect(within(row("brand.new")).getByTestId("setting-value").textContent).toBe("level: 3");
    // No JSON anywhere on the page.
    expect(id("settings").textContent).not.toMatch(/[{}]/);
  });

  it("a proposal that is gone reads 'a proposal'", () => {
    wrap(<SettingsPage settings={[settings[0]!]} />);
    expect(id("setting-changed-by").textContent).toBe("a proposal");
  });
});

describe("what a proposal changes", () => {
  it("90% → 85% with the new value marked; the JSON only behind Technical details", () => {
    wrap(
      <ProposalChanges
        changes={[
          {
            key: "platform.cut",
            from: { streamerShare: 0.9, coopShare: 0.1 },
            to: { streamerShare: 0.85, coopShare: 0.15 },
            protected: true,
          },
        ]}
      />,
    );
    const item = id("proposal-change-summary");
    expect(item.getAttribute("data-protected")).toBe("true");
    expect(item.textContent).toContain("Creators keep 90% · co-op 10%");
    expect(item.textContent).toContain("Creators keep 85% · co-op 15%");
    const marks = [...item.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks).toEqual(["Creators keep 85% · co-op 15%", "85%", "15%"]);
    expect(item.querySelector('[data-field="streamerShare"]')?.textContent).toBe("Creator share90%to85%");
    expect(item.textContent).not.toContain("streamerShare");
    const details = within(item).getByRole("button", { name: en["d6Governance.change.technical"] });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(item.textContent).toContain('"streamerShare": 0.85');
    expect(item.textContent).toContain("Setting key platform.cut");
  });

  it("no changes, an unchanged value and an unknown key", () => {
    wrap(<ProposalChanges changes={[]} />);
    expect(screen.getByText(en["coop.proposal.noChanges"])).toBeTruthy();
    cleanup();
    wrap(
      <ProposalChanges
        changes={[
          { key: "jury.enabled", from: { enabled: false }, to: { enabled: false }, protected: false },
          { key: "brand.new", from: { level: 1 }, to: { level: 2 }, protected: false },
        ]}
      />,
    );
    const [same, unknown] = all("proposal-change-summary");
    expect(same?.textContent).toContain(en["d6Governance.change.unchanged"]);
    expect(unknown?.textContent).toContain("brand.new");
    expect(unknown?.querySelector('[data-field="level"]')?.textContent).toBe("level1to2");
  });
});

describe("ProposalCard v2", () => {
  const list = (proposals: ProposalDto[]) =>
    wrap(
      <ProposalList
        proposals={proposals}
        filter="all"
        onFilterChange={noop}
        member
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
        settings={rules}
        now={NOW}
      />,
    );

  it("an open vote: author, excerpt, tags, countdown, turnout against the quorum tick; the card is one link", () => {
    atNow();
    list([votingProposal({ myVote: null })]);
    const card = id("proposal-item");
    expect(card.textContent).toContain("Proposed by rivertide");
    expect(card.textContent).toContain("More room for small channels.");
    expect(card.textContent).toContain(en["coop.proposal.affectsCreators"]);
    expect(card.textContent).toContain(en["d6Governance.card.canVote"]);
    expect(card.textContent).toContain("Voting closes in 10 minutes");
    const bar = within(card).getByTestId("proposal-participation");
    expect(bar.getAttribute("data-value")).toBe("0.75");
    expect(bar.getAttribute("data-threshold")).toBe("0.1");
    expect(bar.textContent).toContain("75% · 3 of 4 voted");
    expect(bar.textContent).toContain("Quorum of 10% reached");
    expect(bar.querySelector('[data-slot="threshold-tick"]')?.getAttribute("x1")).toBe("10");
    const links = within(card).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(`/coop/proposals/${PROPOSAL_ID}`);
  });

  it("a decided card: the result chip and the rule that decided it, the protected lock", () => {
    list([rejectedProtected()]);
    const card = id("proposal-item");
    expect(card.textContent).toContain(en["coop.tally.rejected"]);
    expect(card.textContent).toContain("50% yes, more than 50% needed");
    expect(card.textContent).toContain("Protected");
    expect(card.textContent).toMatch(/Decided .*ago/);
    expect(within(card).queryByTestId("proposal-participation")).toBeNull();
  });

  it("without the settings the bar has no tick and says no quorum", () => {
    wrap(
      <ProposalList
        proposals={[votingProposal()]}
        filter="all"
        onFilterChange={noop}
        member
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
        now={NOW}
      />,
    );
    const bar = id("proposal-participation");
    expect(bar.getAttribute("data-threshold")).toBe("");
    expect(bar.querySelector('[data-slot="threshold-tick"]')).toBeNull();
    expect(id("proposal-item").textContent).toContain(en["d6Governance.card.voted"]);
  });
});

function page(p: ProposalDto, over: Partial<ProposalPageProps> = {}) {
  return wrap(
    <ProposalPage
      proposal={p}
      comments={comments}
      hasMoreComments={false}
      loadingMoreComments={false}
      onLoadMoreComments={noop}
      meId={ME}
      member
      councilMember={false}
      now={NOW}
      votingClosed={false}
      onSubmitProposal={asyncNoop}
      onWithdraw={asyncNoop}
      onActionError={noop}
      onComment={asyncNoop}
      onVote={asyncNoop}
      onCouncilRespond={asyncNoop}
      settings={rules}
      {...over}
    />,
  );
}

describe("/coop/proposals/$id", () => {
  it("signed out, the ballot is a join prompt with the gate's actions; participation stays", () => {
    page(votingProposal(), { meId: null, member: false });
    expect(all("vote-panel")).toHaveLength(0);
    const join = id("vote-join");
    expect(join.textContent).toContain(en["d6Governance.vote.joinTitle"]);
    expect(id("vote-join-create").getAttribute("href")).toContain("/signup");
    expect(id("vote-join-signin").getAttribute("href")).toContain("/signin");
    expect(id("vote-participation").getAttribute("data-threshold")).toBe("0.1");
  });

  it("the timeline says the next step and its deadline", () => {
    atNow();
    page(votingProposal());
    expect(id("proposal-next-step").textContent).toBe("Voting closes in 10 minutes");
  });

  it("decided: bars with threshold ticks and text equivalents, the deciding rule, the tally table", () => {
    page(rejectedProtected());
    const bars = all("vote-result-bar");
    expect(bars.map((b) => [b.getAttribute("data-rule"), b.getAttribute("data-passed")])).toEqual([
      ["member_wide_quorum", "true"],
      ["member_wide_threshold", "true"],
      ["streamer_class_quorum", "true"],
      ["streamer_class_majority", "false"],
    ]);
    expect(bars[1]?.textContent).toContain("75% · 3 of 4");
    expect(bars[1]?.textContent).toContain("Met: 66.7% needed");
    expect(bars[3]?.textContent).toContain("Not met: 50% needed");
    // The streamer quorum check has no "required" clause: the current rule's 20%.
    expect(bars[2]?.getAttribute("data-threshold")).toBe("0.2");
    for (const svg of id("vote-result-bars").querySelectorAll("svg"))
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(id("vote-result-rule").textContent).toBe("50% yes, more than 50% needed");
    expect(id("tally")).toBeTruthy();
    expect(id("proposal-next-step").textContent).toMatch(/^Decided /);
  });
});

/** The form with its draft in state, as the route holds it. */
function StatefulForm({
  initial,
  list,
  onSave,
}: {
  initial: ProposalDraft;
  list: SettingDto[];
  onSave: (v: unknown) => void;
}) {
  const [draft, setDraft] = React.useState(initial);
  return (
    <ProposalForm
      mode="new"
      settings={list}
      draft={draft}
      onDraftChange={setDraft}
      onSave={onSave}
      onCancel={noop}
      saving={false}
      error={null}
    />
  );
}

const cut: SettingDto = {
  ...settings[1]!,
  value: { streamerShare: 0.9, coopShare: 0.1 },
};

describe("the typed change editor", () => {
  const draft = (key: string, value: unknown): ProposalDraft => ({
    title: "Change a setting",
    body: "Because.",
    affectsCreators: false,
    rows: [{ id: "r1", key, value: JSON.stringify(value, null, 2) }],
  });

  it("the cut is a percent field; the co-op share follows; the preview says before → after", () => {
    const onSave = vi.fn<(input: unknown) => void>();
    wrap(<StatefulForm initial={draft("platform.cut", cut.value)} list={[cut, ...rules]} onSave={onSave} />);
    const row = id("proposal-change");
    expect(row.getAttribute("data-typed")).toBe("true");
    const share = within(row).getByLabelText(en["d6Governance.field.streamerShare"]) as HTMLInputElement;
    expect(share.value).toBe("90");
    // The JSON is mounted (the harness can open it) but hidden until "Edit as JSON".
    const json = id("proposal-change-value") as HTMLTextAreaElement;
    expect(json.closest("[hidden]")).not.toBeNull();
    fireEvent.change(share, { target: { value: "85" } });
    expect(JSON.parse(json.value)).toEqual({ streamerShare: 0.85, coopShare: 0.15 });
    const preview = id("proposal-change-preview");
    expect(preview.textContent).toContain("Creators keep 90% · co-op 10%");
    expect(preview.textContent).toContain("Creators keep 85% · co-op 15%");
    expect(row.textContent).toContain(en["d6Governance.form.complement"]);
    fireEvent.click(id("proposal-save"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [{ key: "platform.cut", value: { streamerShare: 0.85, coopShare: 0.15 } }] }),
    );
  });

  it("an out-of-range value: no error while typing, the error after blur, and save shows it", () => {
    const onSave = vi.fn<(input: unknown) => void>();
    wrap(<StatefulForm initial={draft("platform.cut", cut.value)} list={[cut, ...rules]} onSave={onSave} />);
    const share = within(id("proposal-change")).getByLabelText(en["d6Governance.field.streamerShare"]);
    fireEvent.change(share, { target: { value: "120" } });
    expect(id("proposal-change").textContent).not.toContain("Use 100% or less.");
    expect(id("proposal-save").getAttribute("data-valid")).toBe("false");
    fireEvent.blur(share);
    expect(id("proposal-change").textContent).toContain("Use 100% or less.");
    fireEvent.click(id("proposal-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(id("proposal-form-problems")).toBeTruthy();
  });

  it("text that is not a number says so after blur", () => {
    wrap(<StatefulForm initial={draft("platform.cut", cut.value)} list={[cut, ...rules]} onSave={noop} />);
    const share = within(id("proposal-change")).getByLabelText(en["d6Governance.field.streamerShare"]);
    fireEvent.change(share, { target: { value: "" } });
    fireEvent.blur(share);
    expect(id("proposal-change").textContent).toContain(en["d6Governance.form.error.notNumber"]);
    expect(id("proposal-change").getAttribute("data-typed")).toBe("true");
  });

  it("an amount that does not parse blocks the save, though the JSON keeps its last good value", () => {
    const payout: SettingDto = {
      ...cut,
      key: "payout.rules",
      protected: false,
      value: { minimumCents: 2500, schedule: "monthly", holdDays: 7, currency: "usd" },
    };
    const onSave = vi.fn<(input: unknown) => void>();
    wrap(<StatefulForm initial={draft("payout.rules", payout.value)} list={[payout]} onSave={onSave} />);
    const minimum = within(id("proposal-change")).getByLabelText(
      en["d6Governance.field.payoutMinimum"],
    ) as HTMLInputElement;
    expect(id("proposal-save").getAttribute("data-valid")).toBe("true");
    for (const text of ["", "abc", "1.234"]) {
      fireEvent.change(minimum, { target: { value: text } });
      expect(JSON.parse((id("proposal-change-value") as HTMLTextAreaElement).value).minimumCents).toBe(2500);
      expect(id("proposal-save").getAttribute("data-valid"), text).toBe("false");
      fireEvent.click(id("proposal-save"));
      expect(onSave).not.toHaveBeenCalled();
      expect(id("proposal-form-problems")).toBeTruthy();
    }
    // A good amount saves again, with the new value.
    fireEvent.change(minimum, { target: { value: "30" } });
    expect(id("proposal-save").getAttribute("data-valid")).toBe("true");
    fireEvent.click(id("proposal-save"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ key: "payout.rules", value: expect.objectContaining({ minimumCents: 3000 }) }],
      }),
    );
  });

  it("removing a row whose amount does not parse unblocks the save", () => {
    const payout: SettingDto = {
      ...cut,
      key: "payout.rules",
      protected: false,
      value: { minimumCents: 2500, schedule: "monthly", holdDays: 7, currency: "usd" },
    };
    const onSave = vi.fn<(input: unknown) => void>();
    const initial = draft("payout.rules", payout.value);
    wrap(
      <StatefulForm
        initial={{
          ...initial,
          rows: [...initial.rows, { id: "r2", key: "platform.cut", value: JSON.stringify(cut.value) }],
        }}
        list={[payout, cut]}
        onSave={onSave}
      />,
    );
    const [payoutRow] = all("proposal-change");
    fireEvent.change(within(payoutRow!).getByLabelText(en["d6Governance.field.payoutMinimum"]), {
      target: { value: "" },
    });
    expect(id("proposal-save").getAttribute("data-valid")).toBe("false");
    fireEvent.click(within(payoutRow!).getByTestId("proposal-change-remove"));
    expect(id("proposal-save").getAttribute("data-valid")).toBe("true");
  });

  it("periods are an amount in their unit, stored as seconds", () => {
    const ordinary = rules[0]!;
    wrap(<StatefulForm initial={draft("governance.ordinary", ordinary.value)} list={rules} onSave={noop} />);
    const voting = within(id("proposal-change")).getByLabelText(en["d6Governance.field.voting"]) as HTMLInputElement;
    expect(voting.value).toBe("7");
    fireEvent.change(voting, { target: { value: "10" } });
    expect(JSON.parse((id("proposal-change-value") as HTMLTextAreaElement).value)).toMatchObject({
      votingSeconds: 864_000,
    });
    const quorum = within(id("proposal-change")).getByLabelText(en["d6Governance.field.quorum"]) as HTMLInputElement;
    expect(quorum.value).toBe("10");
    expect(id("proposal-change-preview").textContent).toContain("10-day vote");
  });

  it("Edit as JSON opens the raw value; editing it there updates the fields", () => {
    wrap(<StatefulForm initial={draft("platform.cut", cut.value)} list={[cut, ...rules]} onSave={noop} />);
    const trigger = id("proposal-change-advanced");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const json = id("proposal-change-value");
    expect(json.closest("[hidden]")).toBeNull();
    fireEvent.change(json, { target: { value: '{"streamerShare":0.8,"coopShare":0.2}' } });
    const share = within(id("proposal-change")).getByLabelText(
      en["d6Governance.field.streamerShare"],
    ) as HTMLInputElement;
    expect(share.value).toBe("80");
  });

  it("an unknown key, or a value in another shape, is edited as JSON directly", () => {
    const other: SettingDto = { ...rules[0]!, key: "brand.new", value: { level: 1 } };
    wrap(<StatefulForm initial={draft("brand.new", { level: 2 })} list={[other]} onSave={noop} />);
    expect(id("proposal-change").getAttribute("data-typed")).toBe("false");
    expect(all("proposal-change-advanced")).toHaveLength(0);
    expect(id("proposal-change-value").closest("[hidden]")).toBeNull();
    expect(id("proposal-change-preview").textContent).toContain("level: 2");
    cleanup();
    wrap(<StatefulForm initial={draft("platform.cut", 0.9)} list={[cut]} onSave={noop} />);
    expect(id("proposal-change").getAttribute("data-typed")).toBe("false");
    expect(id("proposal-change").textContent).toContain(en["d6Governance.form.jsonFallback"]);
  });

  it("choosing a setting labels it in words and starts from its current value", () => {
    wrap(
      <StatefulForm
        initial={{
          title: "Change a setting",
          body: "Because.",
          affectsCreators: false,
          rows: [{ id: "r1", key: "", value: "" }],
        }}
        list={[cut, ...rules]}
        onSave={noop}
      />,
    );
    fireEvent.click(id("proposal-change-key"));
    const option = screen.getByTestId("proposal-change-key-platform.cut");
    expect(option.textContent).toContain("Creator share of revenue");
    fireEvent.click(option);
    expect(id("proposal-change").getAttribute("data-key")).toBe("platform.cut");
    expect(JSON.parse((id("proposal-change-value") as HTMLTextAreaElement).value)).toEqual(cut.value);
  });
});

function members(count: number): CouncilDto["members"] {
  return Array.from({ length: count }, (_, i) => ({
    user: { id: `u${i}`, username: `streamer${i}`, displayName: `Streamer ${i}` },
    rank: i + 1,
    contributionScore: 0.05,
  }));
}

describe("/coop/council with people on it", () => {
  const big: CouncilDto = {
    ...council,
    members: members(14),
    method: {
      size: 14,
      eligibilityWindowDays: 90,
      minStreamingHours: 10,
      weights: { revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 },
      totals: { revenueCents: 50_000, eligibleHours: 900, relayBytes: 1e9, viewerHours: 4_000 },
      eligible: 20,
      candidates: 31,
    },
  };

  it("the top 12 as tiles linked to their channels, then Show all; a contribution share, not a score", () => {
    wrap(<CouncilPage council={big} board={board} elections={[]} />);
    // Every seat is in the DOM (the harness reads them all); past the top 12 they are hidden.
    const tiles = all("council-member");
    expect(tiles).toHaveLength(14);
    expect(tiles.map((t) => t.getAttribute("data-user-id"))).toEqual(members(14).map((m) => m.user.id));
    expect(tiles.filter((t) => !t.hidden)).toHaveLength(12);
    expect(tiles.slice(12).every((t) => t.hidden)).toBe(true);
    expect(tiles[0]?.getAttribute("data-rank")).toBe("1");
    expect(tiles[0]?.getAttribute("data-score")).toBe("0.05");
    expect(within(tiles[0]!).getByRole("link").getAttribute("href")).toBe("/streamer0");
    expect(tiles[0]?.textContent).toContain("5% of contribution");
    expect(id("council").textContent).not.toContain("score");
    const more = id("council-show-all");
    expect(more.textContent).toBe("Show all 14");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(all("council-member").filter((t) => !t.hidden)).toHaveLength(14);
    expect(more.textContent).toBe(en["d6Governance.council.showFewer"]);
    expect(within(id("board-seat")).getByRole("link").getAttribute("href")).toBe("/ohmslaw");
  });

  it("How seating works in sentences", () => {
    wrap(<CouncilPage council={big} board={[]} elections={[]} />);
    const method = id("council-method");
    expect(method.textContent).toContain(
      "The 14 seats go to the streamers who contributed most over the last 90 days.",
    );
    expect(method.textContent).toContain("needs 10 streaming hours");
    expect(method.textContent).toContain(
      "revenue (50%), streaming hours (20%), relay bandwidth (20%) and viewer hours (10%)",
    );
    expect(method.textContent).toContain("This term, 20 of 31 streamers were eligible.");
    expect(method.textContent).not.toMatch(/[{}]/);
  });

  it("an open election comes first, with its countdown and, signed out, the member CTA", () => {
    atNow();
    wrap(<CouncilPage council={big} board={board} elections={elections} />);
    {
      const section = id("council-elections");
      expect(section.getAttribute("data-open")).toBe("true");
      const councilHeading = screen.getByRole("heading", { name: en["coop.council.title"] });
      expect(section.compareDocumentPosition(councilHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(id("election-deadline").textContent).toBe("Nominations close tomorrow");
      expect(id("election-join").getAttribute("href")).toBe("/coop/membership");
    }
  });

  it("no open election: elections after the council; a member of another class gets Become a member", () => {
    const closed = [{ ...elections[0]!, status: "closed" as const }];
    wrap(<CouncilPage council={big} board={board} elections={closed} meId={ME} classes={[]} />);
    expect(id("council-elections").getAttribute("data-open")).toBe("false");
    expect(all("election-deadline")).toHaveLength(0);
    expect(all("election-join")).toHaveLength(0);
    cleanup();
    wrap(<CouncilPage council={big} board={board} elections={elections} meId={OTHER} classes={["streamer"]} />);
    expect(id("election-join").textContent).toBe(en["d6Governance.election.becomeMember"]);
  });
});

describe("/coop council preview", () => {
  it("the top five, linked to their channels, with their share", () => {
    wrap(
      <CoopOverview
        signedIn={false}
        membership={null}
        openProposals={[]}
        council={{
          ...council,
          members: members(8),
          method: {
            weights: { revenue: 1, streamingHours: 0, relayBandwidth: 0, viewerHours: 0 },
            totals: { revenueCents: 100, eligibleHours: 10, relayBytes: 0, viewerHours: 0 },
          },
        }}
        months={[]}
      />,
    );
    const rows = all("coop-council-member");
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByRole("link").getAttribute("href")).toBe("/streamer0");
    expect(rows[0]?.textContent).toContain("Rank 1 · 5% of contribution");
    expect(id("coop-council-all").textContent).toBe("Show all 8");
  });
});
