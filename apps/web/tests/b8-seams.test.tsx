// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** Batch 8 contract step §3.8: the two treasury stub tabs render an empty state in words. */
import { LocaleProvider } from "@commonair/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TreasuryPayoutTransfersTab, TreasuryRefundRequestsTab } from "../src/components/coop/treasury-tabs.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

describe("treasury stub tabs", () => {
  it("refund requests show the empty state", () => {
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TreasuryRefundRequestsTab />
      </LocaleProvider>,
    );
    const el = screen.getByTestId("refund-requests");
    expect(el.textContent).toContain(en["refundRequests.empty.title"]);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(en["refundRequests.empty.title"]);
  });

  it("payout transfers show the empty state", () => {
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TreasuryPayoutTransfersTab />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("payout-transfers").textContent).toContain(en["payoutTransfers.empty.body"]);
  });
});
