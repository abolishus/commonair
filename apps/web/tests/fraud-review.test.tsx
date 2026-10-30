// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The treasury "Fraud review" tab (ADR 0036, docs/testing/w1-selectors.md "Fraud floor"), rendered
 * from the app's components with contract-shaped fixtures: the flag ids and `data-*`, evidence in
 * words, each status, four eyes on the decide button, the review and decide dialogs, the raise
 * form, and the payout rows' fraud hold.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  FraudReviewPanel,
  decideBlockedReason,
  type FraudReviewPanelProps,
  type PaymentFraudFlagDto,
} from "../src/components/money/fraud-review.tsx";
import { PayoutsPanel, TreasuryPageTabs, payoutHoldLabel } from "../src/components/money/treasury.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { TreasurerPayoutDto } from "../src/lib/money.ts";

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}
afterEach(cleanup);

const ME = "01900000-0000-7000-8000-000000000001";
const OTHER = "01900000-0000-7000-8000-000000000002";
const PAYEE = "01900000-0000-7000-8000-000000000003";
const AT = "2026-10-20T10:00:00.000Z";
const noop = () => undefined;
const asyncNoop = async () => undefined;

function flag(over: Partial<PaymentFraudFlagDto> = {}): PaymentFraudFlagDto {
  return {
    id: "01900000-0000-7000-8000-0000000000f1",
    payee: { id: PAYEE, username: "mule", displayName: "Mule Channel" },
    kind: "payer_concentration",
    status: "open",
    evidence: { grossCents: 60_000, topShareBps: 8000, newPayerShareBps: 5000, payers: 3 },
    raisedAt: AT,
    raisedBy: null,
    reviewedBy: null,
    recommendation: null,
    reviewedAt: null,
    decidedBy: null,
    decidedAt: null,
    releasedBy: null,
    releasedAt: null,
    note: "",
    heldPayouts: 2,
    ...over,
  };
}
const me = { id: ME, username: "treasurer1" };
const other = { id: OTHER, username: "treasurer2" };

function panel(over: Partial<FraudReviewPanelProps> = {}) {
  const props: FraudReviewPanelProps = {
    flags: [flag()],
    meId: ME,
    currency: "usd",
    status: "all",
    onStatusChange: noop,
    onRaise: asyncNoop,
    onReview: asyncNoop,
    onDecide: asyncNoop,
    ...over,
  };
  return wrap(<FraudReviewPanel {...props} />);
}
const one = (testId: string) => {
  const found = screen.queryAllByTestId(testId);
  expect(found, testId).toHaveLength(1);
  return found[0] as HTMLElement;
};
const isDisabled = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

describe("fraud flags", () => {
  it("each flag carries kind, status, payee and released, inside fraud-flags", () => {
    panel({
      flags: [
        flag(),
        flag({ id: "f2", kind: "payer_velocity", status: "reviewed", reviewedBy: other, recommendation: "clear" }),
        flag({ id: "f3", kind: "new_payee", status: "cleared", evidence: { payoutCents: 54_000 } }),
        flag({ id: "f4", kind: "manual", status: "confirmed", raisedBy: other, evidence: {} }),
        flag({ id: "f5", kind: "manual", status: "confirmed", releasedBy: other, releasedAt: AT, evidence: {} }),
      ],
    });
    const list = one("fraud-flags");
    const rows = within(list).getAllByTestId("fraud-flag");
    expect(rows.map((r) => [r.dataset.kind, r.dataset.status, r.dataset.payee, r.dataset.released])).toEqual([
      ["payer_concentration", "open", "mule", "false"],
      ["payer_velocity", "reviewed", "mule", "false"],
      ["new_payee", "cleared", "mule", "false"],
      ["manual", "confirmed", "mule", "false"],
      ["manual", "confirmed", "mule", "true"],
    ]);
    // A confirmed flag reads "held until an admin releases it", or who released it.
    expect(rows[3]?.textContent).toContain(en["fraud.confirmed.held"]);
    expect(rows[4]?.textContent).toContain("Released by @treasurer2");
    // No release control in W1.
    expect(screen.queryByText(/^Release$/)).toBeNull();
  });

  it("evidence in words: money with MoneyAmount, shares as percent", () => {
    panel();
    const evidence = one("fraud-flag-evidence");
    expect(evidence.textContent).toContain("$600.00");
    expect(evidence.textContent).toContain("80%");
    expect(evidence.textContent).toContain("50%");
    expect(evidence.querySelector("data")?.getAttribute("value")).toBe("60000");
    expect(one("fraud-flag-held").textContent).toBe("2 payouts held");
  });

  it("velocity evidence shows the burst's start as a relative time", () => {
    panel({
      flags: [
        flag({
          kind: "payer_velocity",
          evidence: { payerUserId: OTHER, payments: 11, windowStart: AT },
        }),
      ],
    });
    const evidence = one("fraud-flag-evidence");
    expect(evidence.textContent).toContain("11");
    expect(evidence.querySelector("time")?.getAttribute("datetime")).toBe(AT);
  });

  it("empty and loading states", () => {
    panel({ flags: [] });
    expect(screen.getByText(en["fraud.empty"])).toBeTruthy();
    cleanup();
    panel({ flags: null });
    expect(screen.queryAllByTestId("fraud-flag")).toHaveLength(0);
  });
});

