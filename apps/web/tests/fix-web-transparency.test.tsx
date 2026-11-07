// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F4: `/transparency` shows two wholes, never one. The revenue split (creators, the co-op's cut
 * net of card fees, card fees) adds up to revenue, so creators read 90%, not the 27% the old bar
 * showed by stacking costs beside them; the co-op's spending is its own bar. Each bar has a table.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { Window } from "happy-dom";
import type * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TransparencyReport } from "../src/components/money/transparency.tsx";
import {
  PAYMENT_FEES,
  SPLIT_WRITEOFF,
  costCategoryLabel,
  creatorSharePercent,
  lastDecision,
  latestMemberCount,
  revenueSegments,
  revenueSplit,
  spendingSegments,
} from "../src/components/money/transparency-split.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { TransparencyMonthDto } from "../src/lib/money.ts";

const usd = (cents: number) => ({ cents, currency: "usd" });

function month(key: string, over: Partial<TransparencyMonthDto> = {}): TransparencyMonthDto {
  return {
    month: key,
    revenue: usd(10_000),
    streamerPayouts: usd(8000),
    coopRetained: usd(1000),
    costs: [
      { category: PAYMENT_FEES, amount: usd(320) },
      { category: "hosting", amount: usd(6000) },
    ],
    surplus: usd(-5320),
    patronageDistributed: usd(0),
    egressBySource: { origin: 0, relay: 0, p2p: 0, cdn: 0 },
    governance: [],
    members: { streamer: 2, viewer: 5, worker: 1 },
    splitSuspense: { released: 0, forfeited: 0, writeOffs: 0, heldAtMonthEnd: usd(0) },
    ...over,
  };
}

describe("revenueSplit", () => {
  it("splits revenue three ways that add up to it, card fees inside the co-op's cut", () => {
    const split = revenueSplit([month("2026-10"), month("2026-09")]);
    expect(split).toEqual({ revenue: 20_000, creators: 18_000, coop: 1360, processing: 640 });
    expect(split.creators + split.coop + split.processing).toBe(split.revenue);
    expect(creatorSharePercent(split)).toBe(90);
  });

  it("caps card fees at the co-op's cut (the excess is spending, not a revenue share)", () => {
    const split = revenueSplit([
      month("2026-10", { coopRetained: usd(100), costs: [{ category: PAYMENT_FEES, amount: usd(250) }] }),
    ]);
    expect(split).toEqual({ revenue: 10_000, creators: 9900, coop: 0, processing: 100 });
  });

  it("is all zero with no months, and has no creator share without revenue", () => {
    const split = revenueSplit([]);
    expect(split).toEqual({ revenue: 0, creators: 0, coop: 0, processing: 0 });
    expect(creatorSharePercent(split)).toBeNull();
  });

  it("never shows a negative part when refunds outweigh income", () => {
    const split = revenueSplit([month("2026-10", { revenue: usd(-500), coopRetained: usd(-50), costs: [] })]);
    expect(split).toEqual({ revenue: -500, creators: 0, coop: 0, processing: 0 });
    expect(creatorSharePercent(split)).toBeNull();
  });

  it("rounds the creator share to a whole percent", () => {
    expect(creatorSharePercent({ revenue: 3, creators: 2 })).toBe(67);
  });

  it("labels the segments with chart tokens only", () => {
    const segments = revenueSegments({ revenue: 100, creators: 90, coop: 7, processing: 3 });
    expect(segments.map((s) => [s.id, s.value, s.color])).toEqual([
      ["creators", 90, "--chart-1"],
      ["coop", 7, "--chart-2"],
      ["processing", 3, "--chart-8"],
    ]);
    expect(segments[0]?.label).toBe(t("fixWeb.transparency.split.creators"));
  });
});

