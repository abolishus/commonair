// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-money (overhaul wave 3, D5.6 and D5.7): `/revenue` tiles that add up (paid out, the
 * reconciling equation, the share line from `platform.cut`, no processor ids, one payout state)
 * and `/analytics` as daily bars with the previous period behind, "What's working" insights and
 * "Earnings vs cost" from `analytics.pnl`.
 */
import type { AnalyticsPnl, AnalyticsRange, BroadcastAnalytics } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { PayoutAccountDto, RevenueLineDto, RevenueSummaryDto } from "../src/lib/money.ts";

vi.mock("../src/components/analytics/group-appeal.tsx", () => ({ GroupAppealAction: () => null }));
vi.mock("../src/components/attestations/panel.tsx", () => ({ AttestationsPanel: () => null }));

const { AnalyticsView } = await import("../src/components/analytics/analytics-page.tsx");
type AnalyticsClient = import("../src/components/analytics/client.ts").AnalyticsClient;
const { rangeFor } = await import("../src/components/analytics/data.ts");
const { PayoutAccountCard, RevenueStats, RevenueTrend, ledgerDetail } =
  await import("../src/components/money/revenue.tsx");
const { RevenueReconcile, RevenueSetup, RevenueShareLine } =
  await import("../src/components/studio-money/revenue-overview.tsx");
const { equationCloses, isProcessorId, ledgerReference, revenueEquation, sharePercent } =
  await import("../src/components/studio-money/reconcile.ts");
const { payoutView, setupComplete } = await import("../src/components/studio-money/payout.ts");
const { averageWatchSeconds, bestSlot, followsPerHour, topGrowth } =
  await import("../src/components/studio-money/insights.ts");
const { InsightTiles } = await import("../src/components/studio-money/insight-tiles.tsx");
const { pnlRows } = await import("../src/components/studio-money/pnl-card.tsx");

afterEach(cleanup);

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

const usd = (cents: number) => ({ cents, currency: "usd" });
const summary = (over: Partial<RevenueSummaryDto> = {}): RevenueSummaryDto => ({
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  gross: usd(3533),
  coopCut: usd(234),
  refundsAndChargebacks: usd(1200),
  net: usd(2099),
  pendingPayout: usd(2000),
  paidOut: usd(4700),
  activeSubscriptions: { tier1: 0, tier2: 0, tier3: 0 },
  tips: 0,
  split: { streamerShare: 0.875, coopShare: 0.125 },
  daily: [
    { date: "2026-10-02", gross: 1000, net: 900 },
    { date: "2026-10-16", gross: 0, net: -180 },
  ],
  balance: { available: usd(1200), held: usd(0), owed: usd(0), minimumPayout: usd(2500), holdDays: 7 },
  bySource: { subscriptions: 0, gifts: 0, tips: 0 },
  tiers: [],
  previousNet: usd(900),
  ...over,
});

describe("the revenue equation", () => {
  it("gross − co-op share − refunds = net, with no 'other' row when it is exact", () => {
    const { rows, currency } = revenueEquation(summary());
    expect(currency).toBe("usd");
    expect(rows.map((r) => [r.term, r.cents])).toEqual([
      ["gross", 3533],
      ["coopCut", -234],
      ["refunds", -1200],
      ["net", 2099],
    ]);
    expect(equationCloses(rows)).toBe(true);
  });

  it("tax and crew splits close the gap when there is one, and a negative month still closes", () => {
    const withTax = revenueEquation(
      summary({ gross: usd(1000), coopCut: usd(90), refundsAndChargebacks: usd(0), net: usd(810) }),
    );
    expect(withTax.rows.find((r) => r.term === "other")?.cents).toBe(-100);
    expect(equationCloses(withTax.rows)).toBe(true);
    const negative = revenueEquation(
      summary({ gross: usd(0), coopCut: usd(-100), refundsAndChargebacks: usd(1000), net: usd(-900) }),
    );
    expect(equationCloses(negative.rows)).toBe(true);
    expect(negative.rows.some((r) => r.term === "other")).toBe(false);
  });

  it("an equation without a net row does not close", () => {
    expect(equationCloses([{ term: "gross", cents: 1 }])).toBe(false);
  });

  it("the share as a percent from platform.cut, one decimal at most", () => {
    expect(sharePercent(0.9, "en")).toBe("90");
    expect(sharePercent(0.875, "en")).toBe("87.5");
    expect(sharePercent(0.875, "es")).toBe("87,5");
  });
});

