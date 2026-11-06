// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The treasury `refunds` and `transfers` tabs with their data (follow-ups, unit money): what each
 * calls on `money.treasurer.*`, what it tells the treasurer, and that a settle (or a conflict with
 * one made meanwhile) reloads both the list and the outcome-unknown summary above it. The oRPC
 * client is replaced by a fake answering with contract-shaped fixtures; the panels, dialogs and
 * `usePaged` run as they do in the app.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OutcomeUnknownDto } from "../src/components/treasury/outcome-unknown-summary.tsx";
import type { PayoutTransferDto } from "../src/components/treasury/payout-transfers.tsx";
import type { RefundRequestDto } from "../src/components/treasury/refund-requests.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

// Dialogs, the select and two loads per settle: on a busy CI runner they can take longer than
// testing-library's 1 s default.
configure({ asyncUtilTimeout: 5_000 });

const fake = vi.hoisted(() => ({
  outcomeUnknown: vi.fn<() => Promise<unknown>>(),
  transfers: vi.fn<(input: { limit: number; cursor?: string }) => Promise<unknown>>(),
  settleTransfer: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(),
  list: vi.fn<(input: { state: string; limit: number; cursor?: string }) => Promise<unknown>>(),
  resolve: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(),
  recheck: vi.fn<(input: { requestId: string }) => Promise<{ result: string }>>(),
  toast: {
    success: vi.fn<(message: unknown, options?: unknown) => void>(),
    error: vi.fn<(message: unknown, options?: unknown) => void>(),
    info: vi.fn<(message: unknown, options?: unknown) => void>(),
    warning: vi.fn<(message: unknown, options?: unknown) => void>(),
  },
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    money: {
      treasurer: {
        outcomeUnknown: () => fake.outcomeUnknown(),
        transfers: (input: { limit: number; cursor?: string }) => fake.transfers(input),
        settleTransfer: (input: Record<string, unknown>) => fake.settleTransfer(input),
        refundRequests: {
          list: (input: { state: string; limit: number; cursor?: string }) => fake.list(input),
          resolve: (input: Record<string, unknown>) => fake.resolve(input),
          recheck: (input: { requestId: string }) => fake.recheck(input),
        },
      },
    },
  };
  return { ...actual, api: () => client };
});
vi.mock("@commonair/ui/toast", () => ({ toast: fake.toast }));

const { OutcomeUnknownSummary } = await import("../src/components/treasury/outcome-unknown-summary.tsx");
const { PayoutTransfers, PayoutTransfersPanel } = await import("../src/components/treasury/payout-transfers.tsx");
const { RefundRequests } = await import("../src/components/treasury/refund-requests.tsx");

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

/** An oRPC-shaped failure (`errorCode` reads `.code`). */
const rpcError = (code: string) => Object.assign(new Error(code), { code });
const usd = (cents: number) => ({ cents, currency: "usd" });
// The tabs read the real clock for the 15-minute rule: an hour ago is past it.
const hourAgo = () => new Date(Date.now() - 60 * 60_000).toISOString();

const SUMMARY: OutcomeUnknownDto = {
  refunds: { count: 1, amounts: [usd(2_500)] },
  transfers: { count: 1, amounts: [usd(9_000)] },
  patronagePayouts: { count: 0, amounts: [] },
};

function transfer(n: number, over: Partial<PayoutTransferDto> = {}): PayoutTransferDto {
  const tail = String(n).padStart(12, "0");
  return {
    id: `0195f0c2-6a4b-7c3d-8e9f-${tail}`,
    payoutId: `0195f0c2-6a4b-7c3d-8e9e-${tail}`,
    user: { id: `0195f0c2-6a4b-7c3d-8e9d-${tail}`, username: `creator${n}`, displayName: "Ada" },
    periodStart: "2026-10-01T00:00:00.000Z",
    amount: usd(9_000),
    reversed: usd(0),
    status: "pending",
    failureCode: "outcome_unknown",
    providerRef: null,
    createdAt: hourAgo(),
    updatedAt: hourAgo(),
    ...over,
  };
}

