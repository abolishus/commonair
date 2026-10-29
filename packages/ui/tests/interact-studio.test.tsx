// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** E8-studio composition: the live tally of a poll or a prediction. */
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { TallyList, tallyPercent, type TallyItem } from "../src/blocks/interact-studio/index.ts";

afterEach(cleanup);

const items: TallyItem[] = [
  {
    id: "a",
    label: "Dust",
    value: 3,
    valueText: "3 votes",
    rowProps: { "data-testid": "row", "data-choice-id": "a", "data-votes": 3 },
  },
  {
    id: "b",
    label: "Mirage",
    value: 1,
    valueText: "1 vote",
    note: "Lost",
    badge: <span>Winner</span>,
    action: <button type="button">Pick</button>,
    rowProps: { "data-testid": "row", "data-choice-id": "b", "data-votes": 1 },
  },
];

describe("tallyPercent", () => {
  test("whole percent of the total, 0 with nothing counted, clamped", () => {
    expect(tallyPercent(1, 3)).toBe(33);
    expect(tallyPercent(2, 3)).toBe(67);
    expect(tallyPercent(0, 0)).toBe(0);
    expect(tallyPercent(5, 0)).toBe(0);
    expect(tallyPercent(-1, 3)).toBe(0);
    expect(tallyPercent(4, 3)).toBe(100);
    expect(tallyPercent(Number.NaN, 3)).toBe(0);
  });
});

describe("TallyList", () => {
  test("a named list with one row per item, its data attributes and its share", () => {
    render(<TallyList label="Poll results" items={items} />);
    const list = screen.getByRole("list", { name: "Poll results" });
    const rows = within(list).getAllByTestId("row");
    expect(rows.map((r) => [r.dataset.choiceId, r.dataset.votes])).toEqual([
      ["a", "3"],
      ["b", "1"],
    ]);
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["75", "25"]);
    expect(bars[0]?.getAttribute("aria-label")).toBe("Dust");
    expect(rows[0]?.textContent).toContain("3 votes");
  });

  test("badge, note and action render only for the item that has them", () => {
    render(<TallyList label="Outcomes" items={items} />);
    const [first, second] = screen.getAllByTestId("row");
    expect(within(first as HTMLElement).queryByRole("button")).toBeNull();
    expect(within(second as HTMLElement).getByRole("button", { name: "Pick" })).toBeTruthy();
    expect(second?.textContent).toContain("Winner");
    expect(second?.textContent).toContain("Lost");
    expect(first?.textContent).not.toContain("Lost");
  });

  test("an empty tally renders an empty list and nothing counted", () => {
    render(<TallyList label="Empty" items={[{ ...items[0]!, value: 0 }]} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  test("renders on the server", () => {
    const html = renderToString(<TallyList label="Poll results" items={items} />);
    expect(html).toContain('data-choice-id="b"');
    expect(html).toContain("Mirage");
  });
});
