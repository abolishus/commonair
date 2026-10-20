// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The Support dialog against a stubbed client: load on open, tabs, checkout, instructions, errors. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SupportButton, type SupportClient } from "../src/components/support/support-dialog.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { CheckoutRequest, CheckoutResult, SupportInfo } from "../src/lib/support.ts";
import { subscription, supportInfo } from "./support-fixtures.ts";

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

const instructions: CheckoutResult = {
  kind: "instructions",
  paymentId: "0192f000-0000-7000-8000-0000000000aa",
  reference: "CA-7K2M9QXA",
  instructions: "Pay the co-op by bank transfer.",
  amount: { cents: 999, currency: "usd" },
};

function client(info: SupportInfo, checkout: (r: CheckoutRequest) => Promise<CheckoutResult>) {
  const support = vi.fn<SupportClient["support"]>(async () => info);
  const checkoutFn = vi.fn<SupportClient["checkout"]>(checkout);
  return { support, checkout: checkoutFn };
}

const id = (testId: string) => screen.getByTestId(testId);

async function open(c: SupportClient) {
  wrap(<SupportButton channel="rivertide" channelName="Rivertide" signedIn client={c} />);
  fireEvent.click(id("support-open"));
  await waitFor(() => expect(screen.queryByTestId("support-submit")).not.toBeNull());
}

