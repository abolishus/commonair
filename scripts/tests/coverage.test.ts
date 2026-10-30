// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { COVERAGE_ARGS, badge, merge, percent, table } from "../coverage.ts";

const ws = (name: string, covered: number, total: number) => ({ name, lines: { covered, total } });

describe("coverage", () => {
  test("merges line counts across workspaces, not their percentages", () => {
    // 50% of 10 and 100% of 90 is 95%, not the 75% an average of percentages would give.
    const all = merge([ws("a", 5, 10), ws("b", 90, 90)]);
    expect(all).toEqual({ covered: 95, total: 100 });
    expect(percent(all)).toBe(95);
  });

  test("an empty set merges to zero and reads as unknown", () => {
    expect(merge([])).toEqual({ covered: 0, total: 0 });
    expect(percent({ covered: 0, total: 0 })).toBe(0);
    expect(badge({ covered: 0, total: 0 })).toEqual({
      schemaVersion: 1,
      label: "unit coverage",
      message: "unknown",
      color: "lightgrey",
    });
  });

  test("floors to one decimal so a threshold is never rounded up", () => {
    expect(badge({ covered: 8996, total: 10000 }).message).toBe("89.9%");
    expect(badge({ covered: 8996, total: 10000 }).color).toBe("green");
    expect(badge({ covered: 9000, total: 10000 })).toMatchObject({ message: "90%", color: "brightgreen" });
    expect(badge({ covered: 1, total: 1 }).message).toBe("100%");
  });

  test.each([
    [95, "brightgreen"],
    [80, "green"],
    [79.9, "yellowgreen"],
    [70, "yellowgreen"],
    [60, "yellow"],
    [50, "orange"],
    [49.9, "red"],
    [0, "red"],
  ])("%d%% is %s", (p, color) => {
    expect(badge({ covered: p * 10, total: 1000 }).color).toBe(color);
  });

  test("failing tests override the number", () => {
    expect(badge({ covered: 99, total: 100 }, false)).toMatchObject({ message: "tests failing", color: "red" });
  });

  test("the table sorts workspaces, skips empty ones and totals them", () => {
    const md = table([ws("services/chat", 1, 4), ws("infra", 0, 0), ws("packages/ledger", 3, 4)]).split("\n");
    expect(md).toEqual([
      "| Workspace | Lines | Covered / total |",
      "| --- | ---: | ---: |",
      "| packages/ledger | 75.0% | 3 / 4 |",
      "| services/chat | 25.0% | 1 / 4 |",
      "| **all** | **50.0%** | **4 / 8** |",
    ]);
  });

  test("counts every source file, so untested files lower the number", () => {
    expect(COVERAGE_ARGS).toContain("--coverage.include=src/**/*.{ts,tsx}");
    expect(COVERAGE_ARGS).toContain("--coverage.provider=istanbul");
    expect(COVERAGE_ARGS).toContain("--testTimeout=60000");
  });
});