function request(n: number, over: Partial<RefundRequestDto> = {}): RefundRequestDto {
  const tail = String(n).padStart(12, "0");
  return {
    id: `01900000-0000-7000-8000-${tail}`,
    paymentId: `01900000-0000-7000-8001-${tail}`,
    paymentKind: "tip",
    provider: "stripe",
    amount: usd(2_500),
    requested: usd(2_500),
    state: "unknown",
    reason: null,
    requestedBy: { id: "01900000-0000-7000-8000-0000000000c1", username: "treasurer1" },
    markers: [{ action: "payment.refund_outcome_unknown", at: hourAgo() }],
    createdAt: hourAgo(),
    ...over,
  };
}

const page = <T,>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });

beforeEach(() => {
  for (const f of [fake.outcomeUnknown, fake.transfers, fake.settleTransfer, fake.list, fake.resolve, fake.recheck])
    f.mockReset();
  for (const f of Object.values(fake.toast)) f.mockReset();
  fake.outcomeUnknown.mockResolvedValue(SUMMARY);
});
afterEach(cleanup);

async function openSettle(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId("payout-transfer-settle"));
  return screen.findByTestId("payout-transfer-settle-dialog");
}

async function settleNotSent(): Promise<HTMLElement> {
  const dialog = await openSettle();
  fireEvent.click(within(dialog).getByRole("radio", { name: en["transferSettle.outcome.notSent"] }));
  const confirm = within(dialog).getByRole("button", { name: en["transferSettle.confirm"] });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
  return dialog;
}

describe("OutcomeUnknownSummary", () => {
  it("loads the summary and shows the callout", async () => {
    wrap(<OutcomeUnknownSummary />);
    const box = await screen.findByTestId("outcome-unknown-summary");
    expect([...box.querySelectorAll("li")].map((li) => li.dataset.kind)).toEqual(["refunds", "transfers"]);
    expect(fake.outcomeUnknown).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the load fails", async () => {
    fake.outcomeUnknown.mockRejectedValue(rpcError("FORBIDDEN"));
    const { container } = wrap(<OutcomeUnknownSummary />);
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("loads again when its version changes", async () => {
    const r = wrap(<OutcomeUnknownSummary version={0} />);
    await screen.findByTestId("outcome-unknown-summary");
    fake.outcomeUnknown.mockResolvedValue({ ...SUMMARY, refunds: { count: 0, amounts: [] } });
    r.rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <OutcomeUnknownSummary version={1} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        [...screen.getByTestId("outcome-unknown-summary").querySelectorAll("li")].map((li) => li.dataset.kind),
      ).toEqual(["transfers"]),
    );
  });
});

