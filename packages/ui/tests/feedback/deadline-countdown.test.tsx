// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DeadlineCountdown, deadlineTone } from "../../src/blocks/feedback/index.ts";

afterEach(cleanup);

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");

describe("deadlineTone", () => {
  test.each([
    [NOW + 5 * HOUR, "info"],
    [NOW + HOUR, "warning"],
    [NOW + 1, "warning"],
    [NOW, "danger"],
    [NOW - HOUR, "danger"],
  ] as const)("deadline %s → %s", (deadline, tone) => {
    expect(deadlineTone(deadline, NOW, HOUR)).toBe(tone);
  });
});

describe("DeadlineCountdown", () => {
  test("due: info badge with the due label and a <time> of the deadline", () => {
    render(
      <DeadlineCountdown
        deadline="2026-10-22T12:00:00.000Z"
        now={NOW}
        dueLabel="Due"
        overdueLabel="Overdue"
        data-testid="d"
      />,
    );
    const el = screen.getByTestId("d");
    expect(el.getAttribute("data-tone")).toBe("info");
    expect(el.textContent).toContain("Due");
    expect(el.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-22T12:00:00.000Z");
  });

  test("near: warning; passed: danger with the overdue label", () => {
    const { rerender } = render(
      <DeadlineCountdown
        deadline={NOW + 10 * 60_000}
        now={NOW}
        warnWithinMs={HOUR}
        dueLabel="Due"
        overdueLabel="Overdue"
        data-testid="d"
      />,
    );
    expect(screen.getByTestId("d").getAttribute("data-tone")).toBe("warning");
    rerender(<DeadlineCountdown deadline={NOW - 1} now={NOW} dueLabel="Due" overdueLabel="Overdue" data-testid="d" />);
    expect(screen.getByTestId("d").getAttribute("data-tone")).toBe("danger");
    expect(screen.getByTestId("d").textContent).toContain("Overdue");
  });
});
