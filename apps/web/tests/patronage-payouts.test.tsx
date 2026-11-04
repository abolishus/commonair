// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * M1-coop-money's web parts (docs/testing/b8-selectors.md "Co-op money"): the card-or-bank choice on
 * `/coop/membership` (`share-buy-stripe` only with Stripe and `shares.cardPayments` on), the period
 * page's payout section in every state (loading, empty, failed load, each status, a deleted
 * account), "Pay out" behind a `ConfirmDialog`, the manual mark-paid dialog, a member's own payout,
 * the `en`/`es` catalogs, and the accessibility rules axe would flag here.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MemberPayoutStatus,
  PatronagePayoutsPanel,
  REFERENCE,
  canMarkPaid,
  isDeletedMember,
  type PatronagePayoutDto,
} from "../src/components/coop/patronage-payouts.tsx";
import { SharePayByCard, cardSharesAllowed, openCardCheckout } from "../src/components/coop/shares-card.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import enCoop from "../src/i18n/locales/en/m1-coop.json" with { type: "json" };
import esCoop from "../src/i18n/locales/es/m1-coop.json" with { type: "json" };
import type { MembershipViewDto } from "../src/lib/coop.ts";

afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

function a11yViolations(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("button"))
    if (!(el.getAttribute("aria-label") ?? el.textContent ?? "").trim())
      out.push(`button-name: ${el.outerHTML.slice(0, 80)}`);
  for (const table of root.querySelectorAll("table")) {
    if (!table.querySelector("caption") && !table.getAttribute("aria-label")) out.push("table without a caption");
    if (table.querySelectorAll("th").length === 0) out.push("table without headers");
  }
  for (const el of root.querySelectorAll("[aria-labelledby], [aria-describedby]"))
    for (const attr of ["aria-labelledby", "aria-describedby"])
      for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) out.push(`${attr} points at missing #${id}`);
  for (const input of root.querySelectorAll("input"))
    if (!input.id || !root.querySelector(`label[for="${input.id}"]`)) out.push("input without a label");
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  return out;
}

let n = 0;
function payout(over: Partial<PatronagePayoutDto> = {}): PatronagePayoutDto {
  n += 1;
  const suffix = String(n).padStart(12, "0");
  return {
    id: `0195f0c2-6a4b-7c3d-8e9f-${suffix}`,
    periodId: "0195f0c2-6a4b-7c3d-8e9a-000000000001",
    user: { id: `0195f0c2-6a4b-7c3d-8e9d-${suffix}`, username: `member${n}`, displayName: "Ada" },
    amount: { cents: 1_250, currency: "usd" },
    provider: "manual",
    status: "pending",
    reference: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    paidAt: null,
    ...over,
  };
}

const view = (over: Partial<MembershipViewDto> = {}): MembershipViewDto => ({
  memberships: [],
  eligibility: [],
  share: null,
  ...over,
});
const share = (status: "pending" | "held", reference: string | null) => ({
  id: "0195f0c2-6a4b-7c3d-8e9b-000000000001",
  status,
  amount: { cents: 2_500, currency: "usd" },
  paymentId: "0195f0c2-6a4b-7c3d-8e9c-000000000001",
  reference,
  instructions: reference ? "Pay by bank transfer" : null,
});

describe("catalogs", () => {
  it("es has every en key of m1-coop, and nothing else", () => {
    expect(Object.keys(esCoop).sort()).toEqual(Object.keys(enCoop).sort());
    for (const v of Object.values(esCoop)) expect(v.trim()).not.toBe("");
  });
});

