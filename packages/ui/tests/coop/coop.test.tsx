// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** E5 co-op compositions: props → DOM, `data-*` pass-through for the spec's test ids, disabled states. */
import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  AppointWorkerForm,
  CouncilRespondForm,
  CouncilResponseCard,
  ElectionCard,
  EligibilityList,
  GovernanceOutcomeList,
  GovernanceSettingsList,
  MembershipList,
  PatronagePeriodsTable,
  PatronageRunForm,
  PatronageRunResult,
  ProposalChangeEditor,
  ProposalChangeSummary,
  ProposalKindBadge,
  SeatList,
  ShareCard,
  ShareInstructions,
  ShareRefundsTable,
  StatementList,
  StatementView,
  TallyTable,
  VotePanel,
  VoteParticipation,
  formatSettingValue,
  proposalStatusTone,
  shareStatusTone,
  parsePatronageSurplus,
  type PatronageRunFormValues,
  type PatronageRunSubmission,
  type ProposalChangeDraft,
} from "../../src/blocks/coop/index.ts";
import { NoteDialog } from "../../src/blocks/forms/index.ts";
import { ListPanel, Timeline } from "../../src/blocks/data/index.ts";
import { FormSection } from "../../src/blocks/forms/index.ts";
import { ConfirmDialog } from "../../src/primitives/confirm-dialog.tsx";
import { TooltipProvider } from "../../src/components/tooltip.tsx";

const usd = (cents: number) => ({ cents, currency: "USD" });
const withTooltips = (node: React.ReactNode) => <TooltipProvider>{node}</TooltipProvider>;
const attr = (el: Element, name: string) => el.getAttribute(name);

const tallyLabels = {
  caption: "Tally",
  scope: "Scope",
  yes: "Yes",
  no: "No",
  abstain: "Abstain",
  eligible: "Eligible",
  turnout: "Turnout",
  checks: "Checks",
  checkPassed: "Met",
  checkFailed: "Not met",
};

describe("TallyTable", () => {
  const rows = [
    { scope: "member_wide", label: "All members", yes: 3, no: 1, abstain: 0, eligible: 4 },
    { scope: "streamer", label: "Streamers", yes: 1, no: 1, abstain: 0, eligible: 2 },
    { scope: "viewer", label: "Viewers", yes: 1, no: 0, abstain: 0, eligible: 1 },
    { scope: "worker", label: "Workers", yes: 1, no: 0, abstain: 0, eligible: 0 },
  ];
  const checks = [
    { rule: "member_wide_quorum", label: "Quorum", detail: "turnout 4/4 (100.00%)", passed: true },
    { rule: "streamer_class_majority", label: "Streamer majority", detail: "1/2", passed: false },
  ];

  test("rows, checks and the outcome carry the spec's data attributes", () => {
    render(
      <TallyTable
        data-testid="tally"
        data-reason="streamer-class majority not met"
        passed={false}
        outcomeLabel="Rejected"
        reason="Streamer-class majority not met"
        rows={rows}
        checks={checks}
        labels={tallyLabels}
        rowProps={{ "data-testid": "tally-row" }}
        checkProps={{ "data-testid": "tally-check" }}
        locale="en-US"
      />,
    );
    const tally = screen.getByTestId("tally");
    expect(attr(tally, "data-passed")).toBe("false");
    expect(attr(tally, "data-reason")).toBe("streamer-class majority not met");
    const tallyRows = screen.getAllByTestId("tally-row");
    expect(tallyRows.map((row) => attr(row, "data-scope"))).toEqual(["member_wide", "streamer", "viewer", "worker"]);
    const streamer = tallyRows[1] as HTMLElement;
    expect([attr(streamer, "data-yes"), attr(streamer, "data-no"), attr(streamer, "data-abstain")]).toEqual([
      "1",
      "1",
      "0",
    ]);
    expect(attr(streamer, "data-eligible")).toBe("2");
    expect(within(streamer).getByText("100%")).toBeTruthy();
    // No electorate: turnout is a dash, never NaN or Infinity.
    expect(within(tallyRows[3] as HTMLElement).getByText("–")).toBeTruthy();
    const tallyChecks = screen.getAllByTestId("tally-check");
    expect(tallyChecks.map((c) => [attr(c, "data-rule"), attr(c, "data-passed")])).toEqual([
      ["member_wide_quorum", "true"],
      ["streamer_class_majority", "false"],
    ]);
    expect(tally.textContent).toContain("Rejected");
    expect(tally.textContent).toContain("Not met");
    expect(screen.getByRole("table")).toBeTruthy();
  });

  test("a passed tally without checks renders no checks heading", () => {
    render(
      <TallyTable data-testid="tally" passed outcomeLabel="Passed" rows={rows} checks={[]} labels={tallyLabels} />,
    );
    expect(attr(screen.getByTestId("tally"), "data-passed")).toBe("true");
    expect(screen.queryByText("Checks")).toBeNull();
  });
});

