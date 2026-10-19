// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
/* oxlint-disable react/jsx-key -- Each static element is an independent SSR fixture. */
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";
import * as React from "react";
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
} from "../../src/blocks/data/index.ts";

const segments = [{ id: "one", label: "One", value: 1 }];
const cases: [string, React.ReactElement][] = [
  [
    "StatCard",
    <StatGrid>
      <StatCard label="Members" value="500" />
    </StatGrid>,
  ],
  ["BreakdownBar", <BreakdownBar segments={segments} label="Share" formatLabel={() => "Share"} />],
  ["ProgressRow", <ProgressRow label="Goal" value={25} valueText="25%" />],
  [
    "PollCard",
    <PollCard
      question="Poll?"
      timeLeft="1h"
      totalVotes="5"
      options={[{ id: "one", label: "One", value: 5, percent: 100 }]}
    />,
  ],
  [
    "TrendChart",
    <TrendChart
      data={[{ x: "a", y: 2 }]}
      series={[{ key: "y", label: "Y", color: "--chart-1" }]}
      xKey="x"
      ariaLabel="Trend"
    />,
  ],
  [
    "DataTable",
    <DataTable columns={[{ id: "name", accessorKey: "name", header: "Name" }]} rows={[{ name: "A" }]} caption="Rows" />,
  ],
  ["Timeline", <Timeline steps={[{ id: "a", label: "Step", state: "current" }]} />],
  [
    "UptimeStrip",
    <UptimeStrip
      days={[{ id: "a", date: "Today", status: "ok" }]}
      label="Uptime"
      statusLabels={{ ok: "OK", degraded: "Degraded", outage: "Outage", none: "No data" }}
    />,
  ],
  ["FilterBar", <FilterBar searchLabel="Search" onSearchChange={() => {}} />],
  ["ListPanel", <ListPanel title="Items" items={[{ id: "a", title: "One" }]} />],
  ["KeyValueList", <KeyValueList rows={[{ term: "Status", value: "OK" }]} />],
  ["MetricPanel", <MetricPanel title="Status" value="OK" caption="Today" />],
];

describe("data blocks SSR and hydration", () => {
  test.each(cases)("%s hydrates without warnings", async (_name, node) => {
    const html = renderToString(node);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, node, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    act(() => root?.unmount());
    error.mockRestore();
    container.remove();
  });
});
