// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The treasury "Refund requests" tab (docs/testing/b8-selectors.md "Refund requests"; ADR 0007
 * decisions 2 and 3), rendered with contract-shaped fixtures: each state, the unknown row's test
 * id and data, the empty state, the resolve confirm (refused in the first 15 minutes, confirm
 * disabled until an outcome is chosen), and the accessibility rules axe would flag here.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  RESOLVE_GRACE_MS,
  type RefundRequestDto,
  RefundRequestsPanel,
  type RefundRequestsPanelProps,
  resolveBlockedReason,
} from "../src/components/treasury/refund-requests.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}
afterEach(cleanup);

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function req(over: Partial<RefundRequestDto> = {}): RefundRequestDto {
  return {
    id: "01900000-0000-7000-8000-0000000000a1",
    paymentId: "01900000-0000-7000-8000-0000000000b1",
    paymentKind: "subscription",
    provider: "stripe",
    amount: { cents: 999, currency: "usd" },
    requested: { cents: 999, currency: "usd" },
    state: "outstanding",
    reason: null,
    requestedBy: { id: "01900000-0000-7000-8000-0000000000c1", username: "treasurer1" },
    markers: [
      { action: "payment.refund_requested", at: at(60) },
      { action: "payment.refund_submitted", at: at(59) },
    ],
    createdAt: at(60),
    ...over,
  };
}
const unknownReq = (minutesAgo = 60) =>
  req({
    id: "01900000-0000-7000-8000-0000000000a2",
    paymentId: "01900000-0000-7000-8000-0000000000b2",
    state: "unknown",
    markers: [
      { action: "payment.refund_requested", at: at(minutesAgo) },
      { action: "payment.refund_outcome_unknown", at: at(minutesAgo) },
    ],
    createdAt: at(minutesAgo),
  });

function panel(over: Partial<RefundRequestsPanelProps> = {}) {
  const props: RefundRequestsPanelProps = {
    requests: [req(), unknownReq()],
    filter: "outstanding",
    onFilterChange: () => undefined,
    onResolve: async () => undefined,
    now: () => NOW,
    ...over,
  };
  return wrap(<RefundRequestsPanel {...props} />);
}

/** The rules axe would flag on this tab: names, labels, id references, duplicate ids. */
function a11yViolations(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("button, [role='button'], [role='radio']")) {
    const id = el.getAttribute("id");
    const own = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    const labelled = id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null;
    if (own === "" && !labelled && !el.hasAttribute("aria-labelledby"))
      out.push(`button-name: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of root.querySelectorAll("input:not([type='hidden']):not([aria-hidden='true']), textarea, select")) {
    const id = el.getAttribute("id");
    const labelled =
      el.hasAttribute("aria-label") ||
      el.hasAttribute("aria-labelledby") ||
      (id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null);
    if (!labelled) out.push(`label: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of root.querySelectorAll("[aria-labelledby], [aria-describedby]"))
    for (const attr of ["aria-labelledby", "aria-describedby"])
      for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) out.push(`${attr} points at missing #${id}`);
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  return out;
}

describe("the list", () => {
  it("renders every request with its state; unknown rows carry their own test id", () => {
    const { container } = panel({
      requests: [req(), unknownReq(), req({ id: "01900000-0000-7000-8000-0000000000a3", state: "resolved" })],
    });
    const list = screen.getByTestId("refund-requests");
    const rows = list.querySelectorAll("[data-request-id][data-payment-id]");
    expect([...rows].map((r) => r.getAttribute("data-state"))).toEqual(["outstanding", "unknown", "resolved"]);
    const unknown = screen.getByTestId("refund-request-unknown");
    expect(unknown.getAttribute("data-request-id")).toBe("01900000-0000-7000-8000-0000000000a2");
    expect(unknown.getAttribute("data-payment-id")).toBe("01900000-0000-7000-8000-0000000000b2");
    expect(within(unknown).getByText("Outcome unknown")).toBeTruthy();
    // Only unknown requests can be resolved by hand.
    expect(screen.getAllByTestId("refund-request-resolve")).toHaveLength(1);
    expect(container.textContent).toContain("@treasurer1");
    expect(a11yViolations(container)).toEqual([]);
  });

  it("an automatic request says so", () => {
    panel({ requests: [req({ reason: "paid_after_end", requestedBy: null })] });
    const row = screen.getByTestId("refund-requests").querySelector("[data-request-id]");
    expect(row?.getAttribute("data-reason")).toBe("paid_after_end");
    expect(row?.textContent).toContain("Asked automatically");
    expect(row?.textContent).toContain("paid after the subscription ended");
  });

  it("is an EmptyState with the list's test id when empty, per filter", () => {
    panel({ requests: [], filter: "unknown" });
    const empty = screen.getByTestId("refund-requests");
    expect(empty.textContent).toContain("No refund with an unknown outcome");
  });

  it("shows a skeleton while loading", () => {
    panel({ requests: null });
    expect(screen.queryByTestId("refund-requests")).toBeNull();
  });
});

describe("resolve", () => {
  it("is refused in the first 15 minutes, with the reason shown", () => {
    const fresh = unknownReq(5);
    expect(resolveBlockedReason(fresh, NOW)).toContain("15 minutes");
    expect(resolveBlockedReason(unknownReq(16), NOW)).toBeNull();
    expect(resolveBlockedReason(req(), NOW)).not.toBeNull();
    expect(resolveBlockedReason(unknownReq(0), NOW + RESOLVE_GRACE_MS)).toBeNull();
    const { container } = panel({ requests: [fresh] });
    const button = screen.getByTestId("refund-request-resolve") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const describedBy = button.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toContain("15 minutes");
    expect(a11yViolations(container)).toEqual([]);
  });

  it("asks for confirmation, needs an outcome, and sends the note", async () => {
    const onResolve = vi.fn<RefundRequestsPanelProps["onResolve"]>(async () => undefined);
    panel({ requests: [unknownReq()], onResolve });
    fireEvent.click(screen.getByTestId("refund-request-resolve"));
    const dialog = await screen.findByTestId("refund-request-resolve-dialog");
    expect(a11yViolations(dialog)).toEqual([]);
    const confirm = within(dialog).getByRole("button", { name: "Resolve request" }) as HTMLButtonElement;
    // Disabled but focusable (aria-disabled): a click before an outcome is chosen does nothing.
    const isDisabled = () => confirm.disabled || confirm.getAttribute("aria-disabled") === "true";
    expect(isDisabled()).toBe(true);
    fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("radio", { name: "It was not refunded" }));
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), {
      target: { value: "  dashboard shows none  " },
    });
    await waitFor(() => expect(isDisabled()).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ id: "01900000-0000-7000-8000-0000000000a2" }),
      "failed",
      "dashboard shows none",
    );
  });

  it("cancel resolves nothing", async () => {
    const onResolve = vi.fn<RefundRequestsPanelProps["onResolve"]>(async () => undefined);
    panel({ requests: [unknownReq()], onResolve });
    fireEvent.click(screen.getByTestId("refund-request-resolve"));
    const dialog = await screen.findByTestId("refund-request-resolve-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByTestId("refund-request-resolve-dialog")).toBeNull());
    expect(onResolve).not.toHaveBeenCalled();
  });
});
