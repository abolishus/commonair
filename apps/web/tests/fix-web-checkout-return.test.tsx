// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F12 (web): back from checkout with `?checkout=success&payment=<id>` the channel page says the
 * payment arrived and polls it until it is confirmed, then "You're subscribed" (with the co-op
 * line only when the sub makes the payer a member); `?checkout=canceled` is a quiet note. The
 * params are stripped with `replaceState` and the rest of the URL is kept.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PaymentBreakdownDto } from "../src/components/money/breakdown-table.tsx";
import {
  CheckoutReturn,
  creatorCents,
  readCheckoutReturn,
  withoutCheckoutParams,
  type CheckoutReturnClient,
} from "../src/components/money/checkout-return.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const PAY = "0192f000-0000-7000-8000-0000000000a1";
const usd = (cents: number) => ({ cents, currency: "usd" });

function payment(over: Partial<PaymentBreakdownDto> = {}): PaymentBreakdownDto {
  return {
    paymentId: PAY,
    kind: "subscription",
    channel: { slug: "fern", displayName: "Fernsby" },
    viewerRole: "payer",
    payer: null,
    gross: usd(500),
    succeededAt: "2026-11-06T12:00:00.000Z",
    lines: [
      { kind: "creator", amount: usd(450), recipientUserId: "u1", component: null, transactionId: "t1" },
      { kind: "coop_share", amount: usd(50), recipientUserId: null, component: null, transactionId: "t1" },
    ],
    holdReleasesAt: null,
    holdReleasedAt: null,
    cutSource: { historyId: null, changedAt: null, proposalId: null, streamerShare: 0.9, coopShare: 0.1 },
    timeline: [],
    ...over,
  };
}

const notYet = () => Object.assign(new Error("Payment not found"), { code: "NOT_FOUND" });

function at(url: string): void {
  window.history.replaceState({ key: "k1" }, "", url);
}

function mount(client: CheckoutReturnClient, opts: { pollMs?: number; slowMs?: number } = {}) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <CheckoutReturn channelName="Fernsby" client={client} pollMs={opts.pollMs ?? 5} slowMs={opts.slowMs ?? 5000} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  at("/");
});

describe("readCheckoutReturn", () => {
  it("reads a success with its payment id, and a cancel", () => {
    expect(readCheckoutReturn(`?checkout=success&payment=${PAY}`)).toEqual({ outcome: "success", paymentId: PAY });
    expect(readCheckoutReturn(`?checkout=success&payment=${PAY.toUpperCase()}`)).toEqual({
      outcome: "success",
      paymentId: PAY,
    });
    expect(readCheckoutReturn("?checkout=canceled")).toEqual({ outcome: "canceled" });
  });
  it("ignores anything else", () => {
    expect(readCheckoutReturn("")).toBeNull();
    expect(readCheckoutReturn("?tab=clips")).toBeNull();
    expect(readCheckoutReturn("?checkout=success")).toBeNull();
    expect(readCheckoutReturn("?checkout=success&payment=../../x")).toBeNull();
    expect(readCheckoutReturn(`?checkout=paid&payment=${PAY}`)).toBeNull();
  });
});

describe("withoutCheckoutParams", () => {
  it("drops only the return params, keeping the path, the rest of the query and the hash", () => {
    expect(withoutCheckoutParams(`https://a.example/fern?tab=clips&checkout=success&payment=${PAY}#chat`)).toBe(
      "/fern?tab=clips#chat",
    );
    expect(withoutCheckoutParams("https://a.example/fern?checkout=canceled")).toBe("/fern");
    expect(withoutCheckoutParams("/fern")).toBe("/fern");
  });
});

describe("creatorCents", () => {
  it("sums the creator lines only", () => {
    expect(creatorCents(payment())).toBe(450);
    expect(creatorCents(payment({ lines: [] }))).toBe(0);
  });
});

