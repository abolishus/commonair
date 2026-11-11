// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** d5-money: the SVG BarChart (daily bars, ghost bars, ticks, table fallback) and StatCard's destructive tone. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BarChart, StatCard, barTicks, labelIndexes, type BarDatum } from "../../src/blocks/data/index.ts";

afterEach(cleanup);

const days: BarDatum[] = [
  { key: "2026-11-01", label: "Nov 1", value: 3, previous: 1 },
  { key: "2026-11-02", label: "Nov 2", value: 0, previous: 2 },
  { key: "2026-11-03", label: "Nov 3", value: 7 },
];

describe("barTicks", () => {
  test("whole-number ticks for counts, never 0.25 of a viewer", () => {
    expect(barTicks([0, 1])).toEqual([0, 1]);
    expect(barTicks([3, 7])).toEqual([0, 2, 4, 6, 8]);
    expect(barTicks([0.1, 0.2])).toEqual([0, 1]);
  });

  test("at most one decimal for hours", () => {
    expect(barTicks([0.025, 0.1], { maxDecimals: 1 })).toEqual([0, 0.1]);
    expect(barTicks([0.3, 0.7], { maxDecimals: 1 })).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    for (const tick of barTicks([0.013, 1.37], { maxDecimals: 1 })) expect(Math.round(tick * 10)).toBe(tick * 10);
  });

  test("a minimum step (whole currency units in cents) and big values on a 1-2-5 step", () => {
    expect(barTicks([85], { minStep: 100 })).toEqual([0, 100]);
    expect(barTicks([12_345], { minStep: 100 })).toEqual([0, 5_000, 10_000, 15_000]);
  });

  test("negative values (a refund day) get a zero line inside the range", () => {
    const ticks = barTicks([-180, 900]);
    expect(ticks[0]).toBeLessThan(0);
    expect(ticks).toContain(0);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(900);
  });

  test("all zeros, empty and non-finite input still give an axis", () => {
    expect(barTicks([0, 0])).toEqual([0, 1]);
    expect(barTicks([])).toEqual([0, 1]);
    expect(barTicks([Number.NaN, 2])).toEqual([0, 1, 2]);
  });
});

describe("labelIndexes", () => {
  test("every label when they fit; thinned with the first and last kept otherwise", () => {
    expect([...labelIndexes(3, 7)]).toEqual([0, 1, 2]);
    const thirty = labelIndexes(31, 7);
    expect(thirty.size).toBeLessThanOrEqual(7);
    expect(thirty.has(0)).toBe(true);
    expect(thirty.has(30)).toBe(true);
    expect(labelIndexes(0, 7).size).toBe(0);
  });
});

describe("BarChart", () => {
  test("an SVG image with one bar per non-zero day, the axis and day labels hidden from readers", () => {
    const { container } = render(<BarChart data={days} ariaLabel="Verified hours by day" seriesLabel="Hours" />);
    const img = screen.getByRole("img", { name: "Verified hours by day" });
    expect(img.tagName.toLowerCase()).toBe("svg");
    const groups = [...container.querySelectorAll("g[data-key]")];
    expect(groups.map((g) => [g.getAttribute("data-key"), g.getAttribute("data-value")])).toEqual([
      ["2026-11-01", "3"],
      ["2026-11-02", "0"],
      ["2026-11-03", "7"],
    ]);
    // The zero day draws nothing; no ghosts without previousLabel.
    expect(groups.map((g) => g.querySelectorAll("rect").length)).toEqual([1, 0, 1]);
    expect(container.querySelector("rect[data-ghost]")).toBeNull();
    // Every fill is a chart token, never a literal colour.
    for (const rect of container.querySelectorAll("rect")) expect(rect.getAttribute("fill")).toBe("var(--chart-1)");
    expect(container.querySelector("figure")?.getAttribute("data-bars")).toBe("3");
  });

  test("the figures are always in a table: screen-reader only by default", () => {
    const { container } = render(
      <BarChart data={days} ariaLabel="Hours by day" seriesLabel="Hours" formatValue={(v) => `${v} h`} />,
    );
    const table = screen.getByRole("table");
    expect(table.closest(".sr-only")).not.toBeNull();
    expect(within(table).getByText("7 h")).toBeTruthy();
    expect(container.textContent).toContain("Nov 3");
  });

  test("ghost bars for the previous period, named in the legend and the table", () => {
    const { container } = render(
      <BarChart
        data={days}
        ariaLabel="Hours"
        seriesLabel="This period"
        previousLabel="Previous period"
        color="--chart-2"
        table={{ caption: "Hours by day", categoryHeader: "Day", showLabel: "Show as a table" }}
      />,
    );
    const ghosts = [...container.querySelectorAll("rect[data-ghost]")];
    expect(ghosts).toHaveLength(2);
    expect(
      ghosts.every((g) => g.getAttribute("fill") === "var(--chart-2)" && g.getAttribute("fill-opacity") === "0.25"),
    ).toBe(true);
    expect(screen.getByText("Previous period")).toBeTruthy();
    // The visible table opens from its toggle.
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show as a table" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("Day")).toBeTruthy();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Day", "This period", "Previous period"]);
  });

  test("renders on the server the same way (no measuring)", () => {
    const html = renderToString(<BarChart data={days} ariaLabel="Hours" seriesLabel="Hours" locale="en" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('data-key="2026-11-03"');
  });

  test("an empty series still draws an axis", () => {
    render(<BarChart data={[]} ariaLabel="Nothing yet" seriesLabel="Hours" />);
    expect(screen.getByRole("img", { name: "Nothing yet" })).toBeTruthy();
  });
});

test("StatCard destructive tone", () => {
  const { container } = render(<StatCard label="Owed" value="$2.50" tone="destructive" />);
  const card = container.querySelector('[data-tone="destructive"]');
  expect(card?.className).toContain("bg-destructive/10");
});
