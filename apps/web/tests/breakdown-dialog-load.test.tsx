// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The breakdown dialog and the fee schedule when their load fails: a 429 (`RATE_LIMITED` with
 * `retryAfterSeconds`) retries by itself after the server's wait and then renders, saying so
 * meanwhile; any other failure waits for Retry. Before, both said "Refresh the page to retry"
 * with no Retry, the same dead end "Your payments" had in CI run 42294978314.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BreakdownOpenButton } from "../src/components/money/breakdown-dialog.tsx";
import type { PaymentBreakdownDto } from "../src/components/money/breakdown-table.tsx";
import { FeeSchedule, type FeeScheduleEntryDto } from "../src/components/money/fee-schedule.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { AUTO_RETRY_MAX_MS } from "../src/lib/retry.ts";

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

const breakdown: PaymentBreakdownDto = {
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

const schedule: FeeScheduleEntryDto[] = [
  {
    id: null,
    key: "platform.cut",
    value: { streamerShare: 0.9, coopShare: 0.1 },
    previous: null,
    changedAt: null,
    proposalId: null,
  },
];

const rateLimited = (retryAfterSeconds: number) =>
  Object.assign(new Error("Too many requests"), {
    code: "RATE_LIMITED",
    status: 429,
    data: { retryAfterSeconds },
  });
const internal = () =>
  Object.assign(new Error("Internal server error"), { code: "INTERNAL_SERVER_ERROR", status: 500 });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const byId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const retryIn = (id: string) => byId(id)[0]?.querySelector("button") ?? null;

describe("breakdown dialog, load failing", () => {
  type Load = (id: string) => Promise<PaymentBreakdownDto>;
  async function open(paymentBreakdown: Load) {
    wrap(<BreakdownOpenButton paymentId={PAY} client={{ paymentBreakdown }} />);
    fireEvent.click(byId("breakdown-open")[0] as HTMLElement);
    await elapse(0);
  }

  it("a RATE_LIMITED answer retries after its retryAfterSeconds and then shows the breakdown", async () => {
    const load = vi.fn<Load>().mockRejectedValueOnce(rateLimited(5)).mockResolvedValue(breakdown);
    await open(load);
    expect(load).toHaveBeenCalledTimes(1);
    const error = byId("breakdown-load-error")[0];
    expect(error?.dataset.busy).toBe("true");
    expect(error?.textContent).toContain("Retrying in 5 seconds");
    expect(document.body.textContent).not.toContain("Refresh the page");
    await elapse(4_999);
    expect(load).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(byId("breakdown-line")).toHaveLength(3);
    expect(byId("breakdown-load-error")).toHaveLength(0);
  });

  it("any other failure does not retry by itself, and Retry loads it", async () => {
    const load = vi.fn<Load>().mockRejectedValueOnce(internal()).mockResolvedValue(breakdown);
    await open(load);
    expect(byId("breakdown-load-error")[0]?.dataset.busy).toBeUndefined();
    await elapse(10 * AUTO_RETRY_MAX_MS);
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(retryIn("breakdown-load-error") as HTMLElement);
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(byId("breakdown-line")).toHaveLength(3);
    expect(byId("breakdown-load-error")).toHaveLength(0);
  });
});

describe("fee schedule, load failing", () => {
  type Load = () => Promise<FeeScheduleEntryDto[]>;

  it("a RATE_LIMITED answer retries after its retryAfterSeconds and then shows the schedule", async () => {
    const load = vi.fn<Load>().mockRejectedValueOnce(rateLimited(5)).mockResolvedValue(schedule);
    wrap(<FeeSchedule load={load} />);
    await elapse(0);
    const error = byId("fee-schedule-load-error")[0];
    expect(error?.dataset.busy).toBe("true");
    expect(error?.textContent).toContain("Retrying in 5 seconds");
    expect(document.body.textContent).not.toContain("Refresh the page");
    await elapse(4_999);
    expect(load).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(byId("fee-schedule-row")).toHaveLength(1);
    expect(byId("fee-schedule-load-error")).toHaveLength(0);
  });

  it("any other failure does not retry by itself, and Retry loads it", async () => {
    const load = vi.fn<Load>().mockRejectedValueOnce(internal()).mockResolvedValue(schedule);
    wrap(<FeeSchedule load={load} />);
    await elapse(0);
    expect(byId("fee-schedule-load-error")[0]?.dataset.busy).toBeUndefined();
    await elapse(10 * AUTO_RETRY_MAX_MS);
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(retryIn("fee-schedule-load-error") as HTMLElement);
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(byId("fee-schedule-row")).toHaveLength(1);
    expect(byId("fee-schedule-load-error")).toHaveLength(0);
  });
});
