// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * "Your payments" when its first load fails: a 429 (`RATE_LIMITED` with `retryAfterSeconds`)
 * retries by itself after the server's wait and then shows the rows, saying so meanwhile; any
 * other failure waits for Retry, and Retry is always there (CI run 42294978314: one per-user 429
 * left the section on "Your payments didn't load. Refresh the page to retry.").
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type PaymentsLoader, YourPayments } from "../src/components/money/breakdown-payments.tsx";
import type { PaymentBreakdownDto } from "../src/components/money/breakdown-table.tsx";
import type { Page } from "../src/components/money/use-load.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { AUTO_RETRY_ATTEMPTS, AUTO_RETRY_MAX_MS } from "../src/lib/retry.ts";

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PAY = "0192f000-0000-7000-8000-0000000000aa";
const TX = "0192f000-0000-7000-8000-0000000000b1";
const usd = (cents: number) => ({ cents, currency: "usd" });

function payment(): PaymentBreakdownDto {
  return {
    paymentId: PAY,
    kind: "tip",
    channel: { slug: "rivertide", displayName: "Rivertide" },
    viewerRole: "payer",
    payer: null,
    gross: usd(500),
    succeededAt: "2026-10-01T12:00:00.000Z",
    lines: [
      { kind: "creator", amount: usd(450), recipientUserId: null, component: null, transactionId: TX },
      { kind: "coop_share", amount: usd(50), recipientUserId: null, component: null, transactionId: TX },
      { kind: "coop_net", amount: usd(50), recipientUserId: null, component: null, transactionId: TX },
    ],
    holdReleasesAt: null,
    holdReleasedAt: null,
    cutSource: { historyId: null, changedAt: null, proposalId: null, streamerShare: 0.9, coopShare: 0.1 },
    timeline: [{ kind: "paid", at: "2026-10-01T12:00:00.000Z", amount: usd(500), transactionId: TX }],
  };
}

const page: Page<PaymentBreakdownDto> = { items: [payment()], nextCursor: null };

/** The oRPC client's error for a full per-user bucket, as the API sends it. */
const rateLimited = (retryAfterSeconds: number) =>
  Object.assign(new Error("Too many requests"), {
    code: "RATE_LIMITED",
    status: 429,
    data: { retryAfterSeconds },
  });
const internal = () =>
  Object.assign(new Error("Internal server error"), { code: "INTERNAL_SERVER_ERROR", status: 500 });

function show(load: PaymentsLoader) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <YourPayments load={load} />
        </TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

/** Run timers (and the promises they settle) for `ms`. */
const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="breakdown-open"]')];
const loadError = () => document.querySelector<HTMLElement>('[data-testid="payments-load-error"]');
const retryButton = () => loadError()?.querySelector("button") ?? null;

describe("YourPayments, first load failing", () => {
  it("a RATE_LIMITED answer retries after its retryAfterSeconds and then shows the rows", async () => {
    const load = vi.fn<PaymentsLoader>().mockRejectedValueOnce(rateLimited(5)).mockResolvedValue(page);
    show(load);
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);
    // While it waits it says it is retrying, with Retry now; never "Refresh the page".
    expect(loadError()?.dataset.busy).toBe("true");
    expect(loadError()?.textContent).toContain("Your payments didn't load.");
    expect(loadError()?.textContent).toContain("Retrying in 5 seconds");
    expect(document.body.textContent).not.toContain("Refresh the page");

    // Not before the server's wait is over.
    await elapse(4_999);
    expect(load).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(rows().map((el) => el.dataset.paymentId)).toEqual([PAY]);
    expect(loadError()).toBeNull();
  });

  it("a RATE_LIMITED retry stays bounded: it never waits longer than the cap, and a few tries only", async () => {
    const load = vi.fn<PaymentsLoader>().mockRejectedValue(rateLimited(3_600));
    show(load);
    await elapse(0);
    for (let i = 1; i <= AUTO_RETRY_ATTEMPTS; i++) {
      await elapse(AUTO_RETRY_MAX_MS);
      expect(load).toHaveBeenCalledTimes(1 + i);
    }
    await elapse(10 * AUTO_RETRY_MAX_MS);
    expect(load).toHaveBeenCalledTimes(1 + AUTO_RETRY_ATTEMPTS);
    // Out of retries: still Retry, not a dead end, and it loads again.
    expect(loadError()?.dataset.busy).toBeUndefined();
    expect(loadError()?.textContent).toContain("Still not loading.");
    load.mockResolvedValueOnce(page);
    fireEvent.click(retryButton() as HTMLElement);
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(2 + AUTO_RETRY_ATTEMPTS);
    expect(rows()).toHaveLength(1);
  });

  it("any other failure shows the error state, does not retry by itself, and Retry loads again", async () => {
    const load = vi.fn<PaymentsLoader>().mockRejectedValueOnce(internal()).mockResolvedValue(page);
    show(load);
    await elapse(0);
    expect(loadError()?.textContent).toContain("Your payments didn't load.");
    expect(loadError()?.dataset.busy).toBeUndefined();
    await elapse(10 * AUTO_RETRY_MAX_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);
    fireEvent.click(retryButton() as HTMLElement);
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
    expect(loadError()).toBeNull();
  });
});