describe("PayoutTransfers tab", () => {
  it("loads the first page of 50 with the summary above it", async () => {
    fake.transfers.mockResolvedValue(page([transfer(1), transfer(2, { status: "created", failureCode: null })]));
    wrap(<PayoutTransfers />);
    await screen.findByTestId("outcome-unknown-summary");
    await waitFor(() => expect(document.querySelectorAll("[data-transfer-id]").length).toBeGreaterThanOrEqual(2));
    expect(fake.transfers).toHaveBeenCalledWith({ limit: 50, cursor: undefined });
  });

  it("settling as sent sends the reference, says so, and reloads list and summary", async () => {
    fake.transfers.mockResolvedValue(page([transfer(1)]));
    fake.settleTransfer.mockResolvedValue({});
    wrap(<PayoutTransfers />);
    const dialog = await openSettle();
    fireEvent.click(within(dialog).getByRole("radio", { name: en["transferSettle.outcome.sent"] }));
    fireEvent.change(await within(dialog).findByLabelText(en["transferSettle.reference"]), {
      target: { value: " tr_9Zz " },
    });
    fireEvent.change(within(dialog).getByLabelText(en["transferSettle.note"]), { target: { value: " seen it " } });
    const confirm = within(dialog).getByRole("button", { name: en["transferSettle.confirm"] });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(fake.toast.success).toHaveBeenCalledWith(en["transferSettle.done.sent"]));
    expect(fake.settleTransfer).toHaveBeenCalledWith({
      transferId: transfer(1).id,
      outcome: "sent",
      note: "seen it",
      reference: "tr_9Zz",
    });
    await waitFor(() => expect(fake.transfers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("payout-transfer-settle-dialog")).toBeNull());
  });

  it("settling as not sent sends no reference at all", async () => {
    fake.transfers.mockResolvedValue(page([transfer(1)]));
    fake.settleTransfer.mockResolvedValue({});
    wrap(<PayoutTransfers />);
    await settleNotSent();
    await waitFor(() => expect(fake.toast.success).toHaveBeenCalledWith(en["transferSettle.done.notSent"]));
    const input = fake.settleTransfer.mock.calls[0]?.[0];
    expect(input).toEqual({ transferId: transfer(1).id, outcome: "not_sent", note: "" });
    expect(input && "reference" in input).toBe(false);
  });

  it("a conflict (settled meanwhile) says it failed and reloads list and summary", async () => {
    fake.transfers.mockResolvedValue(page([transfer(1)]));
    fake.settleTransfer.mockRejectedValue(rpcError("CONFLICT"));
    wrap(<PayoutTransfers />);
    await settleNotSent();
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["transferSettle.error"]));
    expect(fake.toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.transfers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(2));
  });

  it("another failure says so and reloads nothing; an ended session says sign in", async () => {
    fake.transfers.mockResolvedValue(page([transfer(1)]));
    fake.settleTransfer.mockRejectedValueOnce(rpcError("INTERNAL_SERVER_ERROR"));
    wrap(<PayoutTransfers />);
    const dialog = await settleNotSent();
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["transferSettle.error"]));
    expect(fake.transfers).toHaveBeenCalledTimes(1);
    expect(fake.outcomeUnknown).toHaveBeenCalledTimes(1);
    // The dialog stays open to try again.
    expect(screen.getByTestId("payout-transfer-settle-dialog")).toBe(dialog);
    fake.settleTransfer.mockRejectedValueOnce(rpcError("UNAUTHORIZED"));
    fireEvent.click(within(dialog).getByRole("button", { name: en["transferSettle.confirm"] }));
    await waitFor(() =>
      expect(fake.toast.error).toHaveBeenLastCalledWith(en["auth.sessionExpired"], expect.anything()),
    );
  });

  it("a failed first load offers a retry that loads again", async () => {
    fake.transfers.mockRejectedValueOnce(rpcError("INTERNAL_SERVER_ERROR"));
    fake.transfers.mockResolvedValueOnce(page([transfer(1)]));
    wrap(<PayoutTransfers />);
    fireEvent.click(await screen.findByRole("button", { name: en["payoutTransfers.retry"] }));
    await screen.findByTestId("payout-transfer-settle");
    expect(fake.transfers).toHaveBeenCalledTimes(2);
  });

  it("a failed load without a retry handler offers no button that does nothing", () => {
    wrap(<PayoutTransfersPanel transfers={null} failed />);
    expect(screen.getByText(en["payoutTransfers.loadFailed.title"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["payoutTransfers.retry"] })).toBeNull();
  });

  it("loads more with the cursor; a failed page says so", async () => {
    fake.transfers.mockImplementation(async ({ cursor }) =>
      cursor === undefined ? page([transfer(1)], "c1") : Promise.reject(rpcError("INTERNAL_SERVER_ERROR")),
    );
    wrap(<PayoutTransfers />);
    fireEvent.click(await screen.findByRole("button", { name: en["payoutTransfers.loadMore"] }));
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["payoutTransfers.loadMoreFailed"]));
    expect(fake.transfers).toHaveBeenLastCalledWith({ limit: 50, cursor: "c1" });
  });
});