describe("the card-or-bank choice", () => {
  const on = [{ key: "shares.cardPayments", value: { enabled: true } }];
  const off = [{ key: "shares.cardPayments", value: { enabled: false } }];

  it("allows card only with Stripe and the setting on", () => {
    expect(cardSharesAllowed("stripe", on)).toBe(true);
    expect(cardSharesAllowed("stripe", off)).toBe(false);
    expect(cardSharesAllowed("manual", on)).toBe(false);
    expect(cardSharesAllowed(null, on)).toBe(false);
    expect(cardSharesAllowed("stripe", null)).toBe(false);
    expect(cardSharesAllowed("stripe", [{ key: "shares.cardPayments", value: { enabled: "yes" } }])).toBe(false);
  });

  it("an open card checkout is a pending share without bank details", () => {
    expect(openCardCheckout(view({ share: share("pending", null) }))).toBe(true);
    expect(openCardCheckout(view({ share: share("pending", "CA-ABC123") }))).toBe(false);
    expect(openCardCheckout(view({ share: share("held", null) }))).toBe(false);
    expect(openCardCheckout(null)).toBe(false);
  });

  it("shows Pay by card for a viewer who can buy, and calls onPay", () => {
    const onPay = vi.fn<() => void>();
    const r = wrap(<SharePayByCard view={view()} paying={false} onPay={onPay} />);
    const btn = r.getByTestId("share-buy-stripe");
    expect(btn.textContent).toBe(en["coopMoney.card.button"]);
    fireEvent.click(btn);
    expect(onPay).toHaveBeenCalledTimes(1);
    expect(r.container.textContent).toContain(en["coopMoney.card.refunds"]);
    expect(a11yViolations(r.container)).toEqual([]);
  });

  it("continues an open checkout, and shows nothing for a held share or while loading", () => {
    const open = wrap(
      <SharePayByCard view={view({ share: share("pending", null) })} paying={false} onPay={vi.fn<() => void>()} />,
    );
    expect(open.getByTestId("share-buy-stripe").textContent).toBe(en["coopMoney.card.continue"]);
    cleanup();
    expect(
      wrap(<SharePayByCard view={view({ share: share("held", null) })} paying={false} onPay={vi.fn<() => void>()} />)
        .container.textContent,
    ).toBe("");
    cleanup();
    expect(wrap(<SharePayByCard view={null} paying={false} onPay={vi.fn<() => void>()} />).container.textContent).toBe(
      "",
    );
    cleanup();
    const bank = wrap(
      <SharePayByCard
        view={view({ share: share("pending", "CA-ABC123") })}
        paying={false}
        onPay={vi.fn<() => void>()}
      />,
    );
    expect(bank.queryByTestId("share-buy-stripe")).toBeNull();
  });

  it("disables the button while redirecting", () => {
    const r = wrap(<SharePayByCard view={view()} paying onPay={vi.fn<() => void>()} />);
    const btn = r.getByTestId("share-buy-stripe") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });
});

