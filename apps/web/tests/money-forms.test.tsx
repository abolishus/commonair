// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** Client behaviour of the money pages: paged lists, amount validity, form rules and resets. */
import { MONEY_LIMITS } from "@commonair/contracts/currency";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { Dialog } from "@commonair/ui/components/dialog";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TierEditor } from "../src/components/money/revenue.tsx";
import {
  CostForm,
  DisputeForm,
  PayoutAccountForm,
  type CostInput,
  type PayoutAccountInput,
} from "../src/components/money/treasury.tsx";
import { usePaged, type Page } from "../src/components/money/use-load.ts";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { SubTierDto, TreasurerPaymentDto } from "../src/lib/money.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const usd = (cents: number) => ({ cents, currency: "usd" });
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const disabled = (testId: string) => screen.getByTestId(testId).hasAttribute("disabled");

describe("usePaged", () => {
  const pages: Record<string, Page<number>> = {
    first: { items: [1, 2], nextCursor: "c1" },
    c1: { items: [3, 4], nextCursor: "c2" },
    c2: { items: [5], nextCursor: null },
  };

  it("loads the first page, appends pages on load more, and stops at the last", async () => {
    const load = vi.fn<(cursor: string | undefined) => Promise<Page<number>>>(
      async (cursor: string | undefined) => pages[cursor ?? "first"] as Page<number>,
    );
    const { result } = renderHook(() => usePaged("k", load, vi.fn<(err: unknown) => void>()));
    expect(result.current.items).toBeNull();
    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual([1, 2, 3, 4]));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual([1, 2, 3, 4, 5]));
    expect(result.current.hasMore).toBe(false);
    expect(load.mock.calls.map((c) => c[0])).toEqual([undefined, "c1", "c2"]);
  });

  it("a reload starts again from the first page (extra pages dropped)", async () => {
    let round = 0;
    const load = vi.fn<(cursor: string | undefined) => Promise<Page<number>>>(async (cursor: string | undefined) => {
      if (cursor) return pages[cursor] as Page<number>;
      round++;
      return { items: round === 1 ? [1, 2] : [9], nextCursor: "c1" };
    });
    const { result } = renderHook(() => usePaged("k", load, vi.fn<(err: unknown) => void>()));
    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual([1, 2, 3, 4]));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.items).toEqual([9]));
    expect(result.current.hasMore).toBe(true);
  });

  it("a new key loads its own first page; a load-more failure is reported, rows kept", async () => {
    const onMoreError = vi.fn<(err: unknown) => void>();
    const load = vi.fn<(cursor: string | undefined) => Promise<Page<number>>>(async (cursor: string | undefined) => {
      if (cursor) throw new Error("down");
      return { items: [1], nextCursor: "c1" };
    });
    const { result, rerender } = renderHook(({ k }) => usePaged(k, load, onMoreError), { initialProps: { k: "a" } });
    await waitFor(() => expect(result.current.items).toEqual([1]));
    act(() => result.current.loadMore());
    await waitFor(() => expect(onMoreError).toHaveBeenCalledOnce());
    expect(result.current.items).toEqual([1]);
    expect(result.current.loadingMore).toBe(false);
    rerender({ k: "b" });
    expect(result.current.items).toBeNull();
    await waitFor(() => expect(result.current.items).toEqual([1]));
  });
});

