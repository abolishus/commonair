// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-studio F24: range trends and previous-period deltas. The pure helpers (period days, daily
 * buckets, the delta's direction, sentiment and wording, follower paging), the analytics page
 * switching its period (the range and the previous period are both asked for, the trend follows)
 * and the charts' non-colour cues (each line series has its own stroke pattern, drawn in the key).
 */
import type { AnalyticsRange, BroadcastAnalytics } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { TrendChart } from "@commonair/ui/blocks/data";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

vi.mock("../src/components/analytics/group-appeal.tsx", () => ({ GroupAppealAction: () => null }));
vi.mock("../src/components/attestations/panel.tsx", () => ({ AttestationsPanel: () => null }));

const { AnalyticsView, splitFollows } = await import("../src/components/analytics/analytics-page.tsx");
const { followsSince } = await import("../src/components/analytics/client.ts");
type AnalyticsClient = import("../src/components/analytics/client.ts").AnalyticsClient;
const { rangeFor } = await import("../src/components/analytics/data.ts");
const { audienceTrend, periodDays, periodDelta, previousPeriod, revenueTrend, formatDayLabel } =
  await import("../src/components/studio/trends.ts");

afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

describe("periods", () => {
  it("the previous period is as long and ends where this one starts", () => {
    expect(previousPeriod({ from: "2026-10-01T12:00:00.000Z", to: "2026-10-31T12:00:00.000Z" })).toEqual({
      from: "2026-09-01T12:00:00.000Z",
      to: "2026-10-01T12:00:00.000Z",
    });
  });

  it("lists every UTC day the period touches, `to` exclusive; an empty or reversed period has none", () => {
    expect(periodDays({ from: "2026-10-30T12:00:00.000Z", to: "2026-11-01T12:00:00.000Z" })).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    expect(periodDays({ from: "2026-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" })).toEqual(["2026-10-30"]);
    expect(periodDays({ from: "2026-10-30T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" })).toEqual([]);
    expect(periodDays({ from: "2026-10-31T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" })).toEqual([]);
    expect(periodDays(rangeFor(7, Date.parse("2026-10-31T12:00:00.000Z")))).toHaveLength(8);
  });

  it("formats a day label with the locale's short month", () => {
    expect(formatDayLabel("2026-11-03", "en")).toBe("Nov 3");
  });
});