describe("the payout section", () => {
  const panel = (props: Partial<React.ComponentProps<typeof PatronagePayoutsPanel>> = {}) =>
    wrap(
      <PatronagePayoutsPanel periodId="p1" rows={[]} onPay={vi.fn<() => Promise<void>>(async () => {})} {...props} />,
    );

  it("shows skeleton rows while loading, and the empty state for none", () => {
    const loading = panel({ rows: null });
    expect(loading.getByTestId("patronage-payouts")).toBeTruthy();
    expect(loading.container.querySelectorAll("tr[data-payout-id]")).toHaveLength(0);
    cleanup();
    const empty = panel();
    expect(empty.getByTestId("patronage-payouts").textContent).toContain(en["coopMoney.payouts.empty.title"]);
  });

  it("shows a failed load with a retry", () => {
    const onRetry = vi.fn<() => void>();
    const r = panel({ rows: null, failed: true, onRetry });
    expect(r.container.textContent).toContain(en["coopMoney.payouts.loadFailed"]);
    fireEvent.click(r.getByText(en["coopMoney.payouts.retry"]));
    expect(onRetry).toHaveBeenCalled();
  });

  it("lists each row with the attributes the harness reads, and each status in words", () => {
    const rows = [
      payout({ status: "pending" }),
      payout({ status: "paid", reference: "BANK-1", paidAt: "2026-11-02T00:00:00.000Z" }),
      payout({ status: "failed", provider: "stripe" }),
      payout({ status: "reversed", provider: "stripe", reference: "tr_1" }),
    ];
    const r = panel({ rows });
    const trs = [...r.container.querySelectorAll("tr[data-payout-id]")];
    expect(
      trs.map((tr) => [
        tr.getAttribute("data-user-id"),
        tr.getAttribute("data-status"),
        tr.getAttribute("data-amount-cents"),
      ]),
    ).toEqual(rows.map((x) => [x.user.id, x.status, "1250"]));
    const text = r.getByTestId("patronage-payouts").textContent ?? "";
    for (const k of [
      "coopMoney.payouts.status.pending",
      "coopMoney.payouts.status.paid",
      "coopMoney.payouts.status.failed",
      "coopMoney.payouts.status.reversed",
      "coopMoney.payouts.method.manual",
      "coopMoney.payouts.method.stripe",
    ] as const)
      expect(text).toContain(en[k]);
    expect(text).toContain("BANK-1");
    expect(a11yViolations(r.container)).toEqual([]);
  });

  it("a deleted account says so and cannot be marked paid", () => {
    const gone = payout({
      user: { id: "0195f0c2-6a4b-7c3d-8e9d-0000000000ff", username: "deleted", displayName: "Deleted user" },
    });
    expect(isDeletedMember(gone)).toBe(true);
    expect(canMarkPaid(gone)).toBe(false);
    const r = panel({ rows: [gone], onMarkPaid: vi.fn<() => Promise<void>>(async () => {}) });
    expect(r.container.textContent).toContain(en["coopMoney.payouts.deleted"]);
    expect(r.queryByTestId("patronage-payout-mark-paid")).toBeNull();
  });

  it("Pay out opens a confirm dialog with the period id, then calls onPay", async () => {
    const onPay = vi.fn<() => Promise<void>>(async () => {});
    const r = panel({ onPay });
    const trigger = r.getByTestId("patronage-pay");
    expect(trigger.getAttribute("data-period-id")).toBe("p1");
    fireEvent.click(trigger);
    const confirm = await waitFor(() => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => x.textContent === en["coopMoney.pay.confirm"] && x !== trigger,
      );
      if (!b) throw new Error("no confirm");
      return b;
    });
    expect(document.body.textContent).toContain(en["coopMoney.pay.title"]);
    fireEvent.click(confirm);
    await waitFor(() => expect(onPay).toHaveBeenCalledTimes(1));
  });

  it("mark paid: only pending manual rows, only with a valid reference", async () => {
    const onMarkPaid = vi.fn<(payoutId: string, reference: string) => Promise<void>>(async () => {});
    const manual = payout();
    const rows = [manual, payout({ provider: "stripe" }), payout({ status: "paid", reference: "X" })];
    expect(rows.map(canMarkPaid)).toEqual([true, false, false]);
    const r = panel({ rows, onMarkPaid });
    const buttons = r.getAllByTestId("patronage-payout-mark-paid");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    const input = await waitFor(() => {
      const el = document.querySelector("input");
      if (!el) throw new Error("no input");
      return el;
    });
    const confirm = () => document.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-confirm"]');
    // Focusable while disabled: the state is aria-disabled (or the attribute).
    const off = () => confirm()?.disabled === true || confirm()?.getAttribute("aria-disabled") === "true";
    expect(confirm()).not.toBeNull();
    expect(off()).toBe(true);
    fireEvent.change(input, { target: { value: "ada@example.test" } });
    expect(off()).toBe(true);
    fireEvent.change(input, { target: { value: "BANK-42" } });
    expect(off()).toBe(false);
    expect(a11yViolations(document.body)).toEqual([]);
    fireEvent.click(confirm() as HTMLButtonElement);
    await waitFor(() => expect(onMarkPaid).toHaveBeenCalledWith(manual.id, "BANK-42"));
  });

  it("without the mark-paid procedure, no button shows", () => {
    const r = panel({ rows: [payout()] });
    expect(r.queryByTestId("patronage-payout-mark-paid")).toBeNull();
  });

  it("the reference rule matches the API's", () => {
    for (const ok of ["BANK-123", "chq-0042", "2026/11/03#7"]) expect(REFERENCE.test(ok)).toBe(true);
    for (const bad of ["", " x", "a@b.c", "x".repeat(65), "Paid Jane Doe", "chq 0042"])
      expect(REFERENCE.test(bad)).toBe(false);
  });
});

describe("the member's own payout", () => {
  it("says where it stands, or that nothing was sent yet", () => {
    for (const status of ["pending", "paid", "failed", "reversed"] as const) {
      const r = wrap(<MemberPayoutStatus payout={{ status, amount: { cents: 1_250, currency: "usd" } }} />);
      const el = r.getByTestId("patronage-payout-mine");
      expect(el.getAttribute("data-status")).toBe(status);
      expect(el.textContent).toContain("12.50");
      expect(a11yViolations(r.container)).toEqual([]);
      cleanup();
    }
    const none = wrap(<MemberPayoutStatus payout={null} />);
    expect(none.getByTestId("patronage-payout-mine").textContent).toContain(en["coopMoney.mine.none"]);
  });
});
