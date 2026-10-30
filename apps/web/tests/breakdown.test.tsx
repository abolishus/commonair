// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The payment breakdown dialog, the Support dialog's estimate, "Your payments" and the fee schedule. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BreakdownOpenButton, BreakdownView } from "../src/components/money/breakdown-dialog.tsx";
import { BreakdownEstimate, estimateFeeRange } from "../src/components/money/breakdown-estimate.tsx";
import { PaymentsTable } from "../src/components/money/breakdown-payments.tsx";
import { breakdownLineLabel, type PaymentBreakdownDto } from "../src/components/money/breakdown-table.tsx";
import { FeeSchedule, type FeeScheduleEntryDto, feeScheduleValue } from "../src/components/money/fee-schedule.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const usd = (cents: number) => ({ cents, currency: "usd" });
const PAY = "0192f000-0000-7000-8000-0000000000aa";
const TX1 = "0192f000-0000-7000-8000-0000000000b1";
const TX2 = "0192f000-0000-7000-8000-0000000000b2";
const TX3 = "0192f000-0000-7000-8000-0000000000b3";
const CREATOR = "0192f000-0000-7000-8000-0000000000c1";

/** Every line kind: a taxed payment, a partial chargeback with its dispute fee, and the fee returned. */
function fixture(over: Partial<PaymentBreakdownDto> = {}): PaymentBreakdownDto {
  const line = (
    kind: PaymentBreakdownDto["lines"][number]["kind"],
    cents: number,
    transactionId: string | null,
    extra: Partial<PaymentBreakdownDto["lines"][number]> = {},
  ) => ({ kind, amount: usd(cents), recipientUserId: null, component: null, transactionId, ...extra });
  return {
    paymentId: PAY,
    kind: "tip",
    channel: { slug: "rivertide", displayName: "Rivertide" },
    viewerRole: "payee",
    payer: null,
    gross: usd(1100),
    succeededAt: "2026-10-01T12:00:00.000Z",
    lines: [
      line("tax", 100, TX1),
      line("creator", 900, TX1, { recipientUserId: CREATOR }),
      line("coop_share", 100, TX1),
      line("processor_fee", 62, TX1),
      line("reversal", -50, TX2, { component: "tax" }),
      line("reversal", -450, TX2, { component: "creator", recipientUserId: CREATOR }),
      line("reversal", -50, TX2, { component: "coop_share" }),
      line("dispute_fee", 1500, TX2),
      line("reversal", 50, TX3, { component: "coop_share" }),
      line("dispute_fee", -1500, TX3),
      line("coop_net", -12, null),
    ],
    holdReleasesAt: "2026-10-08T12:00:00.000Z",
    holdReleasedAt: null,
    cutSource: { historyId: null, changedAt: null, proposalId: null, streamerShare: 0.9, coopShare: 0.1 },
    timeline: [
      { kind: "paid", at: "2026-10-01T12:00:00.000Z", amount: usd(1100), transactionId: TX1 },
      { kind: "charged_back", at: "2026-10-02T12:00:00.000Z", amount: usd(-550), transactionId: TX2 },
      { kind: "chargeback_won", at: "2026-10-03T12:00:00.000Z", amount: usd(550), transactionId: TX3 },
    ],
    ...over,
  };
}

const ids = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];

