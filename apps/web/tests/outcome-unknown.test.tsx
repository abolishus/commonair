// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Settling what Stripe never answered (follow-ups, unit money): the outcome-unknown summary, the
 * settle dialog of a payout transfer, and the recheck of a refund request, each rendered with
 * contract-shaped fixtures, with the accessibility rules axe would flag here.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  OutcomeUnknownCallout,
  type OutcomeUnknownDto,
  anyOutcomeUnknown,
} from "../src/components/treasury/outcome-unknown-summary.tsx";
import {
  type PayoutTransferDto,
  PayoutTransfersPanel,
  type PayoutTransfersPanelProps,
  settleable,
} from "../src/components/treasury/payout-transfers.tsx";
import { recheckToast } from "../src/components/treasury/refund-recheck.tsx";
import {
  type RefundRequestDto,
  RefundRequestsPanel,
  type RefundRequestsPanelProps,
} from "../src/components/treasury/refund-requests.tsx";
import { settleReady } from "../src/components/treasury/transfer-settle.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

/** The rules axe would flag here: names, labels, id references, duplicate ids. */
function a11yViolations(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("button"))
    if (!(el.getAttribute("aria-label") ?? el.textContent ?? "").trim())
      out.push(`button-name: ${el.outerHTML.slice(0, 80)}`);
  for (const el of root.querySelectorAll("input:not([type=hidden]), textarea")) {
    const id = el.getAttribute("id");
    // Base UI's own visually hidden form inputs (a select's, a radio group's) mirror a labelled control.
    if (id?.endsWith("-hidden-input") || el.getAttribute("aria-hidden") === "true") continue;
    const labelled = el.getAttribute("aria-label") || (id && document.querySelector(`label[for="${id}"]`));
    if (!labelled && el.getAttribute("role") !== "radio" && !el.closest("[role=radio]"))
      out.push(`label: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of root.querySelectorAll("[aria-labelledby], [aria-describedby]"))
    for (const attr of ["aria-labelledby", "aria-describedby"])
      for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) out.push(`${attr} points at missing #${id}`);
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  return out;
}

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const usd = (cents: number) => ({ cents, currency: "usd" });

describe("OutcomeUnknownCallout", () => {
  const none: OutcomeUnknownDto = {
    refunds: { count: 0, amounts: [] },
    transfers: { count: 0, amounts: [] },
    patronagePayouts: { count: 0, amounts: [] },
  };

  it("shows nothing while loading or when nothing is unknown", () => {
    expect(anyOutcomeUnknown(null)).toBe(false);
    expect(anyOutcomeUnknown(none)).toBe(false);
    expect(wrap(<OutcomeUnknownCallout summary={null} />).container.textContent).toBe("");
    cleanup();
    expect(wrap(<OutcomeUnknownCallout summary={none} />).container.textContent).toBe("");
  });

  it("lists each kind with a count, in words, with its amounts", () => {
    const s: OutcomeUnknownDto = {
      ...none,
      refunds: { count: 2, amounts: [usd(1_000)] },
      transfers: { count: 1, amounts: [usd(9_000)] },
    };
    expect(anyOutcomeUnknown(s)).toBe(true);
    const r = wrap(<OutcomeUnknownCallout summary={s} />);
    const box = r.getByTestId("outcome-unknown-summary");
    expect(box.textContent).toContain(en["outcomeUnknown.title"]);
    const items = [...box.querySelectorAll("li")];
    expect(items.map((li) => [li.getAttribute("data-kind"), li.getAttribute("data-count")])).toEqual([
      ["refunds", "2"],
      ["transfers", "1"],
    ]);
    expect(items[0]?.textContent).toContain("2 refund requests");
    expect(items[1]?.textContent).toContain("1 payout transfer");
    expect(items[1]?.textContent).toContain("90");
    expect(a11yViolations(r.container)).toEqual([]);
  });
});

describe("settling a payout transfer", () => {
  let n = 0;
  function row(over: Partial<PayoutTransferDto> = {}): PayoutTransferDto {
    n += 1;
    return {
      id: `0195f0c2-6a4b-7c3d-8e9f-${String(n).padStart(12, "0")}`,
      payoutId: `0195f0c2-6a4b-7c3d-8e9e-${String(n).padStart(12, "0")}`,
      user: {
        id: `0195f0c2-6a4b-7c3d-8e9d-${String(n).padStart(12, "0")}`,
        username: `creator${n}`,
        displayName: "Ada",
      },
      periodStart: "2026-10-01T00:00:00.000Z",
      amount: usd(9_000),
      reversed: usd(0),
      status: "pending",
      failureCode: "outcome_unknown",
      providerRef: null,
      createdAt: at(120),
      updatedAt: at(60),
      ...over,
    };
  }
  const isDisabled = (b: HTMLElement) =>
    (b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true";

  it("needs an outcome, and a tr_ id when Stripe sent it", () => {
    expect(settleReady(null, "")).toBe(false);
    expect(settleReady("not_sent", "")).toBe(true);
    expect(settleReady("sent", "")).toBe(false);
    expect(settleReady("sent", "BANK-1")).toBe(false);
    expect(settleReady("sent", " tr_1AbC ")).toBe(true);
    expect(settleable(row())).toBe(true);
    expect(settleable(row({ failureCode: "sent_unrecorded" }))).toBe(false);
    expect(settleable(row({ status: "created", failureCode: null }))).toBe(false);
  });

  it("offers the action only on rows whose outcome is unknown, and only with a handler", () => {
    const rows = [
      row(),
      row({ status: "created", failureCode: null, providerRef: "tr_x" }),
      row({ failureCode: "sending" }),
    ];
    const without = wrap(<PayoutTransfersPanel transfers={rows} />);
    expect(without.queryAllByTestId("payout-transfer-settle")).toHaveLength(0);
    cleanup();
    const r = wrap(<PayoutTransfersPanel transfers={rows} onSettle={async () => undefined} />);
    const buttons = r.getAllByTestId("payout-transfer-settle");
    expect(buttons.map((b) => b.getAttribute("data-transfer-id"))).toEqual([rows[0]?.id]);
    expect(a11yViolations(r.container)).toEqual([]);
  });

  it("records sent with the trimmed tr_ id and the note", async () => {
    const onSettle = vi.fn<NonNullable<PayoutTransfersPanelProps["onSettle"]>>(async () => undefined);
    const tr = row();
    wrap(<PayoutTransfersPanel transfers={[tr]} onSettle={onSettle} />);
    fireEvent.click(screen.getByTestId("payout-transfer-settle"));
    const dialog = await screen.findByTestId("payout-transfer-settle-dialog");
    const confirm = within(dialog).getByRole("button", { name: en["transferSettle.confirm"] });
    expect(isDisabled(confirm)).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: en["transferSettle.outcome.sent"] }));
    const ref = await within(dialog).findByLabelText(en["transferSettle.reference"]);
    fireEvent.change(ref, { target: { value: "not-a-transfer" } });
    await waitFor(() => expect(ref.getAttribute("aria-invalid")).toBe("true"));
    expect(isDisabled(confirm)).toBe(true);
    fireEvent.change(ref, { target: { value: "  tr_1AbCdE  " } });
    fireEvent.change(within(dialog).getByLabelText(en["transferSettle.note"]), { target: { value: " seen " } });
    await waitFor(() => expect(isDisabled(confirm)).toBe(false));
    expect(a11yViolations(dialog)).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
    expect(onSettle).toHaveBeenCalledWith(expect.objectContaining({ id: tr.id }), "sent", "tr_1AbCdE", "seen");
  });

  it("records not sent without a reference; cancel records nothing", async () => {
    const onSettle = vi.fn<NonNullable<PayoutTransfersPanelProps["onSettle"]>>(async () => undefined);
    wrap(<PayoutTransfersPanel transfers={[row()]} onSettle={onSettle} />);
    fireEvent.click(screen.getByTestId("payout-transfer-settle"));
    let dialog = await screen.findByTestId("payout-transfer-settle-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByTestId("payout-transfer-settle-dialog")).toBeNull());
    expect(onSettle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("payout-transfer-settle"));
    dialog = await screen.findByTestId("payout-transfer-settle-dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: en["transferSettle.outcome.notSent"] }));
    expect(within(dialog).queryByLabelText(en["transferSettle.reference"])).toBeNull();
    const confirm = within(dialog).getByRole("button", { name: en["transferSettle.confirm"] });
    await waitFor(() => expect(isDisabled(confirm)).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
    expect(onSettle.mock.calls[0]?.slice(1)).toEqual(["not_sent", undefined, ""]);
  });
});

describe("rechecking a refund request", () => {
  function unknownReq(minutesAgo: number, id = "01900000-0000-7000-8000-0000000000a2"): RefundRequestDto {
    return {
      id,
      paymentId: "01900000-0000-7000-8000-0000000000b2",
      paymentKind: "membership_share",
      provider: "stripe",
      amount: usd(2_500),
      requested: usd(2_500),
      state: "unknown",
      reason: null,
      requestedBy: { id: "01900000-0000-7000-8000-0000000000c1", username: "treasurer1" },
      markers: [
        { action: "payment.refund_requested", at: at(minutesAgo) },
        { action: "payment.refund_outcome_unknown", at: at(minutesAgo) },
      ],
      createdAt: at(minutesAgo),
    };
  }
  function panel(over: Partial<RefundRequestsPanelProps>) {
    const props: RefundRequestsPanelProps = {
      requests: [unknownReq(60)],
      filter: "unknown",
      onFilterChange: () => undefined,
      onResolve: async () => undefined,
      now: () => NOW,
      ...over,
    };
    return wrap(<RefundRequestsPanel {...props} />);
  }

  it("says what each result means, and how loudly", () => {
    expect(recheckToast("none")).toEqual({ message: en["refundRecheck.result.none"], tone: "success" });
    expect(recheckToast("failed").tone).toBe("success");
    expect(recheckToast("refunded")).toEqual({ message: en["refundRecheck.result.refunded"], tone: "info" });
    expect(recheckToast("pending").tone).toBe("info");
    expect(recheckToast("ambiguous").tone).toBe("warning");
    expect(recheckToast("unavailable").tone).toBe("error");
  });

  it("is offered on unknown requests only with a handler, and waits out the 15 minutes", () => {
    panel({});
    expect(screen.queryByTestId("refund-request-recheck")).toBeNull();
    cleanup();
    const { container } = panel({
      requests: [unknownReq(5), unknownReq(60, "01900000-0000-7000-8000-0000000000a3")],
      onRecheck: async () => undefined,
    });
    const [fresh, ripe] = screen.getAllByTestId("refund-request-recheck") as HTMLButtonElement[];
    expect(fresh?.disabled).toBe(true);
    expect(document.getElementById(fresh?.getAttribute("aria-describedby") ?? "")?.textContent).toContain("15 minutes");
    expect(ripe?.disabled).toBe(false);
    expect(a11yViolations(container)).toEqual([]);
  });

  it("asks for confirmation before checking", async () => {
    const onRecheck = vi.fn<NonNullable<RefundRequestsPanelProps["onRecheck"]>>(async () => undefined);
    panel({ onRecheck });
    fireEvent.click(screen.getByTestId("refund-request-recheck"));
    const dialog = await screen.findByTestId("refund-request-recheck-dialog");
    expect(dialog.textContent).toContain(en["refundRecheck.body"]);
    expect(onRecheck).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: en["refundRecheck.confirm"] }));
    await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1));
    expect(onRecheck).toHaveBeenCalledWith(expect.objectContaining({ id: "01900000-0000-7000-8000-0000000000a2" }));
  });
});

describe("catalog", () => {
  it("every m1-money key has a Spanish translation", async () => {
    const es = (await import("../src/i18n/locales/es/m1-money.json")).default as Record<string, string>;
    const enCatalog = (await import("../src/i18n/locales/en/m1-money.json")).default as Record<string, string>;
    expect(Object.keys(es).sort()).toEqual(Object.keys(enCatalog).sort());
    for (const v of Object.values(es)) expect(v.trim()).not.toBe("");
  });
});