describe("ledger references", () => {
  const line = (over: Partial<RevenueLineDto>): RevenueLineDto => ({
    id: "t1",
    paymentId: "p1",
    occurredAt: "2026-10-05T12:00:00.000Z",
    type: "subscription",
    tier: 2,
    quantity: 1,
    from: { id: "u1", username: "fan", displayName: "Fan" },
    reference: null,
    gross: usd(1000),
    deductions: usd(-150),
    net: usd(850),
    ...over,
  });

  it("recognises processor ids", () => {
    for (const id of ["pi_3Pq2abcDEF", "ch_1Nabcdef", "tr_1Xyz12345", "po_1Abcdefg", "cs_test_a1b2c3d4"])
      expect(isProcessorId(id), id).toBe(true);
    for (const ref of ["CA-ABCD1234", "BANK-1002", "x", "pi_"]) expect(isProcessorId(ref), ref).toBe(false);
  });

  it("a card payment says so; a bank reference shows short; a processor payout id shows nothing", () => {
    expect(ledgerReference(line({ reference: "pi_3Pq2abcDEF" }))).toEqual({ kind: "card" });
    expect(ledgerReference(line({ reference: "CA-ABCD1234" }))).toEqual({ kind: "ref", text: "CA-ABCD1234" });
    expect(ledgerReference(line({ reference: "BANK-TRANSFER-2026-10-ABCDEFG" }))).toEqual({
      kind: "ref",
      text: "…26-10-ABCDEFG",
    });
    expect(ledgerReference(line({ type: "payout", reference: "tr_1Xyz12345" }))).toBeNull();
    expect(ledgerReference(line({ reference: "  " }))).toBeNull();
    expect(ledgerReference(line({ reference: null }))).toBeNull();
  });

  it("the ledger's detail column never shows a raw processor id", () => {
    const detail = ledgerDetail(line({ reference: "pi_3Pq2abcDEF" }));
    expect(detail).not.toContain("pi_");
    expect(detail).toContain("Card payment");
    expect(detail).toContain("Fan");
    expect(ledgerDetail(line({ type: "payout", from: null, tier: null, reference: "BANK-1002" }))).toBe(
      "Ref. BANK-1002",
    );
  });
});

describe("the payout card", () => {
  const account = (over: Partial<PayoutAccountDto>): PayoutAccountDto => ({
    provider: "manual",
    payoutsEnabled: false,
    onboardingUrl: null,
    instructions: null,
    ...over,
  });

  it("resolves every account to exactly one state", () => {
    expect(payoutView(account({ payoutsEnabled: true, instructions: "ignored" })).state).toBe("ready");
    expect(payoutView(account({ provider: "stripe", onboardingUrl: "https://connect.example.org/x" })).state).toBe(
      "connect",
    );
    expect(payoutView(account({ onboardingUrl: "javascript:alert(1)" })).state).toBe("waiting");
    expect(payoutView(account({ instructions: "Bank transfer, monthly" })).state).toBe("manual");
    expect(payoutView(account({ instructions: "   " })).state).toBe("waiting");
  });

  it.each([
    [{ payoutsEnabled: true }, "ready", "Ready", "Payouts are on", false],
    [
      { provider: "stripe" as const, onboardingUrl: "https://connect.example.org/x" },
      "connect",
      "Action needed",
      "Connect a payout account",
      true,
    ],
    [{ instructions: "Bank transfer, monthly" }, "manual", "Waiting on the co-op", "pays you this way", false],
    [{}, "waiting", "Waiting on the co-op", "sets up your payout account", false],
  ])("%o: one status, one explanation, one action at most", (over, state, status, explanation, action) => {
    wrap(<PayoutAccountCard account={account(over)} minimum="$25.00" />);
    const card = screen.getByTestId("revenue-payout-account");
    expect(card.getAttribute("data-state")).toBe(state);
    expect(card.textContent).toContain(status);
    expect(card.textContent).toContain(explanation);
    // The old contradiction: "Payouts enabled" beside "has not set up payouts".
    expect(card.textContent).not.toContain("Payouts enabled");
    expect(card.textContent).not.toContain("Not set up");
    expect(card.querySelectorAll("[data-tone]")).toHaveLength(1);
    expect(card.querySelectorAll("a[href]")).toHaveLength(action ? 1 : 0);
  });

  it("the ready state names the payout minimum once it is known", () => {
    wrap(<PayoutAccountCard account={account({ payoutsEnabled: true })} minimum="$25.00" />);
    expect(screen.getByTestId("revenue-payout-account").textContent).toContain("once it reaches $25.00");
  });

  it("setup is complete with tiers saved and payouts on; unknown counts as done", () => {
    expect(setupComplete([{}], account({ payoutsEnabled: true }))).toBe(true);
    expect(setupComplete([], account({ payoutsEnabled: true }))).toBe(false);
    expect(setupComplete([{}], account({}))).toBe(false);
    expect(setupComplete(null, null)).toBe(true);
  });
});

