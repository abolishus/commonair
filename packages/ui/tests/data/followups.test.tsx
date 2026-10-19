// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** U7 follow-ups to the data blocks: new props, a11y fixes and the ProposalCard composition. */
import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  DataTable,
  KeyValueList,
  Legend,
  ProgressRow,
  ProposalCard,
  StatCard,
  Timeline,
  TrendChart,
  UptimeStrip,
  type DataTableRowSelection,
} from "../../src/blocks/data/index.ts";
import { TooltipProvider } from "../../src/components/tooltip.tsx";

const statusLabels = { ok: "Operational", degraded: "Degraded", outage: "Outage", none: "No data" };
const days = [
  { id: "d1", date: "Oct 17", status: "ok" as const },
  { id: "d2", date: "Oct 18", status: "degraded" as const },
  { id: "d3", date: "Oct 19", status: "outage" as const },
];

describe("UptimeStrip", () => {
  test("is a labelled list of days, each a named, focusable tooltip trigger", () => {
    render(<UptimeStrip days={days} label="API daily status" statusLabels={statusLabels} />);
    const list = screen.getByRole("list", { name: "API daily status" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const triggers = within(list).getAllByRole("button");
    expect(triggers.map((t) => t.getAttribute("aria-label"))).toEqual([
      "Oct 17: Operational",
      "Oct 18: Degraded",
      "Oct 19: Outage",
    ]);
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("keyboard focus reaches every day and opens its tooltip", async () => {
    const user = userEvent.setup();
    render(<UptimeStrip days={days} label="API daily status" statusLabels={statusLabels} />);
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Oct 17: Operational");
    expect(await screen.findByText("Oct 17: Operational", { selector: "[data-slot=tooltip-content]" })).toBeTruthy();
    await user.tab();
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Oct 19: Outage");
  });
});

describe("DataTable selection", () => {
  const columns = [{ id: "name", accessorKey: "name", header: "Name" }];
  const rows = [
    { id: "v1", name: "One" },
    { id: "v2", name: "Two" },
    { id: "v3", name: "Three" },
  ];

  test("defaultRowSelection preselects rows (uncontrolled) and the toolbar sees them", () => {
    const change = vi.fn<(selection: DataTableRowSelection) => void>();
    render(
      <DataTable
        caption="Videos"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        selectable
        selectionLabel="Select video"
        defaultRowSelection={{ v1: true, v3: true }}
        onRowSelectionChange={change}
        selectionToolbar={(selected) => <span>{selected.length} selected</span>}
      />,
    );
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select video 1" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Select video 2" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select video 2" }));
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(change).toHaveBeenLastCalledWith({ v1: true, v2: true, v3: true });
  });

  test("rowSelection is controlled: clicks report but do not change it until the parent does", () => {
    const change = vi.fn<(selection: DataTableRowSelection) => void>();
    const { rerender } = render(
      <DataTable
        caption="Videos"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        selectable
        rowSelection={{ v2: true }}
        onRowSelectionChange={change}
        selectionToolbar={(selected, clear) => (
          <button type="button" onClick={clear}>
            Clear {selected.length}
          </button>
        )}
      />,
    );
    expect(screen.getByRole("button", { name: "Clear 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Videos 1" }));
    expect(change).toHaveBeenLastCalledWith({ v1: true, v2: true });
    expect(screen.getByRole("button", { name: "Clear 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear 1" }));
    expect(change).toHaveBeenLastCalledWith({});
    rerender(
      <DataTable
        caption="Videos"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        selectable
        rowSelection={{}}
        onRowSelectionChange={change}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Videos 2" }).getAttribute("aria-checked")).toBe("false");
  });

  test("a controlled parent with state round-trips selection", () => {
    function Parent(): React.JSX.Element {
      const [selection, setSelection] = React.useState<DataTableRowSelection>({});
      return (
        <>
          <DataTable
            caption="Videos"
            columns={columns}
            rows={rows}
            getRowId={(row) => row.id}
            selectable
            rowSelection={selection}
            onRowSelectionChange={setSelection}
          />
          <output>{Object.keys(selection).join(",")}</output>
        </>
      );
    }
    render(<Parent />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Videos 3" }));
    expect(screen.getByRole("status").textContent).toBe("v3");
  });
});

describe("Legend, TrendChart legend, StatCard footer", () => {
  test("Legend renders key-only items without a value or share", () => {
    render(
      <Legend
        layout="inline"
        aria-label="Legend"
        items={[
          { id: "ok", label: "Operational", color: "--success" },
          { id: "degraded", label: "Degraded", color: "--warning" },
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Legend" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Operational", "Degraded"]);
    expect(items[0]?.getAttribute("data-key-only")).toBe("true");
    const swatch = items[0]?.querySelector("[aria-hidden=true]") as HTMLElement;
    expect(swatch.style.getPropertyValue("--segment-color")).toBe("var(--success)");
  });

  test("Legend still shows value and share for items that carry one, over valued items only", () => {
    render(
      <Legend
        items={[
          { id: "a", label: "A", value: 3 },
          { id: "b", label: "B", value: 1 },
          { id: "k", label: "Key" },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toBe("A3 · 75%");
    expect(items[1]?.textContent).toBe("B1 · 25%");
    expect(items[2]?.textContent).toBe("Key");
  });

  test("TrendChart legend lists the series (top or bottom) and keeps props on the chart", () => {
    const series = [
      { key: "income", label: "Income", color: "--chart-2" as const },
      { key: "expenses", label: "Expenses", color: "--chart-5" as const },
    ];
    const { container, rerender } = render(
      <TrendChart
        data={[{ month: "Jan", income: 1, expenses: 2 }]}
        series={series}
        xKey="month"
        ariaLabel="Income vs expenses"
        legend="top"
        data-testid="chart"
      />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("data-slot")).toBe("trend-chart");
    expect(wrapper.firstElementChild?.tagName).toBe("UL");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Income", "Expenses"]);
    expect(screen.getByTestId("chart").getAttribute("aria-label")).toBe("Income vs expenses");
    rerender(
      <TrendChart
        data={[{ month: "Jan", income: 1, expenses: 2 }]}
        series={series}
        xKey="month"
        ariaLabel="Income vs expenses"
        legend="bottom"
      />,
    );
    expect((container.firstElementChild as HTMLElement).lastElementChild?.tagName).toBe("UL");
    rerender(<TrendChart data={[{ month: "Jan", income: 1 }]} series={series} xKey="month" ariaLabel="No legend" />);
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("StatCard footer renders under the value inside the card", () => {
    render(
      <StatCard
        label="Available balance"
        value="$1,284.60"
        hint="Pays out Nov 1"
        footer={<span>footer content</span>}
        data-testid="stat"
      />,
    );
    const footer = screen.getByTestId("stat").querySelector("[data-slot=stat-card-footer]");
    expect(footer?.textContent).toBe("footer content");
    expect(footer?.closest("[data-slot=card-content]")).toBeTruthy();
  });
});

describe("ProgressRow tone, KeyValueList and Timeline layout", () => {
  test.each([
    ["default", "bg-primary"],
    ["accent", "bg-accent-foreground"],
    ["success", "bg-success"],
    ["warning", "bg-warning"],
    ["danger", "bg-destructive"],
  ] as const)("tone %s colors the indicator itself (%s) with one track", (tone, cls) => {
    const { container } = render(<ProgressRow label="Budget" value={40} valueText="40%" tone={tone} />);
    expect(container.querySelectorAll("[data-slot=progress-track]")).toHaveLength(1);
    const indicator = container.querySelector("[data-slot=progress-indicator]");
    expect(indicator?.className).toContain(cls);
    expect(indicator?.getAttribute("style")).toContain("40%");
    expect(screen.getByRole("progressbar", { name: "Budget" }).getAttribute("aria-valuenow")).toBe("40");
  });

  test("KeyValueList pairs each dt with its dd in a row", () => {
    const { container } = render(
      <KeyValueList
        rows={[
          { term: "Bitrate", value: "6 Mbps" },
          { term: "Dropped frames", value: "0.1%" },
        ]}
      />,
    );
    const rows = container.querySelectorAll("dl > div");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelector("dt")?.textContent).toBe("Dropped frames");
    expect(rows[1]?.querySelector("dd")?.textContent).toBe("0.1%");
  });

  test("Timeline updates and steps render as ordered list rows", () => {
    render(
      <>
        <Timeline
          aria-label="Updates"
          updates={[{ id: "u", status: "Monitoring", time: "19:12", text: "Watching", tone: "warning" }]}
        />
        <Timeline aria-label="Steps" steps={[{ id: "s", label: "Voting", meta: "Oct 24", state: "current" }]} />
      </>,
    );
    expect(within(screen.getByRole("list", { name: "Updates" })).getByText("Watching")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Steps" })).getByText("Oct 24")).toBeTruthy();
  });
});

describe("ProposalCard", () => {
  test("links the title, shows status, protected badge and turnout", () => {
    render(
      <ProposalCard
        reference="#47"
        title="Lower the creator share"
        link={{ href: "#proposal/47" }}
        summary="Fund a second origin region."
        status="Voting"
        protectedLabel="Protected"
        progress={{ label: "Ends Oct 24 · 214 comments", value: 38, valueText: "38% turnout", note: "You voted" }}
        data-testid="proposal"
      />,
    );
    const card = screen.getByTestId("proposal");
    const link = within(card).getByRole("link", { name: "#47 Lower the creator share" });
    expect(link.getAttribute("href")).toBe("#proposal/47");
    expect(within(card).getByRole("heading", { level: 3 }).contains(link)).toBe(true);
    expect(within(card).getByText("Protected")).toBeTruthy();
    expect(within(card).getByText("Voting")).toBeTruthy();
    expect(within(card).getByRole("progressbar", { name: "Ends Oct 24 · 214 comments" })).toBeTruthy();
    expect(within(card).getByText("You voted")).toBeTruthy();
  });

  test("uses a router render element and omits optional parts", () => {
    render(
      <ProposalCard
        title="Adopt bylaws"
        link={{
          render: (
            <a href="/coop/proposals/12" data-router="">
              Adopt bylaws
            </a>
          ),
        }}
        status="Passed"
        statusTone="success"
        headingLevel={2}
      />,
    );
    const link = screen.getByRole("link", { name: "Adopt bylaws" });
    expect(link.getAttribute("data-router")).toBe("");
    expect(screen.getByRole("heading", { level: 2 })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

const ssrCases: [string, React.ReactElement][] = [
  ["UptimeStrip", <UptimeStrip key="u" days={days} label="Uptime" statusLabels={statusLabels} />],
  [
    "DataTable (default selection)",
    <DataTable
      key="d"
      caption="Rows"
      columns={[{ id: "name", accessorKey: "name", header: "Name" }]}
      rows={[{ id: "a", name: "A" }]}
      getRowId={(row) => row.id}
      selectable
      defaultRowSelection={{ a: true }}
    />,
  ],
  ["Legend (key only)", <Legend key="l" items={[{ id: "ok", label: "OK", color: "--success" }]} />],
  [
    "TrendChart (legend)",
    <TrendChart
      key="t"
      data={[{ x: "a", y: 1 }]}
      series={[{ key: "y", label: "Y", color: "--chart-1" }]}
      xKey="x"
      ariaLabel="Trend"
      legend="top"
    />,
  ],
  ["StatCard (footer)", <StatCard key="s" label="Balance" value="1" footer={<span>bar</span>} />],
  ["ProgressRow (tone)", <ProgressRow key="p" label="Goal" value={25} valueText="25%" tone="success" />],
  [
    "ProposalCard",
    <ProposalCard
      key="pc"
      title="Proposal"
      link={{ href: "#p" }}
      status="Voting"
      progress={{ label: "Turnout", value: 10, valueText: "10%" }}
    />,
  ],
];

describe("data follow-ups SSR and hydration", () => {
  test.each(ssrCases)("%s hydrates without warnings", async (_name, node) => {
    const tree = <TooltipProvider>{node}</TooltipProvider>;
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree);
    document.body.append(container);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    act(() => root?.unmount());
    error.mockRestore();
    container.remove();
  });
});