describe("CheckoutReturn", () => {
  it("renders nothing without return params", () => {
    at("/fern?tab=clips");
    const client = {
      payment: vi.fn<CheckoutReturnClient["payment"]>(),
      joinsCoop: vi.fn<CheckoutReturnClient["joinsCoop"]>(),
    };
    const { container } = mount(client);
    expect(container.textContent).toBe("");
    expect(client.payment).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=clips");
  });

  it("a cancel: a quiet note, and the params are gone from the address bar", () => {
    at("/fern?checkout=canceled&tab=about");
    const client = {
      payment: vi.fn<CheckoutReturnClient["payment"]>(),
      joinsCoop: vi.fn<CheckoutReturnClient["joinsCoop"]>(),
    };
    mount(client);
    const note = screen.getByTestId("checkout-return");
    expect(note.dataset.state).toBe("canceled");
    expect(note.textContent).toBe(t("fixWeb.checkout.canceled"));
    expect(window.location.pathname + window.location.search).toBe("/fern?tab=about");
    expect(window.history.state).toEqual({ key: "k1" });
    expect(client.payment).not.toHaveBeenCalled();
  });

  it("a success: confirming, polling until the payment is there, then subscribed with the co-op line", async () => {
    at(`/fern?checkout=success&payment=${PAY}`);
    let calls = 0;
    const client: CheckoutReturnClient = {
      payment: vi.fn<CheckoutReturnClient["payment"]>(async (id) => {
        expect(id).toBe(PAY);
        calls++;
        if (calls < 3) throw notYet();
        return payment();
      }),
      joinsCoop: vi.fn<CheckoutReturnClient["joinsCoop"]>(async () => true),
    };
    mount(client);
    expect(screen.getByTestId("checkout-return").dataset.state).toBe("pending");
    expect(screen.getByTestId("checkout-return").textContent).toContain(
      t("fixWeb.checkout.pending", { channel: "Fernsby" }),
    );
    expect(window.location.search).toBe("");
    await waitFor(() => expect(screen.getByTestId("checkout-return").dataset.state).toBe("confirmed"));
    const done = screen.getByTestId("checkout-return");
    expect(calls).toBe(3);
    expect(done.textContent).toContain(t("fixWeb.checkout.subscribed", { channel: "Fernsby" }));
    expect(done.textContent).toContain("$4.50");
    expect(done.textContent).toContain("$5.00");
    expect(screen.getByTestId("checkout-return-coop").textContent).toBe(t("fixWeb.checkout.joinsCoop"));
    expect(done.dataset.joinsCoop).toBe("true");
  });

  it("no co-op line when the sub does not make the payer a member (or the check fails)", async () => {
    at(`/fern?checkout=success&payment=${PAY}`);
    mount({ payment: async () => payment(), joinsCoop: async () => false });
    await waitFor(() => expect(screen.getByTestId("checkout-return").dataset.state).toBe("confirmed"));
    expect(screen.queryByTestId("checkout-return-coop")).toBeNull();
    cleanup();

    at(`/fern?checkout=success&payment=${PAY}`);
    mount({ payment: async () => payment(), joinsCoop: () => Promise.reject(new Error("429")) });
    await waitFor(() => expect(screen.getByTestId("checkout-return").dataset.state).toBe("confirmed"));
    expect(screen.queryByTestId("checkout-return-coop")).toBeNull();
  });

  it("a tip: thanks without the membership check", async () => {
    at(`/fern?checkout=success&payment=${PAY}`);
    const joinsCoop = vi.fn<CheckoutReturnClient["joinsCoop"]>(async () => true);
    mount({ payment: async () => payment({ kind: "tip", gross: usd(1000) }), joinsCoop });
    await waitFor(() => expect(screen.getByTestId("checkout-return").dataset.state).toBe("confirmed"));
    expect(screen.getByTestId("checkout-return").textContent).toContain(
      t("fixWeb.checkout.tipped", { channel: "Fernsby" }),
    );
    expect(joinsCoop).not.toHaveBeenCalled();
    expect(screen.queryByTestId("checkout-return-coop")).toBeNull();
  });

  it("says it is taking a while after the slow limit, and stops polling", async () => {
    vi.useFakeTimers();
    at(`/fern?checkout=success&payment=${PAY}`);
    const pay = vi.fn<CheckoutReturnClient["payment"]>(() => Promise.reject(notYet()));
    mount({ payment: pay, joinsCoop: async () => false }, { pollMs: 100, slowMs: 300 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const slow = screen.getByTestId("checkout-return");
    expect(slow.dataset.state).toBe("slow");
    expect(slow.textContent).toContain(t("fixWeb.checkout.slow"));
    const asked = pay.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(pay.mock.calls.length).toBe(asked);
  });

  it("stops polling when the page goes away", async () => {
    vi.useFakeTimers();
    at(`/fern?checkout=success&payment=${PAY}`);
    const pay = vi.fn<CheckoutReturnClient["payment"]>(() => Promise.reject(notYet()));
    const { unmount } = mount({ payment: pay, joinsCoop: async () => false }, { pollMs: 100, slowMs: 10_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    unmount();
    const asked = pay.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pay.mock.calls.length).toBe(asked);
  });
});
