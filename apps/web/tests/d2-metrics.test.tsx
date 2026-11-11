// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d2-metrics web: `/admin/growth` (funnels, tiles with sparklines, intents, UI counters, empty and
 * failed states) and the `/transparency` monthly block, with k-floored cells read as "fewer than 5".
 */
import { GROWTH_METRICS, SIGNUP_INTENTS, type GrowthMetric } from "@commonair/contracts/enums";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { sparkSegments, stepShares, flooredText } from "../src/components/admin/growth-charts.tsx";
import {
  CREATOR_FUNNEL,
  GROWTH_WINDOWS,
  GrowthPage,
  VIEWER_FUNNEL,
  funnelSteps,
  intentLabel,
  metricLabel,
  parseGrowthWindow,
  reportIsEmpty,
  type GrowthClient,
  type GrowthReportDto,
} from "../src/components/admin/growth.tsx";
import { GrowthNumbers, latestMonth, type GrowthNumbersDto } from "../src/components/transparency/growth-numbers.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const FEWER = t("d2Metrics.belowFloor", { floor: 5 });

function report(over: Partial<Record<GrowthMetric, number | null>> = {}): GrowthReportDto {
  const value = (m: GrowthMetric) => (m in over ? (over[m] ?? null) : null);
  return {
    from: "2026-10-11",
    to: "2026-11-09",
    totals: GROWTH_METRICS.map((metric) => ({ metric, value: value(metric) })),
    series: GROWTH_METRICS.map((metric) => ({
      metric,
      points: [
        { day: "2026-11-08", value: null },
        { day: "2026-11-09", value: value(metric) },
      ],
    })),
    signupsByIntent: SIGNUP_INTENTS.map((intent) => ({ intent, value: intent === "follow" ? 12 : null })),
    ui: [
      { surface: "home.hero", action: "view", step: "none", value: 420 },
      { surface: "authGate", action: "create", step: "follow", value: null },
    ],
  };
}

describe("growth helpers", () => {
  it("reads a hidden count as fewer than 5", () => {
    expect(FEWER).toBe("Fewer than 5");
    expect(flooredText(null, locale)).toBe(FEWER);
    expect(flooredText(12_345, locale)).toBe("12,345");
  });

  it("breaks a sparkline at hidden points and keeps lone points visible", () => {
    expect(sparkSegments([])).toEqual([]);
    expect(sparkSegments([null, null])).toEqual([]);
    expect(sparkSegments([0, 10])).toEqual(["0,23 100,1"]);
    expect(sparkSegments([5, null, 5, 10])).toEqual(["0,12 0,12", "66.67,12 100,1"]);
    // A flat zero line sits on the baseline instead of dividing by zero.
    expect(sparkSegments([0, 0, 0])).toEqual(["0,23 50,23 100,23"]);
  });

  it("measures each step against the first, unless either is hidden", () => {
    const steps = (values: (number | null)[]) => values.map((value, i) => ({ id: String(i), label: "", value }));
    expect(stepShares(steps([200, 50, null, 10]))).toEqual([100, 25, null, 5]);
    expect(stepShares(steps([null, 50]))).toEqual([null, null]);
    expect(stepShares(steps([0, 0]))).toEqual([null, null]);
    expect(stepShares([])).toEqual([]);
  });

  it("parses the offered windows only", () => {
    expect(GROWTH_WINDOWS).toEqual([7, 30, 90, 180]);
    expect(parseGrowthWindow("90")).toBe(90);
    expect(parseGrowthWindow("3")).toBeNull();
    expect(parseGrowthWindow("x")).toBeNull();
  });

  it("labels every metric and intent, and builds funnels in order", () => {
    for (const m of GROWTH_METRICS) expect(metricLabel(m)).not.toMatch(/^d2Metrics\./);
    for (const i of SIGNUP_INTENTS) expect(intentLabel(i)).not.toMatch(/^d2Metrics\./);
    const steps = funnelSteps(report({ accounts_created: 40, first_follow_within_7d: 9 }), VIEWER_FUNNEL);
    expect(steps.map((s) => s.id)).toEqual([...VIEWER_FUNNEL]);
    expect(steps.map((s) => s.value)).toEqual([40, null, 9, null, null, null]);
    expect(CREATOR_FUNNEL).toEqual(["first_live", "second_live_within_14d"]);
  });

  it("calls a report empty only when every total and counter is hidden", () => {
    const empty = { ...report(), ui: [] };
    expect(reportIsEmpty(empty)).toBe(true);
    expect(reportIsEmpty(report())).toBe(false);
    expect(reportIsEmpty({ ...empty, totals: report({ members_total: 6 }).totals })).toBe(false);
  });
});