describe("RefundRequests tab", () => {
  async function openResolve(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByTestId("refund-request-resolve"));
    const dialog = await screen.findByTestId("refund-request-resolve-dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: en["refundRequests.resolve.outcome.failed"] }));
    fireEvent.change(within(dialog).getByLabelText(en["refundRequests.resolve.note"]), {
      target: { value: "  checked  " },
    });
    const confirm = within(dialog).getByRole("button", { name: en["refundRequests.resolve.confirm"] });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    return dialog;
  }

  async function recheck(): Promise<void> {
    fireEvent.click(await screen.findByTestId("refund-request-recheck"));
    const dialog = await screen.findByTestId("refund-request-recheck-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en["refundRecheck.confirm"] }));
  }

  it("lists outstanding requests first, and the filter loads the state chosen", async () => {
    fake.list.mockImplementation(async ({ state }) => page(state === "unknown" ? [request(1)] : []));
    wrap(<RefundRequests />);
    await screen.findByText(en["refundRequests.empty.title"]);
    expect(fake.list).toHaveBeenCalledWith({ state: "outstanding", limit: 50, cursor: undefined });
    fireEvent.click(document.getElementById("refund-request-state") as HTMLElement);
    const option = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-value="unknown"][role="option"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await screen.findByTestId("refund-request-unknown");
    expect(fake.list).toHaveBeenLastCalledWith({ state: "unknown", limit: 50, cursor: undefined });
  });

  it("a failed first load is an empty state whose retry loads again", async () => {
    fake.list.mockRejectedValueOnce(rpcError("INTERNAL_SERVER_ERROR"));
    fake.list.mockResolvedValueOnce(page([request(1)]));
    wrap(<RefundRequests />);
    await screen.findByText(en["refundRequests.loadFailed"]);
    expect(screen.queryByTestId("outcome-unknown-summary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en["refundRequests.retry"] }));
    await screen.findByTestId("refund-request-unknown");
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it("a failed later page says so and keeps the rows", async () => {
    fake.list.mockImplementation(async ({ cursor }) =>
      cursor === undefined ? page([request(1)], "c1") : Promise.reject(rpcError("INTERNAL_SERVER_ERROR")),
    );
    wrap(<RefundRequests />);
    fireEvent.click(await screen.findByRole("button", { name: en["refundRequests.loadMore"] }));
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["refundRequests.loadFailed"]));
    expect(fake.list).toHaveBeenLastCalledWith({ state: "outstanding", limit: 50, cursor: "c1" });
    expect(screen.getByTestId("refund-request-unknown")).toBeTruthy();
  });

  it("resolving sends the trimmed note, says so, and reloads list and summary", async () => {
    fake.list.mockResolvedValue(page([request(1)]));
    fake.resolve.mockResolvedValue({});
    wrap(<RefundRequests />);
    await openResolve();
    await waitFor(() => expect(fake.toast.success).toHaveBeenCalledWith(en["refundRequests.resolve.done"]));
    expect(fake.resolve).toHaveBeenCalledWith({ requestId: request(1).id, outcome: "failed", note: "checked" });
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(2));
  });

  it("a resolve conflict says it failed and reloads the list and the summary", async () => {
    fake.list.mockResolvedValue(page([request(1)]));
    fake.resolve.mockRejectedValue(rpcError("CONFLICT"));
    wrap(<RefundRequests />);
    await openResolve();
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["refundRequests.resolve.error"]));
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(2));
    // The summary counted this request as unknown; a settle made meanwhile changed that too.
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(2));
  });

  it("another resolve failure reloads nothing", async () => {
    fake.list.mockResolvedValue(page([request(1)]));
    fake.resolve.mockRejectedValue(rpcError("BAD_REQUEST"));
    wrap(<RefundRequests />);
    await openResolve();
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["refundRequests.resolve.error"]));
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(fake.outcomeUnknown).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["none", "success"],
    ["failed", "success"],
    ["refunded", "info"],
    ["pending", "info"],
    ["ambiguous", "warning"],
    ["unavailable", "error"],
  ] as const)("a recheck answering %s is told as a %s toast, then reloads", async (result, tone) => {
    fake.list.mockResolvedValue(page([request(1)]));
    fake.recheck.mockResolvedValue({ result });
    wrap(<RefundRequests />);
    await recheck();
    await waitFor(() => expect(fake.toast[tone]).toHaveBeenCalledWith(en[`refundRecheck.result.${result}`]));
    expect(fake.recheck).toHaveBeenCalledWith({ requestId: request(1).id });
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(2));
  });

  it("a recheck conflict reloads; another failure only says so", async () => {
    fake.list.mockResolvedValue(page([request(1)]));
    fake.recheck.mockRejectedValueOnce(rpcError("CONFLICT"));
    wrap(<RefundRequests />);
    await recheck();
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["refundRecheck.error"]));
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.outcomeUnknown).toHaveBeenCalledTimes(2));
    cleanup();

    fake.list.mockClear();
    fake.outcomeUnknown.mockClear();
    fake.toast.error.mockClear();
    fake.recheck.mockRejectedValueOnce(rpcError("INTERNAL_SERVER_ERROR"));
    wrap(<RefundRequests />);
    await recheck();
    await waitFor(() => expect(fake.toast.error).toHaveBeenCalledWith(en["refundRecheck.error"]));
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(fake.outcomeUnknown).toHaveBeenCalledTimes(1);
  });
});