describe("TierEditor", () => {
  const tiers = [
    { tier: 1 as const, name: "Bronze", price: usd(500), benefits: "" },
    { tier: 2 as const, name: "Silver", price: usd(1000), benefits: "" },
    { tier: 3 as const, name: "Gold", price: usd(2500), benefits: "" },
  ];

  it("caps names and benefits at MONEY_LIMITS", () => {
    wrap(<TierEditor tiers={tiers} currency="usd" onSave={async (t) => t} />);
    expect(screen.getByTestId("revenue-tier-name-1").getAttribute("maxlength")).toBe(
      String(MONEY_LIMITS.tierNameMaxLength),
    );
    expect(screen.getByTestId("revenue-tier-benefits-3").getAttribute("maxlength")).toBe(
      String(MONEY_LIMITS.tierBenefitsMaxLength),
    );
  });

  it("an unparsed price disables save until it parses again", async () => {
    const onSave = vi.fn<(t: SubTierDto[]) => Promise<SubTierDto[]>>(async (t) => t);
    wrap(<TierEditor tiers={tiers} currency="usd" onSave={onSave} />);
    expect(disabled("revenue-tiers-save")).toBe(false);
    type("revenue-tier-price-2", "10.0.0");
    await waitFor(() => expect(disabled("revenue-tiers-save")).toBe(true));
    expect(screen.getByTestId("revenue-tier-price-2").getAttribute("data-cents")).toBe("");
    type("revenue-tier-price-2", "12.50");
    await waitFor(() => expect(disabled("revenue-tiers-save")).toBe(false));
    fireEvent.click(screen.getByTestId("revenue-tiers-save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]?.[0].map((t) => t.price.cents)).toEqual([500, 1250, 2500]);
  });
});

describe("DisputeForm", () => {
  const payment: TreasurerPaymentDto = {
    paymentId: "p1",
    reference: "CA-ABCD1234",
    kind: "tip",
    status: "succeeded",
    amount: usd(1000),
    refunded: usd(0),
    tier: null,
    quantity: 1,
    user: null,
    channelSlug: "rivertide",
    createdAt: "2026-10-05T12:00:00.000Z",
    succeededAt: null,
    expiresAt: null,
  };

  it("unparsed or out-of-range amounts disable submit", async () => {
    const onSubmit = vi.fn<(amountCents: number, reason: string) => Promise<void>>(async () => {});
    wrap(
      <Dialog open>
        <DisputeForm payment={payment} kind="refund" onSubmit={onSubmit} />
      </Dialog>,
    );
    expect(disabled("treasury-dispute-submit")).toBe(false);
    type("treasury-dispute-amount", "abc");
    await waitFor(() => expect(disabled("treasury-dispute-submit")).toBe(true));
    type("treasury-dispute-amount", "10.01");
    await waitFor(() => expect(disabled("treasury-dispute-submit")).toBe(true));
    type("treasury-dispute-amount", "4.00");
    await waitFor(() => expect(disabled("treasury-dispute-submit")).toBe(false));
    fireEvent.change(screen.getByTestId("treasury-dispute-reason"), { target: { value: " duplicate " } });
    fireEvent.click(screen.getByTestId("treasury-dispute-submit"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(400, "duplicate"));
  });
});

describe("CostForm", () => {
  it("refuses the reserved category and unparsed amounts", async () => {
    wrap(<CostForm currency="eur" onSubmit={vi.fn<(input: CostInput) => Promise<void>>(async () => {})} />);
    type("treasury-cost-category", "payment-fees");
    type("treasury-cost-amount", "12.00");
    await waitFor(() => expect(disabled("treasury-cost-submit")).toBe(true));
    expect(screen.getByText(en["treasury.cost.categoryReserved"])).toBeTruthy();
    type("treasury-cost-category", "hosting");
    await waitFor(() => expect(disabled("treasury-cost-submit")).toBe(false));
    type("treasury-cost-amount", "12,x");
    await waitFor(() => expect(disabled("treasury-cost-submit")).toBe(true));
  });

  it("submits integer cents in the given currency and clears every field afterwards", async () => {
    const onSubmit = vi.fn<(input: CostInput) => Promise<void>>(async () => {});
    wrap(<CostForm currency="eur" onSubmit={onSubmit} />);
    type("treasury-cost-category", " Hosting ");
    type("treasury-cost-description", "October VPS");
    type("treasury-cost-amount", "42.5");
    await waitFor(() => expect(disabled("treasury-cost-submit")).toBe(false));
    expect(screen.getByText("EUR")).toBeTruthy();
    fireEvent.click(screen.getByTestId("treasury-cost-submit"));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ category: "hosting", description: "October VPS", amountCents: 4250 }),
    );
    await waitFor(() => expect((screen.getByTestId("treasury-cost-amount") as HTMLInputElement).value).toBe("0.00"));
    expect((screen.getByTestId("treasury-cost-category") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("treasury-cost-description") as HTMLInputElement).value).toBe("");
    expect(disabled("treasury-cost-submit")).toBe(true);
  });
});

describe("PayoutAccountForm", () => {
  it("needs a reference while payouts are enabled", async () => {
    const onSubmit = vi.fn<(input: PayoutAccountInput) => Promise<void>>(async () => {});
    wrap(<PayoutAccountForm onSubmit={onSubmit} />);
    type("treasury-account-username", "rivertide");
    expect(disabled("treasury-account-submit")).toBe(true);
    expect(screen.getByText(en["treasury.account.referenceRequired"])).toBeTruthy();
    fireEvent.click(screen.getByTestId("treasury-account-enabled"));
    await waitFor(() => expect(disabled("treasury-account-submit")).toBe(false));
    fireEvent.click(screen.getByTestId("treasury-account-enabled"));
    type("treasury-account-reference", "ledger-7");
    await waitFor(() => expect(disabled("treasury-account-submit")).toBe(false));
    fireEvent.click(screen.getByTestId("treasury-account-submit"));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ username: "rivertide", reference: "ledger-7", payoutsEnabled: true }),
    );
  });
});
