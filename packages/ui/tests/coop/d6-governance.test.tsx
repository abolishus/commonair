// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 4 (D6.2, D6.3) co-op blocks: the threshold bar, the setting change in words, the
 * neutral lock, ProposalCard v2, the seat grid, and the whole-row links of governance lists.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  ChangeArrow,
  GovernanceOutcomeList,
  ProposalKindBadge,
  ProposalRow,
  ProtectedBadge,
  SeatGrid,
  SettingChangeView,
  StatementList,
  ThresholdBar,
} from "../../src/blocks/coop/index.ts";

afterEach(cleanup);

const labels = {
  to: "to",
  none: "not set",
  technical: "Technical details",
  currentValue: "Current value",
  proposedValue: "Proposed value",
  key: "Setting key",
};

describe("ThresholdBar", () => {
  test("draws the share and the tick as geometry, says both in words, hides the drawing", () => {
    render(
      <ThresholdBar
        data-testid="bar"
        label="Turnout"
        value={0.31}
        threshold={0.1}
        valueText="31%"
        thresholdText="10% needed"
      />,
    );
    const bar = screen.getByTestId("bar");
    expect(bar.getAttribute("data-value")).toBe("0.31");
    expect(bar.getAttribute("data-threshold")).toBe("0.1");
    expect(bar.textContent).toBe("Turnout31%10% needed");
    const svg = bar.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const [, fill] = svg.querySelectorAll("rect");
    expect(fill?.getAttribute("width")).toBe("31");
    expect(svg.querySelector('[data-slot="threshold-tick"]')?.getAttribute("x1")).toBe("10");
    expect(bar.outerHTML).not.toContain("style=");
  });

  test("clamps out-of-range values, no tick without a threshold, tones by result", () => {
    render(<ThresholdBar data-testid="bar" label="Yes" value={1.4} valueText="x" tone="danger" />);
    const bar = screen.getByTestId("bar");
    expect(bar.getAttribute("data-value")).toBe("1");
    expect(bar.getAttribute("data-threshold")).toBe("");
    expect(bar.querySelector('[data-slot="threshold-tick"]')).toBeNull();
    expect(bar.querySelectorAll("rect")[1]?.getAttribute("class")).toContain("fill-destructive");
    cleanup();
    render(<ThresholdBar data-testid="bar" label="Yes" value={Number.NaN} threshold={-1} valueText="x" />);
    expect(screen.getByTestId("bar").getAttribute("data-value")).toBe("0");
    expect(screen.getByTestId("bar").querySelector('[data-slot="threshold-tick"]')?.getAttribute("x1")).toBe("0");
  });
});

describe("the lock", () => {
  test("ProtectedBadge and the protected kind badge are neutral, with the lock icon and the word", () => {
    render(
      <>
        <ProtectedBadge data-testid="lock" label="Protected" />
        <ProposalKindBadge data-testid="kind" kind="protected" label="Protected decision" />
      </>,
    );
    for (const el of [screen.getByTestId("lock"), screen.getByTestId("kind")]) {
      expect(el.className).toContain("bg-muted");
      expect(el.className).not.toContain("warning");
      expect(el.className).not.toContain("brand");
      expect(el.querySelector("svg")).not.toBeNull();
    }
    expect(screen.getByTestId("lock").textContent).toBe("Protected");
  });
});