describe("spendingSegments", () => {
  it("sums each category across months, biggest first, and drops empty ones", () => {
    const segments = spendingSegments([
      month("2026-10", {
        costs: [
          { category: "hosting", amount: usd(500) },
          { category: PAYMENT_FEES, amount: usd(300) },
          { category: "domains", amount: usd(0) },
        ],
      }),
      month("2026-09", { costs: [{ category: "hosting", amount: usd(100) }] }),
    ]);
    expect(segments.map((s) => [s.id, s.value])).toEqual([
      ["hosting", 600],
      [PAYMENT_FEES, 300],
    ]);
    for (const s of segments) expect(s.color).toMatch(/^--chart-[124-8]$/);
  });

  it("breaks ties by category so the order is stable", () => {
    const segments = spendingSegments([
      month("2026-10", {
        costs: [
          { category: "storage", amount: usd(10) },
          { category: "bandwidth", amount: usd(10) },
        ],
      }),
    ]);
    expect(segments.map((s) => s.id)).toEqual(["bandwidth", "storage"]);
  });

  it("is empty with no costs", () => {
    expect(spendingSegments([month("2026-10", { costs: [] })])).toEqual([]);
  });

  it("translates the known categories and shows any other slug as is", () => {
    expect(costCategoryLabel(PAYMENT_FEES)).toBe(t("fixWeb.transparency.category.paymentFees"));
    expect(costCategoryLabel(SPLIT_WRITEOFF)).toBe(t("fixWeb.transparency.category.splitWriteOff"));
    expect(costCategoryLabel("hosting")).toBe(t("fixWeb.transparency.category.hosting"));
    expect(costCategoryLabel("tax-advice")).toBe("tax-advice");
  });
});

describe("numbers strip helpers", () => {
  it("counts members at the end of the newest month", () => {
    expect(
      latestMemberCount([month("2026-10"), month("2026-09", { members: { streamer: 99, viewer: 0, worker: 0 } })]),
    ).toBe(8);
    expect(latestMemberCount([])).toBe(0);
  });

  it("finds the latest decision across months, skipping undecided ones", () => {
    const g = (id: string, decidedAt: string | null) => ({
      proposalId: id,
      title: id,
      status: "passed" as const,
      kind: "ordinary" as const,
      passed: true,
      reason: null,
      decidedAt,
    });
    const months = [
      month("2026-10", { governance: [g("a", "2026-10-02T00:00:00Z"), g("w", null)] }),
      month("2026-09", { governance: [g("b", "2026-10-05T00:00:00Z")] }),
    ];
    expect(lastDecision(months)?.proposalId).toBe("b");
    expect(lastDecision([month("2026-10")])).toBeNull();
  });
});

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/transparency"] }),
});

function render(node: React.ReactNode): Document {
  const html = renderToString(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
  const { document } = new Window();
  document.body.innerHTML = html;
  return document as unknown as Document;
}

const rowsOf = (card: Element | null) =>
  [...(card?.querySelectorAll('[data-testid="transparency-split-row"]') ?? [])].map((r) => [
    r.getAttribute("data-part"),
    r.getAttribute("data-cents"),
    r.getAttribute("data-share"),
  ]);

describe("TransparencyReport", () => {
  it("shows the numbers strip, the revenue split with creators at 90%, and spending apart", () => {
    const doc = render(<TransparencyReport months={[month("2026-10"), month("2026-09")]} />);
    const strip = doc.querySelector('[data-testid="transparency-numbers"]');
    expect(strip?.querySelector('[data-stat="share"] dd')?.textContent).toBe("90%");
    expect(strip?.querySelector('[data-stat="members"] dd')?.textContent).toBe("8");

    const flow = doc.querySelector('[data-testid="transparency-flow"]');
    expect(flow?.getAttribute("data-total")).toBe("20000");
    expect(rowsOf(flow)).toEqual([
      ["creators", "18000", "90"],
      ["coop", "1360", "7"],
      ["processing", "640", "3"],
    ]);
    expect(flow?.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      t("money.shareLabel", { label: t("fixWeb.transparency.split.creators"), share: 90 }),
    );

    const spending = doc.querySelector('[data-testid="transparency-spending"]');
    expect(rowsOf(spending)).toEqual([
      ["hosting", "12000", "95"],
      [PAYMENT_FEES, "640", "5"],
    ]);
    // The deficit is said plainly, not hidden.
    expect(doc.querySelector('[data-testid="transparency-deficit"]')).not.toBeNull();
  });

  it("says so when a bar has nothing to show, and has no deficit note in surplus", () => {
    const doc = render(
      <TransparencyReport
        months={[month("2026-10", { revenue: usd(0), coopRetained: usd(0), costs: [], surplus: usd(0) })]}
      />,
    );
    const flow = doc.querySelector('[data-testid="transparency-flow"]');
    expect(flow?.textContent).toContain(t("fixWeb.transparency.split.empty"));
    expect(rowsOf(flow)).toEqual([]);
    expect(doc.querySelector('[data-testid="transparency-spending"]')?.textContent).toContain(
      t("fixWeb.transparency.spending.empty"),
    );
    expect(doc.querySelector('[data-testid="transparency-deficit"]')).toBeNull();
    expect(doc.querySelector('[data-testid="transparency-numbers"] [data-stat="share"] dd')?.textContent).toBe(
      t("fixWeb.transparency.numbers.noRevenue"),
    );
  });
});