describe("review and decide", () => {
  it("review: pick a recommendation, add a note, confirm", async () => {
    const onReview = vi.fn<FraudReviewPanelProps["onReview"]>(async () => undefined);
    panel({ onReview });
    const button = one("fraud-flag-review");
    expect(isDisabled(button)).toBe(false);
    fireEvent.click(button);
    const dialog = await waitFor(() => one("fraud-review-dialog"));
    const confirm = within(dialog).getByTestId("confirm-dialog-confirm");
    expect(isDisabled(confirm)).toBe(true);
    fireEvent.click(within(dialog).getByTestId("fraud-decision-confirm"));
    fireEvent.change(within(dialog).getByTestId("fraud-note"), { target: { value: "  looks like testing cards  " } });
    await waitFor(() => expect(isDisabled(within(dialog).getByTestId("confirm-dialog-confirm"))).toBe(false));
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() =>
      expect(onReview).toHaveBeenCalledWith(
        expect.objectContaining({ id: flag().id }),
        "confirm",
        "looks like testing cards",
      ),
    );
  });

  it("decide is blocked for the reviewer, the raiser and the payee, and says it needs a second person", () => {
    const reviewedByMe = flag({ status: "reviewed", reviewedBy: me, recommendation: "clear" });
    panel({ flags: [reviewedByMe] });
    const button = one("fraud-flag-decide");
    expect(isDisabled(button)).toBe(true);
    const hint = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe(en["fraud.decide.youReviewed"]);

    expect(decideBlockedReason(flag({ status: "reviewed", reviewedBy: other, raisedBy: me }), ME)).toBe(
      en["fraud.decide.youRaised"],
    );
    expect(
      decideBlockedReason(flag({ status: "reviewed", reviewedBy: other, payee: { ...me, displayName: "Me" } }), ME),
    ).toBe(en["fraud.decide.ownPayouts"]);
    expect(decideBlockedReason(flag({ status: "reviewed", reviewedBy: other }), ME)).toBeNull();
  });

  it("a second treasurer decides: clear", async () => {
    const onDecide = vi.fn<FraudReviewPanelProps["onDecide"]>(async () => undefined);
    panel({ flags: [flag({ status: "reviewed", reviewedBy: other, recommendation: "clear" })], onDecide });
    const button = one("fraud-flag-decide");
    expect(isDisabled(button)).toBe(false);
    expect(one("fraud-flag-action-hint").textContent).toBe(en["fraud.decide.secondPerson"]);
    fireEvent.click(button);
    const dialog = await waitFor(() => one("fraud-decide-dialog"));
    fireEvent.click(within(dialog).getByTestId("fraud-decision-clear"));
    await waitFor(() => expect(isDisabled(within(dialog).getByTestId("confirm-dialog-confirm"))).toBe(false));
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ status: "reviewed" }), "clear", ""),
    );
  });

  it("decided flags have no actions; the payee cannot review their own flag", () => {
    panel({ flags: [flag({ status: "cleared" }), flag({ id: "f2", status: "confirmed" })] });
    expect(screen.queryAllByTestId("fraud-flag-review")).toHaveLength(0);
    expect(screen.queryAllByTestId("fraud-flag-decide")).toHaveLength(0);
    cleanup();
    panel({ meId: PAYEE });
    expect(isDisabled(one("fraud-flag-review"))).toBe(true);
  });
});

describe("raise", () => {
  it("submits the username (trimmed, lower case) and the note", async () => {
    const onRaise = vi.fn<FraudReviewPanelProps["onRaise"]>(async () => undefined);
    panel({ onRaise });
    const submit = one("fraud-flag-raise");
    expect(isDisabled(submit)).toBe(true);
    fireEvent.change(one("fraud-raise-username"), { target: { value: " Mule " } });
    fireEvent.click(submit);
    await waitFor(() => expect(onRaise).toHaveBeenCalledWith("mule", ""));
  });
});

describe("treasury tabs and payouts", () => {
  it("the fraud tab follows the six existing ones", () => {
    wrap(
      <TreasuryPageTabs
        value="fraud"
        onValueChange={noop}
        panels={{
          payments: null,
          payouts: null,
          accounts: null,
          costs: null,
          shares: null,
          patronage: null,
          fraud: <p>fraud</p>,
        }}
      />,
    );
    for (const tab of ["payments", "payouts", "accounts", "costs", "shares", "patronage", "fraud"])
      expect(screen.queryAllByTestId(`treasury-tab-${tab}`), tab).toHaveLength(1);
    expect(one("treasury-tab-fraud").textContent).toBe(en["fraud.tab"]);
  });

  it("payout rows carry data-hold-reason and read a fraud hold in words", () => {
    const payout: TreasurerPayoutDto = {
      id: "01900000-0000-7000-8000-0000000000a1",
      periodStart: AT,
      periodEnd: AT,
      amount: { cents: 54_000, currency: "usd" },
      status: "held",
      provider: "manual",
      holdReason: "fraud_review",
      paidAt: null,
      user: { id: PAYEE, username: "mule", displayName: "Mule" },
      reference: null,
      createdAt: AT,
    };
    wrap(<PayoutsPanel payouts={[payout]} result={null} running={false} onRun={noop} onMarkPaid={asyncNoop} />);
    const row = one("treasury-payout-row");
    expect(row.dataset.holdReason).toBe("fraud_review");
    expect(row.textContent).toContain(en["fraud.holdReason"]);
    expect(payoutHoldLabel("payout_account_not_ready")).toBe(en["treasury.holdReason.accountNotReady"]);
  });
});