describe("SettingChangeView", () => {
  test("before → after in words, changed fields marked, the JSON behind a disclosure", () => {
    render(
      <SettingChangeView
        data-testid="change"
        settingKey="platform.cut"
        title="Creator share of revenue"
        fromSummary="Creators keep 90%"
        toSummary="Creators keep 85%"
        fields={[{ id: "streamerShare", label: "Creator share", from: "90%", to: "85%" }]}
        protectedLabel="Protected"
        from={{ streamerShare: 0.9 }}
        to={{ streamerShare: 0.85 }}
        labels={labels}
      />,
    );
    const change = screen.getByTestId("change");
    expect(change.textContent).toContain("Creator share of revenue");
    expect(change.textContent).toContain("Protected");
    expect([...change.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Creators keep 85%", "85%"]);
    expect(change.querySelector('[data-field="streamerShare"]')?.textContent).toBe("Creator share90%to85%");
    expect(change.textContent).not.toContain("0.85");
    const trigger = within(change).getByRole("button", { name: "Technical details" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(change.textContent).toContain('"streamerShare": 0.85');
    expect(change.textContent).toContain("Setting key platform.cut");
  });

  test("a missing side reads 'not set'; a note shows under the fields", () => {
    render(<ChangeArrow from={null} to="10%" labels={labels} />);
    expect(document.body.textContent).toBe("not setto10%");
    cleanup();
    render(
      <SettingChangeView
        data-testid="change"
        settingKey="x"
        title="x"
        fromSummary="a"
        toSummary="b"
        fields={[]}
        note="Other technical fields change too."
        from={1}
        to={2}
        labels={labels}
      />,
    );
    expect(screen.getByTestId("change").textContent).toContain("Other technical fields change too.");
    expect(screen.getByTestId("change").querySelector("ul")).toBeNull();
  });
});

describe("ProposalRow", () => {
  test("one link over the whole card; author, tags, next step, participation and result", () => {
    render(
      <ProposalRow
        data-testid="row"
        title="Lower the share price"
        link={{ href: "/coop/proposals/p1" }}
        excerpt="Cut the share from $5 to $3."
        author={{ name: "Rosa Sings", label: "Proposed by Rosa Sings" }}
        status="Voting"
        protectedLabel="Protected"
        affectsCreatorsLabel="Affects creators"
        canVoteLabel="You can vote"
        next="Voting closes in 6 days"
        participation={<span data-testid="bar">bar</span>}
        result={{ passed: false, label: "Rejected", rule: "31% yes of 67% needed" }}
        headingLevel={2}
      />,
    );
    const row = screen.getByTestId("row");
    const links = within(row).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/coop/proposals/p1");
    expect(links[0]?.className).toContain("after:inset-0");
    expect(row.className).toContain("relative");
    expect(within(row).getByRole("heading", { level: 2 }).textContent).toBe("Lower the share price");
    for (const text of [
      "Proposed by Rosa Sings",
      "Cut the share from $5 to $3.",
      "Protected",
      "Affects creators",
      "You can vote",
      "Voting closes in 6 days",
      "Rejected",
      "31% yes of 67% needed",
    ])
      expect(row.textContent).toContain(text);
    expect(within(row).getByTestId("bar")).toBeTruthy();
    expect(row.querySelector('[data-slot="proposal-result"]')?.className).toContain("destructive");
  });

  test("a bare card: no tags row, no result", () => {
    render(
      <ProposalRow
        data-testid="row"
        title="T"
        link={{ href: "/x" }}
        author={{ name: "A", label: "Proposed by A" }}
        status="Draft"
      />,
    );
    const row = screen.getByTestId("row");
    expect(row.querySelector('[data-slot="proposal-result"]')).toBeNull();
    expect(row.querySelector('[data-slot="protected-badge"]')).toBeNull();
  });
});

describe("SeatGrid", () => {
  const items = [
    {
      userId: "u1",
      name: "Aurora",
      link: { href: "/aurora" },
      eyebrow: "Rank 1",
      meta: "4.1% of contribution",
      attributes: { "data-rank": 1 },
    },
    { userId: "u2", name: "Noor", link: { href: "/noor" }, meta: "Viewer seat" },
  ];

  test("each tile is one link to the channel, with its rank and share", () => {
    render(<SeatGrid label="Creator council" items={items} itemProps={{ "data-testid": "seat" }} />);
    const list = screen.getByRole("list", { name: "Creator council" });
    expect(list.className).toContain("grid-cols-2");
    const seats = screen.getAllByTestId("seat");
    expect(seats.map((s) => [s.getAttribute("data-user-id"), s.getAttribute("data-rank")])).toEqual([
      ["u1", "1"],
      ["u2", null],
    ]);
    expect(within(seats[0]!).getAllByRole("link")).toHaveLength(1);
    expect(within(seats[0]!).getByRole("link").getAttribute("href")).toBe("/aurora");
    expect(seats[0]?.textContent).toContain("Rank 1");
    expect(seats[0]?.textContent).toContain("4.1% of contribution");
  });

  test("rows layout for asides", () => {
    render(<SeatGrid label="Board" items={items} layout="rows" />);
    expect(screen.getByRole("list", { name: "Board" }).className).toContain("flex-col");
  });

  test("a hidden seat stays in the DOM with its data, out of the accessible list", () => {
    render(
      <SeatGrid
        label="Creator council"
        items={[items[0]!, { ...items[1]!, hidden: true }]}
        itemProps={{ "data-testid": "seat" }}
      />,
    );
    const seats = screen.getAllByTestId("seat");
    expect(seats.map((s) => [s.getAttribute("data-user-id"), s.hidden])).toEqual([
      ["u1", false],
      ["u2", true],
    ]);
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/aurora"]);
  });
});

describe("whole-row governance lists", () => {
  test("a decided proposal row and a statement row are each one stretched link", () => {
    render(
      <>
        <GovernanceOutcomeList
          label="Decisions"
          items={[
            {
              proposalId: "p1",
              title: "Publish the budget",
              link: { href: "/coop/proposals/p1" },
              status: "passed",
              kind: "protected",
              protectedLabel: "Protected",
              passed: true,
              outcomeLabel: "Passed",
              month: "2026-10",
            },
          ]}
        />
        <StatementList
          title="Statements"
          items={[
            {
              periodId: "s1",
              title: "October",
              status: "approved",
              statusLabel: "Approved",
              amount: { cents: 100, currency: "usd" },
              link: { href: "/coop/patronage/s1" },
            },
          ]}
          empty={null}
          locale="en"
        />
      </>,
    );
    for (const href of ["/coop/proposals/p1", "/coop/patronage/s1"]) {
      const link = screen.getAllByRole("link").find((l) => l.getAttribute("href") === href)!;
      expect(link.className).toContain("after:absolute");
      expect(link.className).toContain("focus-visible:after:ring-2");
    }
    const lock = document.querySelector('[data-slot="protected-badge"]');
    expect(lock?.className).toContain("bg-muted");
  });
});