describe("GrowthPage", () => {
  const stub = (r: () => Promise<GrowthReportDto>) => {
    const client = { report: vi.fn<(days: number) => Promise<GrowthReportDto>>(() => r()) };
    return client satisfies GrowthClient;
  };

  it("shows funnels, a tile per metric, intents and counters, with hidden cells as fewer than 5", async () => {
    const client = stub(async () => report({ accounts_created: 40, accounts_verified: 30, members_total: 7 }));
    wrap(<GrowthPage client={client} />);
    await screen.findByTestId("growth-report");
    expect(client.report).toHaveBeenCalledWith(30);
    expect(screen.getByText(t("d2Metrics.window", { from: "2026-10-11", to: "2026-11-09" }))).toBeTruthy();

    const steps = screen.getAllByTestId("growth-funnel-step");
    expect(steps.map((s) => s.dataset.step)).toEqual([...VIEWER_FUNNEL, ...CREATOR_FUNNEL]);
    expect(steps[0]?.dataset.value).toBe("40");
    expect(within(steps[1]!).getByText("30 (75%)")).toBeTruthy();
    expect(steps[2]?.dataset.value).toBe("floored");
    expect(within(steps[2]!).getByText(FEWER)).toBeTruthy();
    expect(screen.getAllByRole("progressbar").length).toBe(steps.length);

    const tiles = screen.getAllByTestId("growth-metric");
    expect(tiles.map((x) => x.dataset.metric)).toEqual([...GROWTH_METRICS]);
    const members = tiles.find((x) => x.dataset.metric === "members_total")!;
    expect(within(members).getByText("7")).toBeTruthy();
    expect(within(members).getByTestId("growth-sparkline").getAttribute("aria-hidden")).toBe("true");
    const live = tiles.find((x) => x.dataset.metric === "first_live")!;
    expect(within(live).getByText(FEWER)).toBeTruthy();

    const intents = screen.getByTestId("growth-intents");
    expect(within(intents).getByText(t("d2Metrics.intents.title"))).toBeTruthy();
    expect(intents.querySelector('[data-intent="follow"]')?.getAttribute("data-value")).toBe("12");
    expect(intents.querySelector('[data-intent="none"]')?.getAttribute("data-value")).toBe("floored");

    const ui = screen.getByTestId("growth-ui");
    expect(within(ui).getByText("home.hero")).toBeTruthy();
    expect(within(ui).getByText("420")).toBeTruthy();
    expect(ui.querySelector('[data-surface="authGate"]')?.textContent).toContain(FEWER);
  });

  it("says so when nothing is counted yet", async () => {
    wrap(<GrowthPage client={stub(async () => ({ ...report(), ui: [] }))} />);
    expect(await screen.findByTestId("growth-empty")).toBeTruthy();
    expect(screen.getByText(t("d2Metrics.empty.title"))).toBeTruthy();
  });

  it("offers Retry when the report does not load", async () => {
    const client = stub(async () => {
      throw new Error("down");
    });
    wrap(<GrowthPage client={client} />);
    await waitFor(() => expect(screen.getByTestId("growth-failed")).toBeTruthy());
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("shows a skeleton while loading", () => {
    wrap(<GrowthPage client={stub(() => new Promise(() => {}))} />);
    expect(screen.getByText(t("d2Metrics.loading"))).toBeTruthy();
  });
});

describe("transparency GrowthNumbers", () => {
  const months: GrowthNumbersDto["months"] = [
    { month: "2026-09", accountsCreated: 120, membersTotal: 30, activeStreamers: 8 },
    { month: "2026-10", accountsCreated: 140, membersTotal: 34, activeStreamers: null },
    { month: "2026-11", accountsCreated: null, membersTotal: null, activeStreamers: null },
  ];

  it("picks the latest month with a shown number", () => {
    expect(latestMonth(months)?.month).toBe("2026-10");
    expect(latestMonth([months[2]!])?.month).toBe("2026-11");
    expect(latestMonth([])).toBeNull();
  });

  it("shows the latest month's tiles and a newest-first table, hidden cells as fewer than 5", async () => {
    wrap(<GrowthNumbers load={async () => ({ months })} />);
    const rows = await screen.findAllByTestId("transparency-growth-row");
    expect(rows.map((r) => r.dataset.month)).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(rows[1]?.dataset.accounts).toBe("140");
    expect(rows[1]?.dataset.streamers).toBe("floored");
    expect(within(rows[1]!).getByText(FEWER)).toBeTruthy();
    expect(within(rows[1]!).getByText("October 2026")).toBeTruthy();
    const stats = screen.getAllByTestId("transparency-growth-stat");
    expect(stats.map((s) => s.dataset.stat)).toEqual(["accountsCreated", "membersTotal", "activeStreamers"]);
    expect(within(stats[0]!).getByText("140")).toBeTruthy();
    expect(within(stats[2]!).getByText(FEWER)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: t("d2Metrics.numbers.title") })).toBeTruthy();
    expect(screen.getByText(t("d2Metrics.numbers.tableCaption"))).toBeTruthy();
  });

  it("offers Retry when the numbers do not load", async () => {
    wrap(
      <GrowthNumbers
        load={async () => {
          throw new Error("down");
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy());
  });
});