describe("revenue tiles", () => {
  it("adds a Paid out tile and keeps the E4b tiles and their cents", () => {
    wrap(<RevenueStats summary={summary()} />);
    expect(screen.getByTestId("revenue-paid-out").getAttribute("data-cents")).toBe("4700");
    expect(screen.getByTestId("revenue-paid-out").textContent).toContain("$47.00");
    expect(screen.getByTestId("revenue-earned").getAttribute("data-cents")).toBe("2099");
    expect(screen.getByTestId("revenue-available").getAttribute("data-cents")).toBe("1200");
    expect(screen.queryByTestId("revenue-owed")).toBeNull();
  });

  it("owed shows in the destructive tone, not amber", () => {
    wrap(
      <RevenueStats
        summary={summary({
          balance: { available: usd(0), held: usd(0), owed: usd(250), minimumPayout: usd(2500), holdDays: 7 },
        })}
      />,
    );
    expect(screen.getByTestId("revenue-owed").getAttribute("data-tone")).toBe("destructive");
  });

  it("the reconcile card shows the equation that closes and what was paid out and reserved", () => {
    wrap(<RevenueReconcile summary={summary()} />);
    const rows = screen.getAllByTestId("revenue-reconcile-row");
    expect(rows.map((r) => [r.getAttribute("data-term"), Number(r.getAttribute("data-cents"))])).toEqual([
      ["gross", 3533],
      ["coopCut", -234],
      ["refunds", -1200],
      ["net", 2099],
    ]);
    const above = rows.slice(0, -1).reduce((s, r) => s + Number(r.getAttribute("data-cents")), 0);
    expect(above).toBe(Number(rows.at(-1)?.getAttribute("data-cents")));
    const payouts = screen.getByTestId("revenue-reconcile-payouts");
    expect([payouts.getAttribute("data-paid-out"), payouts.getAttribute("data-pending")]).toEqual(["4700", "2000"]);
    expect(payouts.textContent).toContain("$47.00");
    expect(payouts.textContent).toContain("$20.00");
    expect(screen.getByText(/less the co-op's share and any refunds/)).toBeTruthy();
  });

  it("the share line reads the split, never a hard-coded 90%, and links the fee history", () => {
    wrap(<RevenueShareLine split={{ streamerShare: 0.875, coopShare: 0.125 }} />);
    const line = screen.getByTestId("revenue-share-line");
    expect(line.textContent).toContain("Your share: 87.5%, set by member vote");
    expect(line.getAttribute("data-share")).toBe("0.875");
    const link = screen.getByTestId("revenue-fee-history");
    expect(link.getAttribute("href")).toBe("/transparency#fee-schedule");
  });

  it("the setup section is a titled section only while setup is incomplete", () => {
    const open = wrap(
      <RevenueSetup complete={false}>
        <p>card</p>
      </RevenueSetup>,
    );
    expect(screen.getByTestId("revenue-setup").textContent).toContain("Finish setting up");
    open.unmount();
    wrap(
      <RevenueSetup complete>
        <p>card</p>
      </RevenueSetup>,
    );
    expect(screen.queryByTestId("revenue-setup")).toBeNull();
    expect(screen.getByText("card")).toBeTruthy();
  });

  it("the daily trend is bars, one per day of the month, with a table behind a toggle", () => {
    const { container } = wrap(<RevenueTrend summary={summary()} />);
    const trend = screen.getByTestId("revenue-trend");
    expect(trend.getAttribute("data-days")).toBe("31");
    expect(container.querySelector('figure[data-slot="bar-chart"]')?.getAttribute("data-bars")).toBe("31");
    expect(screen.getByRole("img", { name: "Earned by day" })).toBeTruthy();
    // Whole currency units on the axis, never cents of a dollar.
    expect(trend.textContent).not.toContain(".50");
    fireEvent.click(screen.getByRole("button", { name: "Show the days as a table" }));
    expect(within(screen.getByRole("table")).getByText("-$1.80")).toBeTruthy();
  });

  it("a month with nothing earned keeps its empty state", () => {
    wrap(<RevenueTrend summary={summary({ daily: [] })} />);
    expect(screen.getByText("No revenue this month")).toBeTruthy();
  });
});

describe("insights", () => {
  const b = (id: string, startedAt: string, seconds: number, duration = 3600, sessions = 2) => ({
    broadcastId: id,
    title: `Show ${id}`,
    startedAt,
    durationSeconds: duration,
    totals: {
      verifiedViewerSeconds: seconds,
      unverifiedViewerSeconds: 0,
      excludedViewerSeconds: 0,
      peakVerifiedConcurrent: 3,
      sessions,
    },
  });
  // UTC slots, so the test does not depend on the machine's zone.
  const utc = (ms: number) => ({ weekday: new Date(ms).getUTCDay(), hour: new Date(ms).getUTCHours() });

  it("the best slot is the one with most verified viewers per hour streamed", () => {
    const list = [
      b("a", "2026-10-05T20:00:00.000Z", 3600 * 4), // Monday 20:00, 4 viewers on average
      b("b", "2026-10-12T20:00:00.000Z", 3600 * 2), // Monday 20:00 again: slot averages 3
      b("c", "2026-10-07T18:00:00.000Z", 3600 * 2, 7200), // Wednesday 18:00, 1 viewer
    ];
    expect(bestSlot(list, utc)).toEqual({ weekday: 1, hour: 20, averageViewers: 3, broadcastId: "a" });
  });

  it("needs two slots to compare and ignores zero-length streams", () => {
    expect(bestSlot([b("a", "2026-10-05T20:00:00.000Z", 100)], utc)).toBeNull();
    expect(
      bestSlot([b("a", "2026-10-05T20:00:00.000Z", 100), b("z", "2026-10-06T20:00:00.000Z", 0, 0)], utc),
    ).toBeNull();
    expect(bestSlot([b("a", "2026-10-05T20:00:00.000Z", 0), b("c", "2026-10-07T18:00:00.000Z", 0)], utc)).toBeNull();
  });

  it("ties go to the earlier slot in the week, whatever the input order", () => {
    const tie = [b("w", "2026-10-07T18:00:00.000Z", 3600), b("m", "2026-10-05T20:00:00.000Z", 3600)];
    expect(bestSlot(tie, utc)?.broadcastId).toBe("m");
    expect(bestSlot([...tie].reverse(), utc)?.broadcastId).toBe("m");
  });

  it("average watch per session, follows per hour and the stream that grew followers", () => {
    expect(
      averageWatchSeconds({
        verifiedViewerSeconds: 1000,
        unverifiedViewerSeconds: 0,
        excludedViewerSeconds: 0,
        peakVerifiedConcurrent: 0,
        sessions: 3,
      }),
    ).toBe(333);
    expect(
      averageWatchSeconds({
        verifiedViewerSeconds: 0,
        unverifiedViewerSeconds: 0,
        excludedViewerSeconds: 0,
        peakVerifiedConcurrent: 0,
        sessions: 0,
      }),
    ).toBeNull();
    const list = [b("a", "2026-10-05T20:00:00.000Z", 100), b("c", "2026-10-07T18:00:00.000Z", 100, 7200)];
    const period = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
    const follows = [
      "2026-10-05T20:30:00.000Z", // during a
      "2026-10-07T18:10:00.000Z", // during c
      "2026-10-07T19:59:00.000Z", // during c
      "2026-10-20T00:00:00.000Z", // between streams: counts per hour, not for a stream
      "2026-09-20T00:00:00.000Z", // before the period
    ];
    expect(followsPerHour(list, follows, period)).toBe(1.3);
    expect(followsPerHour(list, null, period)).toBeNull();
    expect(followsPerHour([], follows, period)).toBeNull();
    expect(topGrowth(list, follows)).toEqual({ broadcastId: "c", title: "Show c", follows: 2 });
    expect(topGrowth(list, ["2026-10-20T00:00:00.000Z"])).toBeNull();
    expect(topGrowth(list, null)).toBeNull();
  });

  it("each tile says what it needs when the data cannot answer, and opens the stream when it can", () => {
    const onOpen = vi.fn<(id: string) => void>();
    const range: AnalyticsRange = {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      totals: b("x", "2026-10-05T20:00:00.000Z", 0, 0, 0).totals,
      broadcasts: [b("a", "2026-10-05T20:00:00.000Z", 3600)],
      delivery: [],
      cost: null,
    };
    const { unmount } = wrap(
      <InsightTiles range={range} period={range} followedAt={null} onOpen={onOpen} slot={utc} />,
    );
    const tiles = screen.getAllByTestId("analytics-insight");
    expect(tiles.map((t) => [t.getAttribute("data-insight"), t.getAttribute("data-ready")])).toEqual([
      ["best-slot", "false"],
      ["average-watch", "false"],
      ["follows-per-hour", "false"],
      ["top-growth", "false"],
    ]);
    expect(tiles[0]?.textContent).toContain("Stream at a few different times");
    expect(tiles[3]?.textContent).toContain("Needs your full follower list");
    unmount();

    const two = {
      ...range,
      broadcasts: [b("a", "2026-10-05T20:00:00.000Z", 3600 * 4), b("c", "2026-10-07T18:00:00.000Z", 3600)],
    };
    wrap(
      <InsightTiles range={two} period={range} followedAt={["2026-10-05T20:30:00.000Z"]} onOpen={onOpen} slot={utc} />,
    );
    const best = screen.getAllByTestId("analytics-insight")[0];
    expect(best?.textContent).toContain("Mondays at 8 PM");
    expect(best?.textContent).toContain("averaged 4 verified viewers");
    const opens = screen.getAllByTestId("analytics-insight-open");
    expect(opens.map((o) => o.getAttribute("data-broadcast-id"))).toEqual(["a", "a"]);
    fireEvent.click(opens[0] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith("a");
  });
});

describe("the analytics page", () => {
  const NOW = Date.parse("2026-10-31T12:00:00.000Z");
  const B1 = "01900000-0000-7000-8000-0000000000b1";
  const B2 = "01900000-0000-7000-8000-0000000000b2";
  const totals = (seconds: number, peak: number) => ({
    verifiedViewerSeconds: seconds,
    unverifiedViewerSeconds: 60,
    excludedViewerSeconds: 30,
    peakVerifiedConcurrent: peak,
    sessions: 4,
  });
  /** `shiftDays` moves the streams back into the previous period. */
  const range = (from: string, to: string, seconds: number, shiftDays = 0): AnalyticsRange => ({
    from,
    to,
    totals: totals(seconds, 4),
    broadcasts: [
      {
        broadcastId: B2,
        title: "Late show",
        startedAt: new Date(Date.parse("2026-10-29T20:00:00.000Z") - shiftDays * 86_400_000).toISOString(),
        durationSeconds: 3600,
        totals: totals(seconds, 4),
      },
      {
        broadcastId: B1,
        title: "",
        startedAt: new Date(Date.parse("2026-10-20T18:00:00.000Z") - shiftDays * 86_400_000).toISOString(),
        durationSeconds: 1800,
        totals: totals(90, 1),
      },
    ],
    delivery: [],
    cost: usd(12),
  });
  const pnl: AnalyticsPnl = {
    from: "2026-10-01T12:00:00.000Z",
    to: "2026-10-31T12:00:00.000Z",
    revenue: usd(4500),
    cost: usd(12),
    net: usd(4488),
    byBroadcast: [
      { broadcastId: B1, revenue: usd(500), cost: usd(4) },
      { broadcastId: B2, revenue: usd(4000), cost: usd(8) },
    ],
  };
  const analytics = {
    broadcastId: B2,
    title: "Late show",
    startedAt: "2026-10-29T20:00:00.000Z",
    endedAt: "2026-10-29T21:00:00.000Z",
    durationSeconds: 3600,
    totals: totals(90, 4),
    minutes: [],
    minutesRetained: false,
    exclusions: [],
    hiddenGroups: 0,
    delivery: [],
    cost: null,
  } satisfies BroadcastAnalytics;

  function client(over: Partial<AnalyticsClient> = {}): AnalyticsClient {
    const current = rangeFor(30, NOW);
    return {
      range: vi.fn<AnalyticsClient["range"]>(async (q) =>
        q.to === current.to ? range(q.from, q.to, 90) : range(q.from, q.to, 7200, 30),
      ),
      broadcast: vi.fn<AnalyticsClient["broadcast"]>(async () => analytics),
      shareLinks: vi.fn<AnalyticsClient["shareLinks"]>(async () => ({ items: [], nextCursor: null })),
      createShareLink: vi.fn<AnalyticsClient["createShareLink"]>(),
      revokeShareLink: vi.fn<AnalyticsClient["revokeShareLink"]>(),
      followsSince: vi.fn<NonNullable<AnalyticsClient["followsSince"]>>(async () => ({
        at: ["2026-10-29T20:30:00.000Z"],
        complete: true,
      })),
      pnl: vi.fn<NonNullable<AnalyticsClient["pnl"]>>(async () => pnl),
      ...over,
    };
  }

  it("asks for the period's pnl and shows earnings against cost per stream, newest first", async () => {
    const c = client();
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    await waitFor(() => expect(screen.getAllByTestId("analytics-pnl-row")).toHaveLength(2));
    expect(c.pnl).toHaveBeenCalledWith({ channel: "me", ...rangeFor(30, NOW) });
    const rows = screen.getAllByTestId("analytics-pnl-row");
    expect(
      rows.map((r) => [
        r.getAttribute("data-broadcast-id"),
        r.getAttribute("data-revenue"),
        r.getAttribute("data-cost"),
      ]),
    ).toEqual([
      [B2, "4000", "8"],
      [B1, "500", "4"],
    ]);
    expect(rows[1]?.textContent).toContain("Untitled stream");
    expect(screen.getByTestId("analytics-pnl").textContent).toContain("In this period you earned $45.00");
    expect(screen.getByTestId("analytics-range-earned").getAttribute("data-cents")).toBe("4500");
  });

  it("puts unverified and excluded time in the 'How we counted' group, after the headline tiles", async () => {
    wrap(<AnalyticsView channel="me" now={NOW} client={client()} />);
    const counted = await screen.findByTestId("analytics-counted");
    expect(counted.textContent).toContain("How we counted");
    expect(counted.textContent).toContain("Unverified watch time");
    expect(counted.textContent).toContain("Excluded watch time");
    expect(within(counted).queryByTestId("analytics-range-verified")).toBeNull();
  });

  it("draws the days as bars with the previous period behind once it loads", async () => {
    const { container } = wrap(<AnalyticsView channel="me" now={NOW} client={client()} />);
    await waitFor(() => expect(container.querySelectorAll("rect[data-ghost]").length).toBeGreaterThan(0));
    expect(screen.getByRole("img", { name: "Verified hours watched by day" })).toBeTruthy();
    expect(screen.getByText("Previous period")).toBeTruthy();
  });

  it("the insight link opens its stream in the broadcast section", async () => {
    const c = client();
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    // The best slot is the shorter, older stream (more verified viewers per hour streamed); the
    // picker starts on the newest.
    await waitFor(() => expect(screen.getByTestId("analytics-broadcast-select").getAttribute("data-value")).toBe(B2));
    const open = (await screen.findAllByTestId("analytics-insight-open"))[0] as HTMLElement;
    expect(open.getAttribute("href")).toBe("#analytics-broadcast");
    expect(open.getAttribute("data-broadcast-id")).toBe(B1);
    fireEvent.click(open);
    await waitFor(() => expect(screen.getByTestId("analytics-broadcast-select").getAttribute("data-value")).toBe(B1));
  });

  it("a failed pnl leaves the page and offers Retry", async () => {
    const c = client({
      pnl: vi.fn<NonNullable<AnalyticsClient["pnl"]>>(async () => Promise.reject(new Error("down"))),
    });
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    await waitFor(() => expect(screen.getByTestId("analytics-pnl").textContent).toContain("didn't load"));
    expect(screen.getByTestId("analytics-range-verified")).toBeTruthy();
    expect(screen.queryByTestId("analytics-range-earned")).toBeNull();
    fireEvent.click(within(screen.getByTestId("analytics-pnl")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(c.pnl).toHaveBeenCalledTimes(2));
  });

  it("without a pnl call there is no Earnings vs cost card", async () => {
    const c = client();
    delete c.pnl;
    wrap(<AnalyticsView channel="me" now={NOW} client={c} />);
    await screen.findByTestId("analytics-trend");
    expect(screen.queryByTestId("analytics-pnl")).toBeNull();
  });

  it("pnlRows keeps rows whose stream is not in the range, untitled and last", () => {
    const rows = pnlRows(
      { ...pnl, byBroadcast: [...pnl.byBroadcast, { broadcastId: "gone", revenue: usd(1), cost: usd(0) }] },
      range("a", "b", 1).broadcasts,
    );
    expect(rows.map((r) => r.broadcastId)).toEqual([B2, B1, "gone"]);
    expect(rows.at(-1)?.startedAt).toBeNull();
  });
});