describe("BreakdownView", () => {
  it("renders every line kind with its sign, and says a negative co-op net in words", () => {
    wrap(<BreakdownView breakdown={fixture()} />);
    const lines = ids("breakdown-line").map((el) => [el.dataset.kind, el.dataset.component, el.dataset.cents]);
    expect(lines).toEqual([
      ["tax", "", "100"],
      ["creator", "", "900"],
      ["coop_share", "", "100"],
      ["processor_fee", "", "62"],
      ["reversal", "tax", "-50"],
      ["reversal", "creator", "-450"],
      ["reversal", "coop_share", "-50"],
      ["dispute_fee", "", "1500"],
      ["reversal", "coop_share", "50"],
      ["dispute_fee", "", "-1500"],
      ["coop_net", "", "-12"],
    ]);
    expect(new Set(lines.map(([k]) => k))).toEqual(
      new Set(["tax", "creator", "coop_share", "processor_fee", "reversal", "dispute_fee", "coop_net"]),
    );
    expect(ids("breakdown-gross")[0]?.dataset.cents).toBe("1100");
    expect(screen.getByText(/The co-op lost \$0\.12 on this payment/)).toBeTruthy();
    expect(screen.getByText("Anonymous")).toBeTruthy();
    expect(screen.getByText("Co-op share reversed")).toBeTruthy();
    expect(screen.getByText("Co-op share restored")).toBeTruthy();
    expect(screen.getByText("Dispute fee returned")).toBeTruthy();
    expect(ids("breakdown-hold")[0]?.dataset.releasesAt).toBe("2026-10-08T12:00:00.000Z");
    expect(ids("breakdown-cut-source")[0]?.dataset.historyId).toBe("");
    expect(screen.getByText("Set when the co-op was founded.")).toBeTruthy();
    const link = screen.getByText("See the fee schedule").closest("a");
    expect(link?.getAttribute("href")).toBe("/transparency#fee-schedule");
    expect(ids("breakdown-timeline-item").map((el) => el.dataset.kind)).toEqual([
      "paid",
      "charged_back",
      "chargeback_won",
    ]);
  });

  it("a positive co-op net has no loss sentence; a released hold and a decided cut are dated", () => {
    const b = fixture({
      lines: [
        { kind: "creator", amount: usd(900), recipientUserId: CREATOR, component: null, transactionId: TX1 },
        { kind: "coop_share", amount: usd(100), recipientUserId: null, component: null, transactionId: TX1 },
        { kind: "processor_fee", amount: usd(0), recipientUserId: null, component: null, transactionId: TX1 },
        { kind: "coop_net", amount: usd(100), recipientUserId: null, component: null, transactionId: null },
      ],
      viewerRole: "payer",
      payer: { id: CREATOR, username: "ana", displayName: "Ana" },
      holdReleasesAt: null,
      holdReleasedAt: "2026-10-08T12:00:00.000Z",
      cutSource: {
        historyId: TX3,
        changedAt: "2026-09-01T00:00:00.000Z",
        proposalId: null,
        streamerShare: 0.85,
        coopShare: 0.15,
      },
    });
    wrap(<BreakdownView breakdown={b} />);
    expect(screen.queryByText(/The co-op lost/)).toBeNull();
    expect(ids("breakdown-hold")[0]?.dataset.releasedAt).toBe("2026-10-08T12:00:00.000Z");
    expect(ids("breakdown-hold")[0]?.textContent).toMatch(/was released/);
    expect(ids("breakdown-cut-source")[0]?.dataset.historyId).toBe(TX3);
    expect(ids("breakdown-cut-source")[0]?.textContent).toMatch(/85% to creators, 15% to the co-op/);
    expect(screen.getByText("Rivertide")).toBeTruthy();
  });

  it("labels each kind", () => {
    const l = (kind: PaymentBreakdownDto["lines"][number]["kind"], cents: number, component = null as never) =>
      breakdownLineLabel({ kind, amount: usd(cents), recipientUserId: null, component, transactionId: null });
    expect(l("processor_fee", 30)).toMatch(/processing fee/);
    expect(l("dispute_fee", 1500)).toMatch(/Dispute fee \(paid/);
    expect(l("coop_net", -1)).toBe("What the co-op kept");
    expect(l("reversal", -10, "creator" as never)).toBe("Creator share reversed");
  });
});

describe("BreakdownOpenButton", () => {
  it("loads the breakdown when the dialog opens", async () => {
    const paymentBreakdown = vi.fn<(id: string) => Promise<PaymentBreakdownDto>>(async () => fixture());
    wrap(<BreakdownOpenButton paymentId={PAY} client={{ paymentBreakdown }} />);
    const open = ids("breakdown-open")[0];
    expect(open?.dataset.paymentId).toBe(PAY);
    expect(paymentBreakdown).not.toHaveBeenCalled();
    fireEvent.click(open as HTMLElement);
    await waitFor(() => expect(ids("breakdown-line").length).toBe(11));
    expect(paymentBreakdown).toHaveBeenCalledWith(PAY);
    expect(ids("breakdown-dialog")).toHaveLength(1);
  });

  it("shows an error when the breakdown cannot be loaded", async () => {
    const paymentBreakdown = vi.fn<(id: string) => Promise<PaymentBreakdownDto>>(async () => {
      throw new Error("nope");
    });
    wrap(<BreakdownOpenButton paymentId={PAY} client={{ paymentBreakdown }} />);
    fireEvent.click(ids("breakdown-open")[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeTruthy());
  });
});

describe("estimate", () => {
  const STRIPE = { lowBps: 150, highBps: 390, fixedCents: 30 };

  it("computes the fee range from the rates and the fixed part", () => {
    expect(estimateFeeRange(1000, STRIPE)).toEqual({ lowCents: 45, highCents: 69 });
    expect(estimateFeeRange(333, STRIPE)).toEqual({ lowCents: 35, highCents: 43 });
    expect(estimateFeeRange(0, STRIPE)).toBeNull();
  });

  it("shows the split and the fee range, labelled an estimate", () => {
    wrap(
      <BreakdownEstimate
        totalCents={1000}
        currency="usd"
        split={{ streamerShare: 0.9, coopShare: 0.1 }}
        feeEstimate={STRIPE}
      />,
    );
    const el = ids("breakdown-estimate")[0];
    expect([el?.dataset.lowCents, el?.dataset.highCents]).toEqual(["45", "69"]);
    expect(el?.textContent).toMatch(/estimate/);
    expect(el?.textContent).toMatch(/\$9\.00/);
    expect(el?.textContent).toMatch(/\$1\.00/);
  });

  it("is hidden when the provider charges no fee (feeEstimate null)", () => {
    wrap(
      <BreakdownEstimate
        totalCents={1000}
        currency="usd"
        split={{ streamerShare: 0.9, coopShare: 0.1 }}
        feeEstimate={null}
      />,
    );
    expect(ids("breakdown-estimate")).toHaveLength(0);
  });
});

describe("PaymentsTable", () => {
  it("lists payments with a breakdown-open each; the dialog shows the loaded breakdown", async () => {
    const b = fixture({ viewerRole: "payer", payer: { id: CREATOR, username: "ana", displayName: "Ana" } });
    wrap(<PaymentsTable items={[b]} hasMore={false} loadingMore={false} onLoadMore={() => undefined} />);
    const open = ids("breakdown-open");
    expect(open.map((el) => el.dataset.paymentId)).toEqual([PAY]);
    fireEvent.click(open[0] as HTMLElement);
    await waitFor(() => expect(ids("breakdown-line").length).toBe(11));
  });

  it("shows the empty state", () => {
    wrap(<PaymentsTable items={[]} hasMore={false} loadingMore={false} onLoadMore={() => undefined} />);
    expect(screen.getByText("No payments yet")).toBeTruthy();
  });
});

describe("FeeSchedule", () => {
  const entries: FeeScheduleEntryDto[] = [
    {
      id: TX1,
      key: "platform.cut",
      value: { streamerShare: 0.85, coopShare: 0.15 },
      previous: { streamerShare: 0.9, coopShare: 0.1 },
      changedAt: "2026-09-01T00:00:00.000Z",
      proposalId: TX2,
    },
    {
      id: null,
      key: "platform.cut",
      value: { streamerShare: 0.9, coopShare: 0.1 },
      previous: null,
      changedAt: null,
      proposalId: null,
    },
    {
      id: null,
      key: "payout.rules",
      value: { minimumCents: 2500, holdDays: 7, currency: "usd", schedule: "monthly" },
      previous: null,
      changedAt: null,
      proposalId: null,
    },
  ];

  it("renders each entry at the fee-schedule anchor, the seed with an empty data-changed-at", async () => {
    wrap(<FeeSchedule load={async () => entries} />);
    await waitFor(() => expect(ids("fee-schedule-row").length).toBe(3));
    expect(ids("fee-schedule")[0]?.id).toBe("fee-schedule");
    expect(ids("fee-schedule-row").map((el) => [el.dataset.key, el.dataset.changedAt])).toEqual([
      ["platform.cut", "2026-09-01T00:00:00.000Z"],
      ["platform.cut", ""],
      ["payout.rules", ""],
    ]);
    expect(screen.getByText("Proposal").closest("a")?.getAttribute("href")).toBe(`/coop/proposals/${TX2}`);
  });

  it("describes the values in words", () => {
    expect(feeScheduleValue(entries[0] as FeeScheduleEntryDto, "en")).toBe("85% to creators, 15% to the co-op");
    expect(feeScheduleValue(entries[2] as FeeScheduleEntryDto, "en")).toBe("Minimum payout $25.00, held 7 days");
    expect(feeScheduleValue({ ...(entries[2] as FeeScheduleEntryDto), value: {} }, "en")).toBeNull();
  });

  it("shows an error when the schedule cannot be loaded", async () => {
    wrap(
      <FeeSchedule
        load={async () => {
          throw new Error("down");
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeTruthy());
  });
});
