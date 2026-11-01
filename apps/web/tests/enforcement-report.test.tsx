// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The open enforcement report on /transparency (W2-enforcement-report, docs/testing/w2-selectors.md
 * "Enforcement report"): rows per area, suppressed cells as a "fewer than 10" marker, the overturn
 * rate from integer numerator and denominator, the NCII line, and the empty, loading and error
 * states; in dark and light at 320 px.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnforcementFigures,
  EnforcementReport,
  countAttr,
  nciiPending,
  overturnRate,
  tierLabelKey,
  windowOptions,
  type EnforcementReportDto,
  type EnforcementRowDto,
  type LoadEnforcement,
} from "../src/components/transparency/enforcement-report.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>
  );
}
const all = (id: string, root: ParentNode) => [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const one = (id: string, root: ParentNode) => {
  const els = all(id, root);
  expect(els, id).toHaveLength(1);
  return els[0]!;
};

const n = (value: number) => ({ suppressed: false as const, value });
const S = { suppressed: true as const };

const visibleRow: EnforcementRowDto = {
  ruleRef: "mature.unlabelled@1",
  clauseId: "mature.unlabelled",
  clauseVersion: 1,
  clauseTitle: "Mature content without the mature label",
  group: "mature",
  tier: "t2",
  count: n(40),
  automatedDecision: { fully: n(40), partially: n(0), not: n(0) },
  automatedDetection: n(40),
  appealed: n(12),
  overturned: n(10),
};
const suppressedRow: EnforcementRowDto = {
  ruleRef: "honesty.spam@1",
  clauseId: "honesty.spam",
  clauseVersion: 1,
  clauseTitle: "Spam and scams",
  group: "honesty",
  tier: null,
  count: S,
  automatedDecision: { fully: n(0), partially: n(0), not: S },
  automatedDetection: n(0),
  appealed: S,
  overturned: S,
};
const report: EnforcementReportDto = {
  window: "30d",
  from: "2026-10-02T00:00:00.000Z",
  to: "2026-11-01T00:00:00.000Z",
  rows: [visibleRow, suppressedRow],
  total: S,
  ncii: { due: n(20), onTime: n(10), late: n(10) },
  generatedAt: "2026-11-01T00:00:00.000Z",
};

describe("EnforcementFigures (stories: dark and light at 320 px)", () => {
  for (const theme of ["dark", "light"] as const)
    it(`renders rows, suppressed cells and the NCII line (${theme})`, () => {
      const { container } = render(
        wrap(
          <div className={theme === "dark" ? "dark w-80" : "w-80"} data-theme={theme}>
            <EnforcementFigures report={report} />
          </div>,
        ),
      );
      const groups = all("enforcement-report-group", container);
      expect(groups.map((g) => g.dataset.group)).toEqual(["honesty", "mature"]);

      const rows = all("enforcement-report-row", container);
      const mature = rows.find((r) => r.dataset.ruleRef === "mature.unlabelled@1")!;
      expect(mature.dataset.count).toBe("40");
      expect(mature.dataset.tier).toBe("t2");
      expect(mature.dataset.suppressed).toBeUndefined();
      expect(mature.textContent).toContain("Mature content without the mature label");
      expect(mature.textContent).toContain(t("enforcement.tier.t2"));
      const auto = one("enforcement-report-automated", mature);
      expect([auto.dataset.fully, auto.dataset.partially, auto.dataset.not]).toEqual(["40", "0", "0"]);
      const overturn = one("enforcement-report-overturn", mature);
      expect([overturn.dataset.numerator, overturn.dataset.denominator]).toEqual(["10", "40"]);
      expect(overturn.textContent).toContain("25%");
      expect(all("enforcement-report-suppressed", mature)).toHaveLength(0);

      const spam = rows.find((r) => r.dataset.ruleRef === "honesty.spam@1")!;
      expect(spam.dataset.suppressed).toBe("true");
      expect(spam.dataset.count).toBeUndefined();
      expect(spam.dataset.tier).toBe("none");
      expect(spam.textContent).toContain(t("enforcement.tier.none"));
      expect(one("enforcement-report-automated", spam).dataset.not).toBe("suppressed");
      expect(one("enforcement-report-overturn", spam).dataset.suppressed).toBe("true");
      const markers = all("enforcement-report-suppressed", spam);
      // count, "by a person", overturn rate, appealed, overturned
      expect(markers).toHaveLength(5);
      expect(markers[0]!.textContent).toBe("—");
      expect(markers[0]!.getAttribute("aria-label")).toBe(t("enforcement.suppressedHint"));

      expect(one("enforcement-report-total", container).dataset.count).toBe("suppressed");
      const ncii = one("enforcement-report-ncii", container);
      expect([ncii.dataset.onTime, ncii.dataset.late, ncii.dataset.pending]).toEqual(["10", "10", "0"]);
      expect(all("enforcement-report-empty", container)).toHaveLength(0);
    });

  it("an empty window shows the EmptyState and still the NCII line", () => {
    const { container } = render(wrap(<EnforcementFigures report={{ ...report, rows: [], total: n(0) }} />));
    expect(one("enforcement-report-empty", container).textContent).toContain(t("enforcement.empty"));
    expect(all("enforcement-report-row", container)).toHaveLength(0);
    one("enforcement-report-ncii", container);
  });
});

describe("EnforcementReport", () => {
  it("loads the 30-day window with a skeleton first, and lists the 12 months", async () => {
    let resolve: (r: EnforcementReportDto) => void = () => {};
    const load = vi.fn<LoadEnforcement>(() => new Promise<EnforcementReportDto>((r) => (resolve = r)));
    const { container } = render(wrap(<EnforcementReport load={load} />));
    expect(load).toHaveBeenCalledWith("30d");
    expect(one("enforcement-report-window", container).dataset.value).toBe("30d");
    expect(container.querySelector('[data-slot="skeleton"], output')).not.toBeNull();
    resolve(report);
    await waitFor(() => expect(all("enforcement-report-row", container)).toHaveLength(2));
  });

  it("a failed load shows FormError", async () => {
    const load = vi.fn<LoadEnforcement>(async () => {
      throw new Error("down");
    });
    const { container } = render(wrap(<EnforcementReport load={load} />));
    await waitFor(() => expect(one("form-error", container).textContent).toContain(t("enforcement.loadFailed")));
    expect(all("enforcement-report-row", container)).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("windowOptions: 30d, then the current UTC month and the 11 before it", () => {
    const opts = windowOptions(Date.UTC(2026, 0, 15));
    expect(opts).toHaveLength(13);
    expect(opts[0]).toEqual({ value: "30d", label: t("enforcement.window.rolling") });
    expect(opts[1]?.value).toBe("2026-01");
    expect(opts[2]?.value).toBe("2025-12");
    expect(opts[12]?.value).toBe("2025-02");
  });

  it("overturnRate divides the integers; any suppressed side gives null", () => {
    expect(overturnRate({ count: n(40), overturned: n(10) })).toBe(0.25);
    expect(overturnRate({ count: n(40), overturned: n(0) })).toBe(0);
    expect(overturnRate({ count: S, overturned: n(0) })).toBeNull();
    expect(overturnRate({ count: n(40), overturned: S })).toBeNull();
  });

  it("nciiPending is due − on time − late, suppressed when any is", () => {
    expect(nciiPending({ due: n(30), onTime: n(10), late: n(10) })).toEqual(n(10));
    expect(nciiPending({ due: S, onTime: n(10), late: n(10) })).toEqual(S);
  });

  it("countAttr", () => {
    expect(countAttr(n(0))).toBe("0");
    expect(countAttr(S)).toBe("suppressed");
  });
});

describe("tier labels", () => {
  it("names the tier; without one, the NCII request process apart from staff decisions", () => {
    expect(tierLabelKey({ tier: "t1", group: "safety" })).toBe("enforcement.tier.t1");
    expect(tierLabelKey({ tier: "t0", group: "illegal" })).toBe("enforcement.tier.t0");
    expect(tierLabelKey({ tier: null, group: "illegal" })).toBe("enforcement.tier.request");
    expect(tierLabelKey({ tier: null, group: "honesty" })).toBe("enforcement.tier.none");
  });
});
