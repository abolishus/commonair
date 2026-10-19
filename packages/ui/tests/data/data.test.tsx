// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import {
  BreakdownBar,
  DataTable,
  FilterBar,
  KeyValueList,
  ListPanel,
  MetricPanel,
  PollCard,
  ProgressRow,
  StatCard,
  StatGrid,
  Timeline,
  TrendChart,
  UptimeStrip,
  getSegmentShares,
} from "../../src/blocks/data/index.ts";

const segments = [
  { id: "yes", label: "Yes", value: 2 },
  { id: "no", label: "No", value: 1 },
  { id: "abstain", label: "Abstain", value: 1 },
];
test("breakdown shares sum to one hundred with largest remainder and handle zero totals", () => {
  expect(
    getSegmentShares([
      { id: "a", label: "A", value: 1 },
      { id: "b", label: "B", value: 1 },
      { id: "c", label: "C", value: 1 },
    ]),
  ).toEqual([34, 33, 33]);
  expect(getSegmentShares([{ id: "a", label: "A", value: 0 }])).toEqual([0]);
});
test("stat delta sentiment is independent of direction", () => {
  const { container } = render(
    <StatCard label="Hours" value="12" delta={{ direction: "down", sentiment: "positive", label: "2 fewer" }} />,
  );
  expect(container.querySelector("p")?.className).toContain("text-success");
});
test("progress clamps its underlying percentage", () => {
  const { container } = render(<ProgressRow label="Budget" value={140} valueText="140%" />);
  expect(container.querySelector('[data-slot="progress-indicator"]')?.getAttribute("style")).toContain("100%");
});
test("timeline presents each state accessibly", () => {
  const { container } = render(
    <Timeline
      steps={[
        { id: "a", label: "Done", state: "done" },
        { id: "b", label: "Now", state: "current" },
        { id: "c", label: "Next", state: "upcoming" },
      ]}
    />,
  );
  expect(container.querySelectorAll("li[data-state]")).toHaveLength(3);
});
test("uptime strip exposes a summary label and narrows day count on small screens", () => {
  const days = Array.from({ length: 90 }, (_, i) => ({ id: String(i), date: `Day ${i}`, status: "ok" as const }));
  const { container } = render(
    <UptimeStrip
      days={days}
      label="90 days uptime"
      daysOnMobile={30}
      statusLabels={{ ok: "Operational", degraded: "Degraded", outage: "Outage", none: "No data" }}
    />,
  );
  expect(screen.getByRole("img", { name: "90 days uptime" })).toBeTruthy();
  expect(container.querySelectorAll("[data-status]")).toHaveLength(90);
});
test("data table keeps table headers scoped, row selector data, sort and selection", async () => {
  const columns = [
    { id: "name", accessorKey: "name", header: "Name", enableSorting: true },
    { id: "count", accessorKey: "count", header: "Count", align: "numeric" as const },
  ];
  const { container } = render(
    <DataTable
      columns={columns}
      rows={[
        { id: "a", name: "Alpha", count: 2 },
        { id: "b", name: "Beta", count: 1 },
      ]}
      caption="Streams"
      sortable
      selectable
      selectionToolbar={(selected) => <span>{selected.length} selected</span>}
      rowProps={(row) => ({ "data-relay-id": row.id, "data-status": "active" })}
    />,
  );
  expect(container.querySelector("th")?.getAttribute("scope")).toBe("col");
  expect(container.querySelector("[data-relay-id='a']")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Streams 1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Name/ }));
  expect(within(container).getAllByRole("row")[1]?.textContent).toContain("Alpha");
  fireEvent.click(screen.getByRole("checkbox", { name: "Streams 1" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
});
test("data table renders grouped rows, footer, empty state and loading skeletons", () => {
  const columns = [{ id: "name", accessorKey: "name", header: "Name" }];
  const { rerender, container } = render(
    <DataTable
      caption="Income statement"
      columns={columns}
      rows={[
        { name: "Subscriptions", group: "Money in" },
        { name: "Hosting", group: "Operating expenses" },
      ]}
      groupBy={(row) => row.group}
      footer="Total: $10,000"
    />,
  );
  expect(container.querySelectorAll("[data-group-row]")).toHaveLength(2);
  expect(screen.getByText("Total: $10,000")).toBeTruthy();
  rerender(<DataTable caption="Empty table" columns={columns} rows={[]} empty={<span>Nothing here</span>} />);
  expect(screen.getByText("Nothing here")).toBeTruthy();
  rerender(<DataTable caption="Loading table" columns={columns} rows={[]} loading loadingRows={3} />);
  expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
});
test("sortable data tables do not hide rows behind implicit pagination", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ name: `Stream ${index + 1}` }));
  render(
    <DataTable
      caption="All streams"
      columns={[{ id: "name", accessorKey: "name", header: "Name", enableSorting: true }]}
      rows={rows}
      sortable
    />,
  );
  expect(screen.getByText("Stream 12")).toBeTruthy();
});
test("filter callbacks, list links and charts render with accessible labels", () => {
  const change = vi.fn<(value: string | string[]) => void>();
  render(
    <>
      <FilterBar
        searchLabel="Search"
        onSearchChange={change}
        tags={[{ value: "music", label: "Music" }]}
        onTagsChange={change}
      />
      <ListPanel title="Recent" variant="bare" items={[{ id: "a", title: "Proposal", href: "/proposal" }]} />
      <BreakdownBar segments={segments} label="Vote" formatLabel={() => "Vote breakdown"} />
    </>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "live" } });
  expect(change).toHaveBeenCalledWith("live");
  expect(screen.getByRole("link", { name: /Proposal/ }).getAttribute("href")).toBe("/proposal");
  expect(screen.getByRole("img", { name: "Vote breakdown" })).toBeTruthy();
});
test("remaining data blocks accept fixture values", () => {
  render(
    <>
      <StatGrid cols={2}>
        <StatCard label="Members" value="500" />
      </StatGrid>
      <PollCard
        question="Which?"
        timeLeft="2h"
        totalVotes="12 votes"
        options={[{ id: "a", label: "A", value: 7, percent: 58 }]}
        voted
      />
      <TrendChart
        data={[{ date: "Mon", total: 2 }]}
        series={[{ key: "total", label: "Total", color: "--chart-1" }]}
        xKey="date"
        ariaLabel="Daily trend"
      />
      <KeyValueList rows={[{ term: "Bitrate", value: "6 Mbps" }]} dense />
      <MetricPanel title="Integrity" value="99%" caption="last 90 days" />
    </>,
  );
  expect(screen.getByRole("img", { name: "Daily trend" })).toBeTruthy();
  expect(screen.getByText("Bitrate")).toBeTruthy();
});