describe("Support dialog", () => {
  it("signed out, support-open is a link to /signin", () => {
    wrap(<SupportButton channel="rivertide" channelName="Rivertide" signedIn={false} />);
    const link = id("support-open");
    expect([link.tagName, link.getAttribute("href")]).toEqual(["A", "/signin"]);
  });

  it("loads money.support on open and subscribes to the chosen tier", async () => {
    const c = client(supportInfo(), async () => instructions);
    wrap(<SupportButton channel="rivertide" channelName="Rivertide" signedIn client={c} />);
    expect(c.support).not.toHaveBeenCalled();
    fireEvent.click(id("support-open"));
    await waitFor(() => expect(screen.queryByTestId("support-submit")).not.toBeNull());
    expect(c.support).toHaveBeenCalledWith({ channel: "rivertide" });
    expect(id("support-dialog").getAttribute("data-provider")).toBe("manual");
    const tiers = screen.getAllByTestId("support-tier");
    expect(tiers.map((t) => [t.getAttribute("data-tier"), t.getAttribute("data-cents")])).toEqual([
      ["1", "499"],
      ["2", "999"],
      ["3", "2499"],
    ]);
    fireEvent.click(tiers[1] as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId("support-tier")[1]?.getAttribute("aria-checked")).toBe("true"));
    expect(id("support-total").getAttribute("data-cents")).toBe("999");
    expect([
      id("support-split").getAttribute("data-streamer-share"),
      id("support-split").getAttribute("data-coop-share"),
    ]).toEqual(["0.9", "0.1"]);
    await act(async () => {
      fireEvent.click(id("support-submit"));
    });
    expect(c.checkout).toHaveBeenCalledWith({
      kind: "subscribe",
      input: { channel: "rivertide", tier: 2, returnPath: "/rivertide" },
    });
    await waitFor(() => expect(screen.queryByTestId("support-instructions")).not.toBeNull());
    expect(id("support-instructions").getAttribute("data-payment-id")).toBe(instructions.paymentId);
    expect(id("support-reference").getAttribute("data-reference")).toBe("CA-7K2M9QXA");
    expect(id("support-reference").textContent).toBe("CA-7K2M9QXA");
    expect(id("support-amount").getAttribute("data-cents")).toBe("999");
    expect(screen.getByRole("button", { name: "Copy reference" })).toBeTruthy();
    expect(screen.queryByTestId("support-submit")).toBeNull();
  });

  it("scopes the channel accent to the dialog, which renders outside the channel header", async () => {
    const c = client(supportInfo(), async () => instructions);
    wrap(<SupportButton channel="rivertide" channelName="Rivertide" accent="teal" signedIn client={c} />);
    fireEvent.click(id("support-open"));
    await waitFor(() => expect(screen.queryByTestId("support-submit")).not.toBeNull());
    expect(id("support-dialog").getAttribute("data-accent")).toBe("teal");
    expect(id("support-submit").closest("[data-accent]")).toBe(id("support-dialog"));
  });

  it("without an accent the dialog inherits the default accent tokens", async () => {
    await open(client(supportInfo(), async () => instructions));
    expect(id("support-dialog").hasAttribute("data-accent")).toBe(false);
  });

  it("disables the submit while in flight and checks out once", async () => {
    let resolve: (r: CheckoutResult) => void = () => {};
    const c = client(supportInfo(), () => new Promise((r) => (resolve = r)));
    await open(c);
    const submit = id("support-submit") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    expect(c.checkout).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    await act(async () => resolve(instructions));
    await waitFor(() => expect(screen.queryByTestId("support-instructions")).not.toBeNull());
  });

  it("shows the API's refusal in support-error and keeps the form", async () => {
    const c = client(supportInfo(), async () => {
      throw Object.assign(new Error("Only 1 viewer can receive a gift"), { code: "PRECONDITION_FAILED" });
    });
    await open(c);
    fireEvent.click(id("support-tab-gift"));
    await waitFor(() => expect(screen.queryByTestId("support-gift-count")).not.toBeNull());
    fireEvent.change(id("support-gift-count"), { target: { value: "2" } });
    expect(id("support-total").getAttribute("data-cents")).toBe("998");
    await act(async () => {
      fireEvent.click(id("support-submit"));
    });
    expect(c.checkout).toHaveBeenCalledWith({
      kind: "subscribe",
      input: { channel: "rivertide", tier: 1, gift: { count: 2 }, returnPath: "/rivertide" },
    });
    await waitFor(() => expect(id("support-error").textContent).toContain("Only 1 viewer can receive a gift"));
    expect(screen.queryByTestId("support-submit")).not.toBeNull();
  });

  it("gift to a named viewer: count is 1 and the username is sent", async () => {
    const c = client(supportInfo(), async () => instructions);
    await open(c);
    fireEvent.click(id("support-tab-gift"));
    await waitFor(() => expect(screen.queryByTestId("support-gift-recipient")).not.toBeNull());
    fireEvent.click(id("support-gift-recipient-viewer"));
    await waitFor(() => expect(screen.queryByTestId("support-gift-to")).not.toBeNull());
    expect(screen.queryByTestId("support-gift-count")).toBeNull();
    expect((id("support-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(id("support-gift-to"), { target: { value: "mothwing" } });
    expect((id("support-submit") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(id("support-submit"));
    });
    expect(c.checkout.mock.calls[0]?.[0]).toMatchObject({ input: { gift: { count: 1, to: "mothwing" } } });
  });

  it("tips: amount, message and anonymity", async () => {
    const c = client(supportInfo(), async () => instructions);
    await open(c);
    fireEvent.click(id("support-tab-tip"));
    await waitFor(() => expect(screen.queryByTestId("support-tip-amount")).not.toBeNull());
    fireEvent.change(id("support-tip-amount"), { target: { value: "5.00" } });
    expect(id("support-tip-amount").getAttribute("data-cents")).toBe("500");
    fireEvent.change(id("support-tip-message"), { target: { value: "Great stream" } });
    fireEvent.click(id("support-tip-anonymous"));
    expect(id("support-total").getAttribute("data-cents")).toBe("500");
    await act(async () => {
      fireEvent.click(id("support-submit"));
    });
    expect(c.checkout).toHaveBeenCalledWith({
      kind: "tip",
      input: {
        channel: "rivertide",
        amountCents: 500,
        message: "Great stream",
        anonymous: true,
        returnPath: "/rivertide",
      },
    });
  });

  it("tips: unparsed amount text blocks checkout until it parses", async () => {
    const c = client(supportInfo(), async () => instructions);
    await open(c);
    fireEvent.click(id("support-tab-tip"));
    await waitFor(() => expect(screen.queryByTestId("support-tip-amount")).not.toBeNull());
    for (const text of ["", "5.001", "five"]) {
      fireEvent.change(id("support-tip-amount"), { target: { value: text } });
      expect(id("support-tip-amount").getAttribute("data-cents")).toBe("");
      expect(id("support-total").getAttribute("data-cents")).toBe("0");
      expect((id("support-submit") as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/^Enter an amount, like/)).toBeTruthy();
    fireEvent.change(id("support-tip-amount"), { target: { value: "7" } });
    expect(id("support-total").getAttribute("data-cents")).toBe("700");
    expect((id("support-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("tips: an unparsed amount left on another tab does not block checkout on return", async () => {
    const c = client(supportInfo(), async () => instructions);
    await open(c);
    const submitDisabled = () => (id("support-submit") as HTMLButtonElement).disabled;
    const clearThenLeave = async () => {
      fireEvent.click(id("support-tab-tip"));
      await waitFor(() => expect(screen.queryByTestId("support-tip-amount")).not.toBeNull());
      fireEvent.change(id("support-tip-amount"), { target: { value: "" } });
      expect(submitDisabled()).toBe(true);
      fireEvent.click(id("support-tab-gift"));
      // The tip panel unmounts once it has left (Base UI panels are not kept mounted).
      await waitFor(() => expect(screen.queryByTestId("support-tip-amount")).toBeNull());
      fireEvent.click(id("support-tab-tip"));
      await waitFor(() => expect(screen.queryByTestId("support-tip-amount")).not.toBeNull());
    };
    await clearThenLeave();
    // The remounted field shows the last parsed amount, and checkout agrees.
    expect(submitDisabled()).toBe(false);
    fireEvent.change(id("support-tip-amount"), { target: { value: "7" } });
    expect(id("support-total").getAttribute("data-cents")).toBe("700");
    expect(submitDisabled()).toBe(false);
    await clearThenLeave();
    fireEvent.click(screen.getByText("$10.00"));
    expect(id("support-total").getAttribute("data-cents")).toBe("1000");
    expect(submitDisabled()).toBe(false);
  });

  it("gift: clearing the count leaves no preset pressed", async () => {
    await open(client(supportInfo(), async () => instructions));
    fireEvent.click(id("support-tab-gift"));
    await waitFor(() => expect(screen.queryByTestId("support-gift-count")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(screen.getByRole("button", { name: "5" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(id("support-gift-count"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "5" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("no tiers: sub and gift disabled with the reason, opens on tip", async () => {
    await open(client(supportInfo({ tiers: [] }), async () => instructions));
    expect(
      id("support-tab-sub").hasAttribute("disabled") || id("support-tab-sub").getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(
      id("support-tab-gift").hasAttribute("disabled") ||
        id("support-tab-gift").getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(screen.getByText("This channel has not set up subscriptions yet, but it takes tips.")).toBeTruthy();
    expect(screen.queryByTestId("support-tip-amount")).not.toBeNull();
  });

  it("an active subscription shows support-current and closes the sub tab", async () => {
    const info = supportInfo({ viewer: { isOwner: false, subscription: subscription({ status: "active", tier: 2 }) } });
    await open(client(info, async () => instructions));
    const current = id("support-current");
    expect([current.getAttribute("data-status"), current.getAttribute("data-tier")]).toEqual(["active", "2"]);
    expect(
      id("support-tab-sub").hasAttribute("disabled") || id("support-tab-sub").getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });
});