describe("audience and revenue by day", () => {
  const period = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z" };
  const b = (startedAt: string, seconds: number, peak: number) => ({
    startedAt,
    totals: { verifiedViewerSeconds: seconds, peakVerifiedConcurrent: peak },
  });

  it("buckets broadcasts on the day they started: hours add up, the peak is the highest", () => {
    const rows = audienceTrend(period, [
      b("2026-10-01T10:00:00.000Z", 3600, 4),
      b("2026-10-01T20:00:00.000Z", 1800, 9),
      b("2026-10-03T23:59:00.000Z", 360, 1),
      b("2026-09-30T23:00:00.000Z", 99_999, 99),
    ]);
    expect(rows).toEqual([
      { date: "2026-10-01", hours: 1.5, peak: 9, followers: 0 },
      { date: "2026-10-02", hours: 0, peak: 0, followers: 0 },
      { date: "2026-10-03", hours: 0.1, peak: 1, followers: 0 },
    ]);
  });

  it("counts follows per day and ignores those outside the period", () => {
    const rows = audienceTrend(
      period,
      [],
      ["2026-10-02T01:00:00.000Z", "2026-10-02T23:00:00.000Z", "2026-10-04T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
    );
    expect(rows.map((r) => r.followers)).toEqual([0, 2, 0]);
  });

  it("fills revenue days the summary left out with zero", () => {
    expect(revenueTrend(period, [{ date: "2026-10-02", gross: 500, net: 400 }])).toEqual([
      { date: "2026-10-01", gross: 0, net: 0 },
      { date: "2026-10-02", gross: 500, net: 400 },
      { date: "2026-10-03", gross: 0, net: 0 },
    ]);
  });
});

describe("previous-period deltas", () => {
  it("up", () => {
    expect(periodDelta(150, 100, "en")).toEqual({
      direction: "up",
      sentiment: "positive",
      label: "Up 50% on the previous period",
    });
  });

  it("down", () => {
    expect(periodDelta(75, 100, "en")).toEqual({
      direction: "down",
      sentiment: "negative",
      label: "Down 25% on the previous period",
    });
  });

  it("zero change", () => {
    expect(periodDelta(0, 0, "en")).toEqual({ direction: "flat", label: "Same as the previous period" });
    expect(periodDelta(12, 12, "en")).toEqual({ direction: "flat", label: "Same as the previous period" });
  });

  it("up from nothing has no percentage", () => {
    expect(periodDelta(3, 0, "en")).toEqual({
      direction: "up",
      sentiment: "positive",
      label: "None in the previous period",
    });
  });

  it("no previous period: no delta at all", () => {
    expect(periodDelta(10, null, "en")).toBeUndefined();
    expect(periodDelta(10, undefined, "en")).toBeUndefined();
    expect(periodDelta(10, Number.NaN, "en")).toBeUndefined();
  });

  it("more of a bad thing is negative, with the arrow unchanged", () => {
    expect(periodDelta(200, 100, "en", { higherIsBetter: false })).toMatchObject({
      direction: "up",
      sentiment: "negative",
    });
  });

  it("rounds to whole percent and follows the locale", () => {
    expect(periodDelta(1, 3, "en")?.label).toBe("Down 67% on the previous period");
    expect(periodDelta(150, 100, "es")?.label).toContain("50");
  });
});

describe("followsSince", () => {
  const page = (dates: string[], next: string | null) => ({
    items: dates.map((followedAt) => ({ followedAt })),
    nextCursor: next,
  });

  it("stops at the first follow older than `since`", async () => {
    const fetch = vi.fn<Parameters<typeof followsSince>[0]>(async (cursor: string | undefined) =>
      cursor === undefined
        ? page(["2026-10-30T00:00:00.000Z", "2026-10-20T00:00:00.000Z"], "c1")
        : page(["2026-10-10T00:00:00.000Z", "2026-09-01T00:00:00.000Z"], "c2"),
    );
    expect(await followsSince(fetch, "2026-10-01T00:00:00.000Z")).toEqual({
      at: ["2026-10-30T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "2026-10-10T00:00:00.000Z"],
      complete: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is incomplete when the page cap stops it", async () => {
    const fetch = async () => page(["2026-10-30T00:00:00.000Z"], "more");
    expect(await followsSince(fetch, "2026-10-01T00:00:00.000Z", 3)).toEqual({
      at: ["2026-10-30T00:00:00.000Z", "2026-10-30T00:00:00.000Z", "2026-10-30T00:00:00.000Z"],
      complete: false,
    });
  });
});

describe("the analytics range trend", () => {
  const NOW = Date.parse("2026-10-31T12:00:00.000Z");
  const totals = (seconds: number, peak: number) => ({
    verifiedViewerSeconds: seconds,
    unverifiedViewerSeconds: 0,
    excludedViewerSeconds: 0,
    peakVerifiedConcurrent: peak,
    sessions: 3,
  });
  const range = (from: string, to: string, seconds: number, peak: number): AnalyticsRange => ({
    from,
    to,
    totals: totals(seconds, peak),
    broadcasts: [
      {
        broadcastId: "01900000-0000-7000-8000-0000000000b1",
        title: "Show",
        startedAt: "2026-10-29T20:00:00.000Z",
        durationSeconds: 3600,
        totals: totals(seconds, peak),
      },
    ],
    delivery: [],
    cost: null,
  });
  const analytics = {
    broadcastId: "01900000-0000-7000-8000-0000000000b1",
    title: "Show",
    startedAt: "2026-10-29T20:00:00.000Z",
    endedAt: "2026-10-29T21:00:00.000Z",
    durationSeconds: 3600,
    totals: totals(7200, 4),
    minutes: [],
    minutesRetained: false,
    exclusions: [],
    hiddenGroups: 0,
    delivery: [],
    cost: null,
  } satisfies BroadcastAnalytics;

  function client() {
    const current = rangeFor(30, NOW);
    return {
      // This period has twice the previous one's watch time and the same peak.
      range: vi.fn<AnalyticsClient["range"]>(async (q) =>
        q.to === current.to || q.from === rangeFor(7, NOW).from || q.from === rangeFor(90, NOW).from
          ? range(q.from, q.to, 7200, 4)
          : range(q.from, q.to, 3600, 4),
      ),
      broadcast: vi.fn<AnalyticsClient["broadcast"]>(async () => analytics),
      shareLinks: vi.fn<AnalyticsClient["shareLinks"]>(async () => ({ items: [], nextCursor: null })),
      createShareLink: vi.fn<AnalyticsClient["createShareLink"]>(),
      revokeShareLink: vi.fn<AnalyticsClient["revokeShareLink"]>(),
      followsSince: vi.fn<NonNullable<AnalyticsClient["followsSince"]>>(async () => ({
        at: ["2026-10-30T10:00:00.000Z", "2026-09-20T10:00:00.000Z"],
        complete: true,
      })),
    };
  }

  it("asks for the period and the one before, shows deltas, and follows a period switch", async () => {
    const c = client();
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    await waitFor(() => expect(screen.getByTestId("analytics-trend")).toBeTruthy());
    const p30 = rangeFor(30, NOW);
    expect(c.range).toHaveBeenCalledWith({ channel: "me", ...p30 });
    expect(c.range).toHaveBeenCalledWith({ channel: "me", ...previousPeriod(p30) });
    expect(screen.getByTestId("analytics-trend").getAttribute("data-days")).toBe(String(periodDays(p30).length));
    await waitFor(() =>
      expect(screen.getByTestId("analytics-range-verified").textContent).toContain("Up 100% on the previous period"),
    );
    expect(screen.getByTestId("analytics-range-peak").textContent).toContain("Same as the previous period");
    await waitFor(() => expect(screen.getByTestId("analytics-range-followers").textContent).toContain("1"));
    expect(screen.getByTestId("analytics-range-followers").textContent).toContain("Same as the previous period");

    // The metric toggle offers followers (the list was complete) and switches the chart.
    const metrics = screen.getAllByTestId("analytics-trend-metric").map((b) => b.getAttribute("data-value"));
    expect(metrics).toEqual(["hours", "peak", "followers"]);
    fireEvent.click(screen.getAllByTestId("analytics-trend-metric")[1] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("analytics-trend").getAttribute("data-metric")).toBe("peak"));
  });

  it("drops the deltas, not the page, when the previous period fails", async () => {
    const c = client();
    const p30 = rangeFor(30, NOW);
    c.range.mockImplementation(async (q) => {
      if (q.to !== p30.to) throw new Error("down");
      return range(q.from, q.to, 7200, 4);
    });
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    await waitFor(() => expect(screen.getByTestId("analytics-range-verified")).toBeTruthy());
    expect(screen.getByTestId("analytics-range-verified").textContent).not.toContain("previous period");
  });

  it("shows the followers count as a floor, without a delta, when the paging cap is hit in the period", async () => {
    const c = client();
    c.followsSince.mockResolvedValue({ at: ["2026-10-30T10:00:00.000Z", "2026-10-29T10:00:00.000Z"], complete: false });
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    await waitFor(() =>
      expect(screen.getByTestId("analytics-range-followers").getAttribute("data-capped")).toBe("true"),
    );
    const card = screen.getByTestId("analytics-range-followers").textContent ?? "";
    expect(card).toContain("2+");
    expect(card).toContain("More follows than this page reads");
    expect(card).not.toContain("previous period");
  });

  it("says the followers figure counts current followers only", async () => {
    wrap(<AnalyticsView channel="me" now={NOW} client={client()} />);
    await waitFor(() =>
      expect(screen.getByTestId("analytics-range-followers").textContent).toContain(
        "Counts people who still follow you",
      ),
    );
  });

  it("offers no followers metric without a complete follower list", async () => {
    const c = client();
    c.followsSince.mockResolvedValue({ at: [], complete: false });
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    await waitFor(() => expect(screen.getByTestId("analytics-trend")).toBeTruthy());
    await waitFor(() => expect(c.followsSince).toHaveBeenCalled());
    expect(screen.getAllByTestId("analytics-trend-metric").map((b) => b.getAttribute("data-value"))).toEqual([
      "hours",
      "peak",
    ]);
  });
});

describe("splitFollows", () => {
  const period = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };
  it("counts both periods from a complete list", () => {
    expect(
      splitFollows(
        { at: ["2026-10-20T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-09-10T00:00:00.000Z"], complete: true },
        period,
      ),
    ).toEqual({ current: 2, previous: 1, capped: false });
  });
  it("keeps the current count but no previous when the cap stopped before this period", () => {
    expect(
      splitFollows({ at: ["2026-10-20T00:00:00.000Z", "2026-09-25T00:00:00.000Z"], complete: false }, period),
    ).toEqual({ current: 1, previous: null, capped: false });
  });
  it("marks the count a floor when the cap stopped inside this period", () => {
    expect(
      splitFollows({ at: ["2026-10-20T00:00:00.000Z", "2026-10-05T00:00:00.000Z"], complete: false }, period),
    ).toEqual({ current: 2, previous: null, capped: true });
    expect(splitFollows({ at: [], complete: false }, period)).toEqual({ current: 0, previous: null, capped: true });
  });
});

describe("non-colour series cues", () => {
  it("each line series has its own stroke pattern, drawn as a line in the key", () => {
    const { container } = wrap(
      <TrendChart
        ariaLabel="Audience"
        legend="bottom"
        data={[{ x: "a", v: 1, u: 2, e: 3 }]}
        xKey="x"
        series={[
          { key: "v", label: "Verified", color: "--chart-1" },
          { key: "u", label: "Unverified", color: "--chart-3" },
          { key: "e", label: "Excluded", color: "--chart-5" },
        ]}
      />,
    );
    const items = [...container.querySelectorAll("li")];
    expect(items.map((li) => li.getAttribute("data-dash"))).toEqual(["solid", "dashed", "dotted"]);
    const dashes = items.map((li) => li.querySelector("line")?.getAttribute("stroke-dasharray") ?? null);
    expect(new Set(dashes).size).toBe(3);
  });

  it("an explicit pattern wins; bar charts keep their swatches", () => {
    const line = wrap(
      <TrendChart
        ariaLabel="Revenue"
        legend="top"
        data={[{ x: "a", g: 1, n: 1 }]}
        xKey="x"
        series={[
          { key: "g", label: "Gross", color: "--chart-2", dash: "dashed" },
          { key: "n", label: "Net", color: "--chart-1", dash: "solid" },
        ]}
      />,
    );
    expect([...line.container.querySelectorAll("li")].map((li) => li.getAttribute("data-dash"))).toEqual([
      "dashed",
      "solid",
    ]);
    cleanup();
    const bars = wrap(
      <TrendChart
        ariaLabel="Bars"
        type="bar"
        legend="top"
        data={[{ x: "a", g: 1 }]}
        xKey="x"
        series={[{ key: "g", label: "Gross", color: "--chart-2" }]}
      />,
    );
    expect(bars.container.querySelector("li")?.hasAttribute("data-dash")).toBe(false);
    expect(bars.container.querySelector("li svg")).toBeNull();
  });
});
