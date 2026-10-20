// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E4b additions to the data blocks: per-segment legend attributes (BreakdownBar / Legend) and the
 * FilterBar's select test ids, option values and search input props.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";
import { BreakdownBar, FilterBar, Legend } from "../../../src/blocks/data/index.ts";

const sources = [
  {
    id: "subscriptions",
    label: "Subscriptions",
    value: 900,
    attributes: { "data-testid": "source", "data-source": "subscriptions", "data-cents": 900 },
  },
  {
    id: "tips",
    label: "Tips",
    value: 100,
    attributes: { "data-testid": "source", "data-source": "tips", "data-cents": 100 },
  },
];

const months = [
  { value: "2026-10", label: "October 2026" },
  { value: "2026-09", label: "September 2026" },
];

describe("BreakdownBar / Legend segment attributes", () => {
  test("each legend row carries its segment's data attributes", () => {
    render(<BreakdownBar segments={sources} label="By source" formatLabel={() => "Revenue by source"} />);
    const rows = screen.getAllByTestId("source");
    expect(rows.map((row) => row.tagName)).toEqual(["LI", "LI"]);
    expect(rows.map((row) => [row.getAttribute("data-source"), row.getAttribute("data-cents")])).toEqual([
      ["subscriptions", "900"],
      ["tips", "100"],
    ]);
    // The chart keeps its accessible name; the legend stays a list.
    expect(screen.getByRole("img", { name: "Revenue by source" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  test("attributes cannot replace the key-only marker or the row's own key", () => {
    render(
      <Legend
        items={[{ id: "a", label: "Key", attributes: { "data-testid": "key", "data-key-only": "no" } }]}
        layout="inline"
      />,
    );
    expect(screen.getByTestId("key").getAttribute("data-key-only")).toBe("true");
  });

  test("segments without attributes render as before", () => {
    render(<Legend items={[{ id: "a", label: "A", value: 1 }]} />);
    const item = screen.getByRole("listitem");
    expect([...item.attributes].map((a) => a.name)).toEqual(["class"]);
  });
});

describe("FilterBar select and search props", () => {
  test("the trigger takes the filter's test id and shows the selected option's label", () => {
    render(
      <FilterBar
        filters={[
          {
            id: "month",
            label: "Month",
            value: "2026-10",
            options: months,
            onValueChange: () => undefined,
            "data-testid": "month-filter",
          },
        ]}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Month" });
    expect(trigger.getAttribute("data-testid")).toBe("month-filter");
    expect(trigger.textContent).toContain("October 2026");
  });

  test("options carry their value in data-value and picking one reports it", async () => {
    const change = vi.fn<(value: string) => void>();
    render(
      <FilterBar filters={[{ id: "month", label: "Month", value: "2026-10", options: months, onValueChange: change }]} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Month" }));
    const option = await screen.findByRole("option", { name: "September 2026" });
    expect(option.getAttribute("data-value")).toBe("2026-09");
    await user.click(option);
    expect(change).toHaveBeenCalledWith("2026-09");
  });

  test("search input props reach the input; value, onChange and the label stay the bar's", () => {
    const change = vi.fn<(value: string) => void>();
    const searchInputProps = { "data-testid": "search", name: "reference", maxLength: 64 };
    render(
      <FilterBar searchLabel="Reference" searchValue="CA-" onSearchChange={change} searchInputProps={searchInputProps} />,
    );
    const input = screen.getByRole("textbox", { name: "Reference" });
    expect([input.getAttribute("data-testid"), input.getAttribute("name"), input.getAttribute("maxlength")]).toEqual([
      "search",
      "reference",
      "64",
    ]);
    expect((input as HTMLInputElement).value).toBe("CA-");
    fireEvent.change(input, { target: { value: "CA-12" } });
    expect(change).toHaveBeenCalledWith("CA-12");
  });
});

describe("SSR and hydration", () => {
  const cases: [string, React.ReactElement][] = [
    ["BreakdownBar with attributes", <BreakdownBar key="b" segments={sources} label="Share" formatLabel={() => "Share"} />],
    [
      "FilterBar with a select and search props",
      <FilterBar
        key="f"
        searchLabel="Search"
        onSearchChange={() => undefined}
        searchInputProps={{ name: "q" }}
        filters={[
          {
            id: "month",
            label: "Month",
            value: "2026-10",
            options: months,
            onValueChange: () => undefined,
            "data-testid": "month-filter",
          },
        ]}
      />,
    ],
  ];

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