describe("VoteParticipation and VotePanel (secret ballot)", () => {
  const choices = [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
    { value: "abstain", label: "Abstain" },
  ];

  test("participation shows voted of eligible and nothing else", () => {
    render(
      <VoteParticipation
        data-testid="vote-participation"
        voted={3}
        eligible={12}
        label="Participation"
        valueText="3 of 12 voted"
      />,
    );
    const el = screen.getByTestId("vote-participation");
    expect([attr(el, "data-voted"), attr(el, "data-eligible")]).toEqual(["3", "12"]);
    expect(el.textContent).toBe("Participation3 of 12 voted");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    // No yes/no/abstain counts and no tally attributes.
    expect(el.outerHTML).not.toMatch(/data-(yes|no|abstain)=/);
  });

  test("participation with an empty electorate is 0%, not NaN", () => {
    render(<VoteParticipation data-testid="p" voted={0} eligible={0} label="Participation" valueText="–" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  test("the panel pre-selects my vote, forwards test ids and submits the chosen choice", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(choice: string) => void>();
    render(
      <VotePanel
        data-testid="vote-panel"
        title="Your vote"
        choiceLabel="Your vote"
        choices={choices}
        myVote="yes"
        myVoteText="You voted yes"
        canVote
        submitLabel="Confirm vote"
        onSubmit={onSubmit}
        groupProps={{ "data-testid": "vote-choice" }}
        choiceProps={(value) => ({ "data-testid": `vote-choice-${value}` })}
        submitProps={{ "data-testid": "vote-submit" }}
        participation={
          <VoteParticipation data-testid="vote-participation" voted={1} eligible={4} label="P" valueText="1/4" />
        }
      />,
    );
    const panel = screen.getByTestId("vote-panel");
    expect([attr(panel, "data-my-vote"), attr(panel, "data-can-vote")]).toEqual(["yes", "true"]);
    expect(screen.getByTestId("vote-choice")).toBeTruthy();
    expect(attr(screen.getByTestId("vote-choice-yes"), "aria-checked")).toBe("true");
    expect(panel.textContent).toContain("You voted yes");
    await user.click(screen.getByTestId("vote-choice-no"));
    await user.click(screen.getByTestId("vote-submit"));
    expect(onSubmit).toHaveBeenCalledWith("no");
    expect(panel.outerHTML).not.toMatch(/data-(yes|no|abstain)=/);
  });

  test("without a vote, submit waits for a choice; data-my-vote is empty", () => {
    render(
      <VotePanel
        data-testid="vote-panel"
        title="Your vote"
        choiceLabel="Your vote"
        choices={choices}
        myVote={null}
        canVote
        submitLabel="Confirm vote"
        onSubmit={() => undefined}
        submitProps={{ "data-testid": "vote-submit" }}
      />,
    );
    expect(attr(screen.getByTestId("vote-panel"), "data-my-vote")).toBe("");
    expect((screen.getByTestId("vote-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a member who cannot vote sees why; choices and submit are disabled", () => {
    render(
      <VotePanel
        data-testid="vote-panel"
        title="Your vote"
        choiceLabel="Your vote"
        choices={choices}
        myVote={null}
        canVote={false}
        cannotVoteReason="You were not a member when voting opened."
        submitLabel="Confirm vote"
        onSubmit={() => undefined}
        choiceProps={(value) => ({ "data-testid": `vote-choice-${value}` })}
        submitProps={{ "data-testid": "vote-submit" }}
      />,
    );
    expect(attr(screen.getByTestId("vote-panel"), "data-can-vote")).toBe("false");
    const submit = screen.getByTestId("vote-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const reason = screen.getByText("You were not a member when voting opened.");
    expect(submit.getAttribute("aria-describedby")).toBe(reason.id);
    for (const choice of ["yes", "no", "abstain"]) {
      const radio = screen.getByTestId(`vote-choice-${choice}`);
      expect(radio.hasAttribute("data-disabled") || radio.getAttribute("aria-disabled") === "true").toBe(true);
    }
  });
});

describe("Council response", () => {
  test("the published response carries its stance", () => {
    render(
      <CouncilResponseCard
        data-testid="council-response"
        stance="oppose"
        stanceLabel="Opposes"
        title="Creator council"
        body="A temporary cut lands hardest on small channels."
      />,
    );
    const card = screen.getByTestId("council-response");
    expect(attr(card, "data-stance")).toBe("oppose");
    expect(card.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("danger");
  });

  test("the respond form wires stance items, body and submit; submit waits for both", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: { stance: string; body: string }) => void>();
    function Harness(): React.JSX.Element {
      const [stance, setStance] = React.useState("");
      const [body, setBody] = React.useState("");
      return (
        <CouncilRespondForm
          data-testid="council-respond"
          title="Respond for the council"
          stanceLabel="Stance"
          stances={[
            { value: "support", label: "Support" },
            { value: "oppose", label: "Oppose" },
          ]}
          stance={stance}
          onStanceChange={setStance}
          bodyLabel="Response"
          body={body}
          onBodyChange={setBody}
          submitLabel="Publish"
          onSubmit={onSubmit}
          stanceProps={{ "data-testid": "council-respond-stance" }}
          stanceItemProps={(value) => ({ "data-testid": `council-respond-stance-${value}` })}
          bodyProps={{ "data-testid": "council-respond-body" }}
          submitProps={{ "data-testid": "council-respond-submit" }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("council-respond").tagName).toBe("FORM");
    expect(screen.getByTestId("council-respond-stance")).toBeTruthy();
    const submit = screen.getByTestId("council-respond-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.click(screen.getByTestId("council-respond-stance-support"));
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByTestId("council-respond-body"), "  We support it.  ");
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ stance: "support", body: "We support it." });
  });
});

describe("Proposal changes", () => {
  const keyOptions = [
    { value: "discovery.ranking", label: "discovery.ranking", protected: false },
    { value: "platform.cut", label: "platform.cut", protected: true },
  ].map((option) => ({ ...option, "data-testid": `proposal-change-key-${option.value}` }));
  const labels = {
    key: "Setting",
    keyPlaceholder: "Choose a setting",
    value: "New value (JSON)",
    protected: "Protected",
    remove: "Remove change",
    add: "Add a change",
    empty: "No setting changes.",
  };

  test("formatSettingValue pretty-prints JSON and treats undefined as null", () => {
    expect(formatSettingValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatSettingValue(undefined)).toBe("null");
    expect(formatSettingValue("x")).toBe('"x"');
  });

  test("the kind badge carries data-kind and the lock only when protected", () => {
    const { rerender } = render(<ProposalKindBadge data-testid="proposal-kind" kind="protected" label="Protected" />);
    expect(attr(screen.getByTestId("proposal-kind"), "data-kind")).toBe("protected");
    expect(screen.getByTestId("proposal-kind").querySelector("svg")).toBeTruthy();
    rerender(<ProposalKindBadge data-testid="proposal-kind" kind="ordinary" label="Ordinary" />);
    expect(screen.getByTestId("proposal-kind").querySelector("svg")).toBeNull();
  });

  test("editor rows get test ids; data-protected appears once a key is chosen; add/remove/edit report", () => {
    const onRowChange = vi.fn<(id: string, patch: Partial<Omit<ProposalChangeDraft, "id">>) => void>();
    const onRemove = vi.fn<(id: string) => void>();
    const onAdd = vi.fn<() => void>();
    const rows: ProposalChangeDraft[] = [
      { id: "a", key: "", value: "" },
      { id: "b", key: "platform.cut", value: '{"streamerShare":0.85}', error: "Not valid JSON" },
    ];
    render(
      withTooltips(
        <ProposalChangeEditor
          rows={rows}
          keyOptions={keyOptions}
          onRowChange={onRowChange}
          onRemove={onRemove}
          onAdd={onAdd}
          labels={labels}
          kind={{ kind: "protected", label: "Protected decision", props: { "data-testid": "proposal-kind" } }}
          rowProps={{ "data-testid": "proposal-change" }}
          keyTriggerProps={{ "data-testid": "proposal-change-key" }}
          valueProps={{ "data-testid": "proposal-change-value" }}
          removeProps={{ "data-testid": "proposal-change-remove" }}
          addProps={{ "data-testid": "proposal-change-add" }}
        />,
      ),
    );
    const changeRows = screen.getAllByTestId("proposal-change");
    expect(changeRows.map((row) => attr(row, "data-protected"))).toEqual([null, "true"]);
    expect(attr(screen.getByTestId("proposal-kind"), "data-kind")).toBe("protected");
    expect(screen.getAllByTestId("proposal-change-key")).toHaveLength(2);
    expect(screen.getByText("Not valid JSON")).toBeTruthy();
    fireEvent.change(screen.getAllByTestId("proposal-change-value")[0] as HTMLElement, {
      target: { value: "5" },
    });
    expect(onRowChange).toHaveBeenCalledWith("a", { value: "5" });
    fireEvent.click(screen.getAllByTestId("proposal-change-remove")[1] as HTMLElement);
    expect(onRemove).toHaveBeenCalledWith("b");
    expect(screen.getAllByTestId("proposal-change-remove")[0]?.getAttribute("aria-label")).toBe("Remove change 1");
    // Two keys exist and both rows hold one (one blank): add stays enabled until every key is used.
    fireEvent.click(screen.getByTestId("proposal-change-add"));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  test("choosing a key on a blank row sets data-protected and logs no controlled/uncontrolled warning", async () => {
    const user = userEvent.setup();
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    function Harness(): React.JSX.Element {
      const [rows, setRows] = React.useState<ProposalChangeDraft[]>([{ id: "a", key: "", value: "" }]);
      return withTooltips(
        <ProposalChangeEditor
          rows={rows}
          keyOptions={keyOptions}
          onRowChange={(id, patch) => setRows((all) => all.map((row) => (row.id === id ? { ...row, ...patch } : row)))}
          onRemove={() => undefined}
          onAdd={() => undefined}
          labels={labels}
          rowProps={{ "data-testid": "proposal-change" }}
        />,
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("proposal-change").hasAttribute("data-protected")).toBe(false);
    await user.click(screen.getByRole("combobox", { name: "Setting" }));
    await user.click(await screen.findByTestId("proposal-change-key-platform.cut"));
    expect(screen.getByTestId("proposal-change").getAttribute("data-protected")).toBe("true");
    expect(screen.getByTestId("proposal-change").getAttribute("data-key")).toBe("platform.cut");
    expect(errors).toEqual([]);
    error.mockRestore();
  });

  test("add is disabled once every key has a row; an empty editor shows the empty text", () => {
    const { rerender } = render(
      withTooltips(
        <ProposalChangeEditor
          rows={[
            { id: "a", key: "discovery.ranking", value: "{}" },
            { id: "b", key: "platform.cut", value: "{}" },
          ]}
          keyOptions={keyOptions}
          onRowChange={() => undefined}
          onRemove={() => undefined}
          onAdd={() => undefined}
          labels={labels}
          addProps={{ "data-testid": "proposal-change-add" }}
        />,
      ),
    );
    expect((screen.getByTestId("proposal-change-add") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      withTooltips(
        <ProposalChangeEditor
          rows={[]}
          keyOptions={keyOptions}
          onRowChange={() => undefined}
          onRemove={() => undefined}
          onAdd={() => undefined}
          labels={labels}
        />,
      ),
    );
    expect(screen.getByText("No setting changes.")).toBeTruthy();
  });

  test("the summary lists key, from → to and protected", () => {
    render(
      <ProposalChangeSummary
        items={[
          { key: "platform.cut", from: { streamerShare: 0.9 }, to: { streamerShare: 0.85 }, protected: true },
          { key: "discovery.ranking", from: { spotlightSlots: 4 }, to: { spotlightSlots: 5 }, protected: false },
        ]}
        labels={{ from: "Now", to: "Proposed", protected: "Protected" }}
        itemProps={{ "data-testid": "proposal-change-summary" }}
      />,
    );
    const items = screen.getAllByTestId("proposal-change-summary");
    expect(items.map((item) => [attr(item, "data-key"), attr(item, "data-protected")])).toEqual([
      ["platform.cut", "true"],
      ["discovery.ranking", "false"],
    ]);
    expect(items[0]?.textContent).toContain('"streamerShare": 0.85');
  });
});

describe("Membership", () => {
  test("membership rows carry ids, class, status and basis; exit opens a ConfirmDialog with its own test id", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<() => void>();
    render(
      <MembershipList
        label="Your memberships"
        itemProps={{ "data-testid": "membership-row" }}
        items={[
          {
            id: "m1",
            memberClass: "viewer",
            classLabel: "Viewer",
            status: "active",
            statusLabel: "Active",
            basis: "share",
            basisLabel: "By share",
            exit: {
              label: "Leave",
              confirmTitle: "Leave the viewer class?",
              confirmDescription: "Your share will be refunded.",
              destructive: true,
              onConfirm,
              triggerProps: { "data-testid": "membership-exit-viewer" },
              dialogProps: { "data-testid": "membership-exit-confirm" },
            },
          },
          {
            id: "m2",
            memberClass: "streamer",
            classLabel: "Streamer",
            status: "exited",
            statusLabel: "Left",
            basis: "streaming_hours",
            basisLabel: "By streaming hours",
          },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("membership-row");
    expect(rows.map((row) => [attr(row, "data-membership-id"), attr(row, "data-class")])).toEqual([
      ["m1", "viewer"],
      ["m2", "streamer"],
    ]);
    expect([attr(rows[0] as HTMLElement, "data-status"), attr(rows[0] as HTMLElement, "data-basis")]).toEqual([
      "active",
      "share",
    ]);
    expect(screen.queryByTestId("membership-exit-streamer")).toBeNull();
    await user.click(screen.getByTestId("membership-exit-viewer"));
    const dialog = await screen.findByTestId("membership-exit-confirm");
    expect(dialog.textContent).toContain("Your share will be refunded.");
    await user.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  test("eligibility sets every data attribute, empty when there is no basis or progress", () => {
    render(
      <EligibilityList
        itemProps={{ "data-testid": "membership-eligibility" }}
        items={[
          {
            memberClass: "streamer",
            classLabel: "Streamer",
            eligible: true,
            statusLabel: "Eligible",
            basis: "streaming_hours",
            progress: { label: "Streaming hours", have: 24, need: 20, unit: "hours", valueText: "24 of 20 h" },
          },
          {
            memberClass: "worker",
            classLabel: "Worker",
            eligible: false,
            statusLabel: "By appointment",
            basis: null,
            progress: null,
            detail: "Workers are appointed by the board.",
          },
        ]}
      />,
    );
    const [streamer, worker] = screen.getAllByTestId("membership-eligibility") as [HTMLElement, HTMLElement];
    expect(
      ["data-class", "data-eligible", "data-basis", "data-have", "data-need", "data-unit"].map((n) =>
        attr(streamer, n),
      ),
    ).toEqual(["streamer", "true", "streaming_hours", "24", "20", "hours"]);
    expect(
      ["data-class", "data-eligible", "data-basis", "data-have", "data-need", "data-unit"].map((n) => attr(worker, n)),
    ).toEqual(["worker", "false", "", "", "", ""]);
    // Over the threshold clamps to a full meter.
    expect(within(streamer).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(within(worker).queryByRole("progressbar")).toBeNull();
  });

  test("share card: none without amount, buy action with its test id, instructions with reference", async () => {
    const user = userEvent.setup();
    const onBuy = vi.fn<() => void>();
    const { rerender } = render(
      <ShareCard
        data-testid="membership-share"
        title="Member share"
        status="none"
        statusLabel="No share"
        amount={null}
        buy={{ label: "Buy the share", onBuy, props: { "data-testid": "membership-buy-share" } }}
      />,
    );
    const card = screen.getByTestId("membership-share");
    expect([attr(card, "data-status"), attr(card, "data-cents")]).toEqual(["none", ""]);
    await user.click(screen.getByTestId("membership-buy-share"));
    expect(onBuy).toHaveBeenCalledOnce();
    rerender(
      <ShareCard
        data-testid="membership-share"
        title="Member share"
        status="pending"
        statusLabel="Waiting for payment"
        amount={usd(2500)}
        locale="en-US"
        instructions={
          <ShareInstructions
            data-testid="membership-share-instructions"
            title="How to pay"
            instructions="Send a bank transfer with the reference."
            amount={usd(2500)}
            amountLabel="Amount"
            reference="CA-7K2M9QXP"
            referenceLabel="Reference"
            copyLabel="Copy"
            copiedLabel="Copied"
            copyFailedLabel="Could not copy"
            paymentId="p1"
            locale="en-US"
          />
        }
      />,
    );
    expect(attr(screen.getByTestId("membership-share"), "data-cents")).toBe("2500");
    expect(screen.queryByTestId("membership-buy-share")).toBeNull();
    const instructions = screen.getByTestId("membership-share-instructions");
    expect(["data-reference", "data-payment-id", "data-cents"].map((n) => attr(instructions, n))).toEqual([
      "CA-7K2M9QXP",
      "p1",
      "2500",
    ]);
    expect((screen.getByLabelText("Reference") as HTMLInputElement).value).toBe("CA-7K2M9QXP");
    expect(instructions.textContent).toContain("$25.00");
  });

  test("status tones fall back to neutral", () => {
    expect(shareStatusTone("held")).toBe("success");
    expect(shareStatusTone("unknown")).toBe("neutral");
    expect(proposalStatusTone("rejected")).toBe("danger");
    expect(proposalStatusTone(null)).toBe("neutral");
  });
});

describe("Statements", () => {
  const labels = {
    total: "Your allocation",
    surplus: "Surplus",
    formula: "Formula",
    lines: "How it was computed",
    share: "Share",
    amount: "Amount",
    capApplied: "Cap applied",
    inputs: "Your inputs",
  };

  test("the statement and its lines carry status, cents, share and cap", () => {
    render(
      <StatementView
        data-testid="statement"
        data-period-id="per1"
        data-formula-version="patronage-2026.1"
        title="October 2026"
        status="approved"
        statusLabel="Approved"
        total={usd(1234)}
        surplus={usd(50000)}
        formula="v1"
        labels={labels}
        locale="en-US"
        lineProps={{ "data-testid": "statement-line" }}
        explanationProps={{ "data-testid": "statement-line-explanation" }}
        inputsProps={{ "data-testid": "statement-inputs", "data-hours": 12 }}
        inputs={[{ term: "Streaming hours", value: "12" }]}
        lines={[
          {
            component: "revenue",
            label: "Revenue",
            explanation: "Revenue: $120.00 of $4,000.00 (3.00%) × 50% pool",
            basis: "$120.00 of $4,000.00",
            share: 0.03,
            amount: usd(750),
            capApplied: false,
          },
          {
            component: "viewerHours",
            label: "Viewer hours",
            explanation: "Capped at 20% of the pool",
            basis: "300 of 900 h",
            share: 0.2,
            amount: usd(484),
            capApplied: true,
          },
        ]}
      />,
    );
    const statement = screen.getByTestId("statement");
    expect(["data-status", "data-cents", "data-period-id"].map((n) => attr(statement, n))).toEqual([
      "approved",
      "1234",
      "per1",
    ]);
    const lines = screen.getAllByTestId("statement-line");
    expect(
      lines.map((line) => ["data-component", "data-cents", "data-share", "data-cap-applied"].map((n) => attr(line, n))),
    ).toEqual([
      ["revenue", "750", "0.03", "false"],
      ["viewerHours", "484", "0.2", "true"],
    ]);
    expect(screen.getAllByTestId("statement-line-explanation")[1]?.textContent).toBe("Capped at 20% of the pool");
    expect(within(lines[1] as HTMLElement).getByText("Cap applied")).toBeTruthy();
    expect(lines[0]?.textContent).toContain("Share 3.00%");
    expect(attr(screen.getByTestId("statement-inputs"), "data-hours")).toBe("12");
  });

  test("the list shows items with their data or the empty state", () => {
    const { rerender } = render(
      <StatementList
        data-testid="patronage"
        title="Your statements"
        itemProps={{ "data-testid": "patronage-item" }}
        items={[
          {
            periodId: "per1",
            title: "October 2026",
            status: "approved",
            statusLabel: "Approved",
            amount: usd(1234),
            link: { href: "/coop/patronage/per1" },
          },
        ]}
        empty={<p data-testid="patronage-empty">None</p>}
      />,
    );
    const item = screen.getByTestId("patronage-item");
    expect(["data-period-id", "data-status", "data-cents"].map((n) => attr(item, n))).toEqual([
      "per1",
      "approved",
      "1234",
    ]);
    expect(within(item).getByRole("link", { name: "October 2026" }).getAttribute("href")).toBe("/coop/patronage/per1");
    rerender(
      <StatementList
        data-testid="patronage"
        title="Your statements"
        items={[]}
        empty={<p data-testid="patronage-empty">None</p>}
      />,
    );
    expect(screen.getByTestId("patronage-empty")).toBeTruthy();
  });
});

describe("GovernanceSettingsList", () => {
  test("rows carry key, protected and updated-by; flat objects render as key-value pairs", () => {
    render(
      <GovernanceSettingsList
        itemProps={{ "data-testid": "setting-row" }}
        labels={{ protected: "Protected", seeded: "Seeded", setBy: "Set by" }}
        items={[
          {
            key: "discovery.ranking",
            value: { spotlightSlots: 5 },
            protected: false,
            updatedBy: { proposalId: "p1", label: "proposal #12", link: { href: "/coop/proposals/p1" } },
          },
          { key: "platform.cut", value: [0.9, { a: 1 }], protected: true, updatedBy: null },
        ]}
      />,
    );
    const [ranking, cut] = screen.getAllByTestId("setting-row") as [HTMLElement, HTMLElement];
    expect(["data-key", "data-protected", "data-updated-by"].map((n) => attr(ranking, n))).toEqual([
      "discovery.ranking",
      "false",
      "p1",
    ]);
    expect(["data-key", "data-protected", "data-updated-by"].map((n) => attr(cut, n))).toEqual([
      "platform.cut",
      "true",
      "",
    ]);
    expect(within(ranking).getByRole("link", { name: "proposal #12" })).toBeTruthy();
    expect(ranking.querySelector("dl")).toBeTruthy();
    expect(cut.querySelector("pre")?.textContent).toContain('"a": 1');
    expect(cut.textContent).toContain("Seeded");
  });
});

describe("Patronage admin", () => {
  function RunFormHarness({
    onSubmit,
    currency = "usd",
    locale = "en-US",
  }: {
    onSubmit: (values: PatronageRunSubmission) => void;
    currency?: string;
    locale?: string;
  }): React.JSX.Element {
    const [values, setValues] = React.useState<PatronageRunFormValues>({ start: "", end: "", surplus: "" });
    return (
      <PatronageRunForm
        data-testid="patronage-run-form"
        title="Run patronage"
        currency={currency}
        locale={locale}
        labels={{
          start: "Start (UTC)",
          end: "End (UTC)",
          surplus: "Surplus",
          surplusFormatError: "Not an amount",
          submit: "Compute",
        }}
        values={values}
        onValuesChange={setValues}
        onSubmit={onSubmit}
        startProps={{ "data-testid": "patronage-run-start" }}
        endProps={{ "data-testid": "patronage-run-end" }}
        surplusProps={{ "data-testid": "patronage-run-surplus" }}
        submitProps={{ "data-testid": "patronage-run-submit" }}
      />
    );
  }
  const fillTimes = () => {
    fireEvent.change(screen.getByTestId("patronage-run-start"), { target: { value: "2026-10-01T00:00" } });
    fireEvent.change(screen.getByTestId("patronage-run-end"), { target: { value: "2026-10-21T00:00" } });
  };

  test("run form forwards test ids and submits the surplus as integer cents; submit needs both times", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: PatronageRunSubmission) => void>();
    render(<RunFormHarness onSubmit={onSubmit} />);
    expect(screen.getByTestId("patronage-run-form")).toBeTruthy();
    const submit = screen.getByTestId("patronage-run-submit") as HTMLButtonElement;
    const surplus = screen.getByTestId("patronage-run-surplus");
    expect(submit.disabled).toBe(true);
    fillTimes();
    await user.type(surplus, "12.34");
    expect(attr(surplus, "data-cents")).toBe("1234");
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ start: "2026-10-01T00:00", end: "2026-10-21T00:00", surplusCents: 1234 });
    expect(screen.getByText("USD")).toBeTruthy();
  });

  test("an empty surplus submits null (allocate all retained surplus)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: PatronageRunSubmission) => void>();
    render(<RunFormHarness onSubmit={onSubmit} />);
    fillTimes();
    const surplus = screen.getByTestId("patronage-run-surplus");
    expect(attr(surplus, "data-cents")).toBe("");
    await user.click(screen.getByTestId("patronage-run-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ start: "2026-10-01T00:00", end: "2026-10-21T00:00", surplusCents: null });
  });

  test.each(["abc", "1.005", "-5", "1.2.3"])(
    "invalid surplus %j shows the format error and blocks submit",
    async (text) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn<(values: PatronageRunSubmission) => void>();
      render(<RunFormHarness onSubmit={onSubmit} />);
      fillTimes();
      const surplus = screen.getByTestId("patronage-run-surplus");
      await user.type(surplus, text);
      expect(attr(surplus, "data-cents")).toBe("");
      expect(attr(surplus, "aria-invalid")).toBe("true");
      expect(screen.getByText("Not an amount")).toBeTruthy();
      const submit = screen.getByTestId("patronage-run-submit") as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      fireEvent.submit(screen.getByTestId("patronage-run-form"));
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  test("surplus parsing follows the locale's separators and the currency's minor digits", () => {
    expect(parsePatronageSurplus("1.234,56", "eur", "de-DE")).toBe(123456);
    expect(parsePatronageSurplus("1,50", "eur", "de-DE")).toBe(150);
    expect(parsePatronageSurplus("1,234.5", "usd", "en-US")).toBe(123450);
    expect(parsePatronageSurplus("1500", "jpy", "ja-JP")).toBe(1500);
    expect(parsePatronageSurplus("1.5", "jpy", "ja-JP")).toBeUndefined();
    expect(parsePatronageSurplus("1.234", "kwd", "en-US")).toBe(1234);
    expect(parsePatronageSurplus("  ", "usd", "en-US")).toBeNull();
  });

  test("run result exposes members and cents", () => {
    render(
      <PatronageRunResult
        data-testid="patronage-run-result"
        data-period-id="per1"
        title="Computed"
        members={3}
        total={usd(9000)}
        surplus={usd(9000)}
        labels={{ members: "Members", total: "Allocated", surplus: "Surplus" }}
        locale="en-US"
      />,
    );
    const result = screen.getByTestId("patronage-run-result");
    expect(["data-period-id", "data-members", "data-cents"].map((n) => attr(result, n))).toEqual(["per1", "3", "9000"]);
  });

  const periodLabels = {
    caption: "Patronage periods",
    period: "Period",
    status: "Status",
    members: "Members",
    total: "Total",
    computedBy: "Ran",
    approvedBy: "Approved",
    actions: "Actions",
  };

  test("period rows carry their data; approve is disabled with the reason for the person who ran it", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<() => void>();
    const row = {
      period: "October",
      status: "computed",
      statusLabel: "Computed",
      members: 3,
      total: usd(9000),
      computedBy: { id: "t1", name: "treasurer1" },
      approvedBy: null,
    };
    const approve = {
      label: "Approve",
      confirmTitle: "Approve this run?",
      onConfirm,
      triggerProps: { "data-testid": "patronage-approve" },
    };
    const { rerender } = render(
      <PatronagePeriodsTable
        labels={periodLabels}
        rowProps={{ "data-testid": "patronage-period-row" }}
        rows={[{ ...row, id: "per1", approve: { ...approve, disabledReason: "You ran this period." } }]}
      />,
    );
    const tr = screen.getByTestId("patronage-period-row");
    expect(
      ["data-period-id", "data-status", "data-cents", "data-computed-by", "data-approved-by"].map((n) => attr(tr, n)),
    ).toEqual(["per1", "computed", "9000", "t1", ""]);
    const disabled = screen.getByTestId("patronage-approve");
    expect(disabled.hasAttribute("disabled") || disabled.getAttribute("aria-disabled") === "true").toBe(true);
    expect(disabled.getAttribute("aria-describedby")).toBe(screen.getByText("You ran this period.").id);
    rerender(
      <PatronagePeriodsTable
        labels={periodLabels}
        rowProps={{ "data-testid": "patronage-period-row" }}
        rows={[{ ...row, id: "per1", approve }]}
      />,
    );
    await user.click(screen.getByTestId("patronage-approve"));
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe("Treasury and admin", () => {
  test("share refund rows carry their data; the refund dialog submits the trimmed note", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(note: string) => void>();
    render(
      <ShareRefundsTable
        labels={{
          caption: "Shares",
          member: "Member",
          status: "Status",
          amount: "Amount",
          since: "Since",
          actions: "A",
        }}
        rowProps={{ "data-testid": "treasury-share-row" }}
        locale="en-US"
        rows={[
          {
            id: "s1",
            user: { id: "u1", name: "viewer1" },
            status: "refund_pending",
            statusLabel: "Refund due",
            amount: usd(2500),
            refund: {
              label: "Refund sent",
              title: "Record the refund",
              noteLabel: "Note",
              submitLabel: "Mark sent",
              onSubmit,
              triggerProps: { "data-testid": "treasury-share-refund" },
              noteProps: { "data-testid": "treasury-share-refund-note" },
              submitProps: { "data-testid": "treasury-share-refund-submit" },
            },
          },
          { id: "s2", user: { id: "u2", name: "viewer2" }, status: "held", statusLabel: "Held", amount: usd(2500) },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("treasury-share-row");
    expect(
      ["data-share-id", "data-user-id", "data-status", "data-cents"].map((n) => attr(rows[0] as HTMLElement, n)),
    ).toEqual(["s1", "u1", "refund_pending", "2500"]);
    expect(screen.getAllByTestId("treasury-share-refund")).toHaveLength(1);
    await user.click(screen.getByTestId("treasury-share-refund"));
    await user.type(await screen.findByTestId("treasury-share-refund-note"), "  sent by bank  ");
    await user.click(screen.getByTestId("treasury-share-refund-submit"));
    expect(onSubmit).toHaveBeenCalledWith("sent by bank");
  });

  test("NoteDialog stays open with the error when submit rejects; a required note gates submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(note: string) => Promise<void>>().mockRejectedValue(new Error("x"));
    render(
      <NoteDialog
        trigger={<button type="button">Open</button>}
        title="Refund"
        noteLabel="Note"
        noteRequired
        submitLabel="Send"
        errorText="Could not record it."
        onSubmit={onSubmit}
        submitProps={{ "data-testid": "submit" }}
        noteProps={{ "data-testid": "note" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    const submit = (await screen.findByTestId("submit")) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByTestId("note"), "x");
    await user.click(submit);
    expect(await screen.findByText("Could not record it.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("appoint worker form wires its test ids and trims values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: { username: string; minute: string }) => void>();
    function Harness(): React.JSX.Element {
      const [values, setValues] = React.useState({ username: "", minute: "" });
      return (
        <AppointWorkerForm
          data-testid="admin-coop-form"
          title="Appoint a worker member"
          labels={{ username: "Username", minute: "Board minute", submit: "Appoint" }}
          values={values}
          onValuesChange={setValues}
          onSubmit={onSubmit}
          usernameProps={{ "data-testid": "appoint-worker-username" }}
          minuteProps={{ "data-testid": "appoint-worker-minute" }}
          submitProps={{ "data-testid": "appoint-worker-submit" }}
        />
      );
    }
    render(<Harness />);
    const submit = screen.getByTestId("appoint-worker-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByTestId("appoint-worker-username"), " wren ");
    await user.type(screen.getByTestId("appoint-worker-minute"), "BM-2026-14");
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ username: "wren", minute: "BM-2026-14" });
  });
});

describe("Seats, elections and outcomes", () => {
  test("seat list derives data-user-id, rank, score and class", () => {
    render(
      <SeatList
        label="Council"
        itemProps={{ "data-testid": "council-member" }}
        items={[
          { userId: "u1", name: "rivertide", rank: 1, score: 41.5, description: "Rank 1" },
          { userId: "u2", name: "okonkwo", memberClass: "streamer" },
        ]}
      />,
    );
    const [first, second] = screen.getAllByTestId("council-member") as [HTMLElement, HTMLElement];
    expect(["data-user-id", "data-rank", "data-score"].map((n) => attr(first, n))).toEqual(["u1", "1", "41.5"]);
    expect([attr(second, "data-rank"), attr(second, "data-class")]).toEqual([null, "streamer"]);
    expect(screen.getByRole("list", { name: "Council" })).toBeTruthy();
  });

  test("election card carries id, class and status; elected candidates are marked", () => {
    render(
      <ElectionCard
        data-testid="election-item"
        electionId="e1"
        memberClass="viewer"
        status="closed"
        statusLabel="Closed"
        title="Viewer seat"
        labels={{ candidates: "Candidates", elected: "Elected" }}
        candidates={[
          { userId: "u1", name: "ana", elected: true, votes: "41 votes" },
          { userId: "u2", name: "bo", elected: false },
        ]}
      />,
    );
    const card = screen.getByTestId("election-item");
    expect(["data-election-id", "data-class", "data-status"].map((n) => attr(card, n))).toEqual([
      "e1",
      "viewer",
      "closed",
    ]);
    expect(screen.getAllByText("Elected")).toHaveLength(1);
  });

  test("governance outcomes carry passed (empty when not tallied), kind and month", () => {
    render(
      <GovernanceOutcomeList
        label="Decisions"
        itemProps={{ "data-testid": "transparency-governance" }}
        items={[
          {
            proposalId: "p1",
            title: "Spotlight slots",
            link: { href: "/coop/proposals/p1" },
            status: "applied",
            kind: "ordinary",
            passed: true,
            outcomeLabel: "Passed",
            month: "2026-10",
          },
          {
            proposalId: "p2",
            title: "Platform cut",
            link: { href: "/coop/proposals/p2" },
            status: "rejected",
            kind: "protected",
            protectedLabel: "Protected",
            passed: false,
            outcomeLabel: "Rejected",
            reason: "Streamer-class majority not met",
            month: "2026-10",
          },
          {
            proposalId: "p3",
            title: "Withdrawn",
            link: { href: "/coop/proposals/p3" },
            status: "withdrawn",
            kind: "ordinary",
            passed: null,
            outcomeLabel: "Withdrawn",
            month: "2026-09",
          },
        ]}
      />,
    );
    const items = screen.getAllByTestId("transparency-governance");
    expect(
      items.map((item) =>
        ["data-proposal-id", "data-status", "data-kind", "data-passed", "data-month"].map((n) => attr(item, n)),
      ),
    ).toEqual([
      ["p1", "applied", "ordinary", "true", "2026-10"],
      ["p2", "rejected", "protected", "false", "2026-10"],
      ["p3", "withdrawn", "ordinary", "", "2026-09"],
    ]);
    expect(items[1]?.textContent).toContain("Streamer-class majority not met");
  });
});

describe("Extensions to existing blocks for E5", () => {
  test("Timeline steps take attributes (test id and data-at)", () => {
    render(
      <Timeline
        data-testid="proposal-timeline"
        steps={[
          {
            id: "discussion",
            label: "Discussion",
            state: "done",
            attributes: { "data-testid": "proposal-timeline-discussion", "data-at": "2026-10-01T00:00:00Z" },
          },
          {
            id: "voting",
            label: "Voting",
            state: "upcoming",
            attributes: { "data-testid": "proposal-timeline-voting", "data-at": "" },
          },
        ]}
      />,
    );
    const step = screen.getByTestId("proposal-timeline-discussion");
    expect([attr(step, "data-state"), attr(step, "data-at")]).toEqual(["done", "2026-10-01T00:00:00Z"]);
    expect(attr(screen.getByTestId("proposal-timeline-voting"), "data-at")).toBe("");
  });

  test("ListPanel items take attributes", () => {
    render(
      <ListPanel
        title="Council"
        items={[{ id: "u1", title: "rivertide", attributes: { "data-testid": "coop-council-member", "data-rank": 1 } }]}
      />,
    );
    expect(attr(screen.getByTestId("coop-council-member"), "data-rank")).toBe("1");
  });

  test("FormSection forwards saveProps to the submit button", () => {
    render(
      <FormSection
        title="Proposal"
        actions={{ saveLabel: "Save draft", saveProps: { "data-testid": "proposal-save" } }}
      >
        <span>fields</span>
      </FormSection>,
    );
    expect(screen.getByTestId("proposal-save").getAttribute("type")).toBe("submit");
  });

  test("ConfirmDialog forwards contentProps to the dialog", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<button type="button">Exit</button>}
        title="Leave?"
        onConfirm={() => undefined}
        contentProps={{ "data-testid": "membership-exit-confirm" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Exit" }));
    expect(await screen.findByTestId("membership-exit-confirm")).toBeTruthy();
    expect(screen.getByTestId("confirm-dialog-confirm")).toBeTruthy();
  });
});

describe("co-op compositions SSR and hydration", () => {
  const cases: [string, React.ReactElement][] = [
    [
      "TallyTable",
      <TallyTable
        key="t"
        passed
        outcomeLabel="Passed"
        rows={[{ scope: "member_wide", label: "All", yes: 1, no: 0, abstain: 0, eligible: 1 }]}
        checks={[{ rule: "member_wide_quorum", label: "Quorum", passed: true }]}
        labels={tallyLabels}
        locale="en-US"
      />,
    ],
    [
      "VotePanel",
      <VotePanel
        key="v"
        title="Vote"
        choiceLabel="Vote"
        choices={[{ value: "yes", label: "Yes" }]}
        myVote={null}
        canVote
        submitLabel="Vote"
        onSubmit={() => undefined}
      />,
    ],
    [
      "ShareCard",
      <ShareCard key="s" title="Share" status="held" statusLabel="Held" amount={usd(2500)} locale="en-US" />,
    ],
    [
      "GovernanceSettingsList",
      <GovernanceSettingsList
        key="g"
        labels={{ protected: "P", seeded: "Seeded", setBy: "Set by" }}
        items={[{ key: "a.b", value: { x: 1 }, protected: false, updatedBy: null }]}
      />,
    ],
  ];
  test.each(cases)("%s hydrates without warnings", async (_name, node) => {
    const wrapped = withTooltips(node);
    const container = document.createElement("div");
    container.innerHTML = renderToString(wrapped);
    document.body.append(container);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, wrapped, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    act(() => root?.unmount());
    error.mockRestore();
    container.remove();
  });
});
