// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * M1-connect's treasury transfers tab (docs/testing/b8-selectors.md "Payout transfers"): the list
 * states (loading, empty, failed load, every status), the status attributes the harness reads, the
 * statuses in words, and the accessibility rules axe would flag here (the harness runs axe on the
 * live page). No Stripe message or email ever shows: a failure is its opaque code.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type PayoutTransferDto,
  PayoutTransfersPanel,
  transferStatusView,
} from "../src/components/treasury/payout-transfers.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

const NOW = Date.parse("2026-11-03T12:00:00Z");
let n = 0;
function row(over: Partial<PayoutTransferDto> = {}): PayoutTransferDto {
  n += 1;
  const id = `0195f0c2-6a4b-7c3d-8e9f-${String(n).padStart(12, "0")}`;
  return {
    id,
    payoutId: `0195f0c2-6a4b-7c3d-8e9e-${String(n).padStart(12, "0")}`,
    user: { id: `0195f0c2-6a4b-7c3d-8e9d-${String(n).padStart(12, "0")}`, username: `creator${n}`, displayName: "Ada" },
    periodStart: "2026-10-01T00:00:00.000Z",
    amount: { cents: 9_000, currency: "usd" },
    reversed: { cents: 0, currency: "usd" },
    status: "created",
    failureCode: null,
    providerRef: `tr_${n}`,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

const statuses = (root: ParentNode) =>
  [...root.querySelectorAll('[data-testid="payout-transfer-status"]')].map((el) => ({
    status: el.getAttribute("data-status"),
    reversed: el.getAttribute("data-reversed-cents"),
    code: el.getAttribute("data-failure-code"),
    text: el.textContent,
  }));

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
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  if (root.querySelector("img")) out.push("image: the tab loads no images");
  return out;
}

describe("transferStatusView", () => {
  it("says each status in words, with a note where the treasurer needs one", () => {
    const base = row();
    expect(transferStatusView({ ...base, status: "created" })).toEqual({
      label: en["payoutTransfers.status.created"],
      tone: "success",
      note: null,
    });
    expect(transferStatusView({ ...base, status: "pending", failureCode: null }).label).toBe(
      en["payoutTransfers.status.pending"],
    );
    expect(transferStatusView({ ...base, status: "pending", failureCode: "outcome_unknown" })).toMatchObject({
      label: en["payoutTransfers.status.outcomeUnknown"],
      tone: "danger",
      note: en["payoutTransfers.note.outcomeUnknown"],
    });
    expect(transferStatusView({ ...base, status: "pending", failureCode: "sent_unrecorded" }).label).toBe(
      en["payoutTransfers.status.sentUnrecorded"],
    );
    expect(transferStatusView({ ...base, status: "failed", failureCode: "account_not_ready" }).note).toBe(
      en["payoutTransfers.note.accountNotReady"],
    );
    expect(transferStatusView({ ...base, status: "failed", failureCode: "held" }).note).toBe(
      en["payoutTransfers.note.held"],
    );
    expect(transferStatusView({ ...base, status: "failed", failureCode: "resource_missing" }).note).toContain(
      "resource_missing",
    );
    expect(transferStatusView({ ...base, status: "created", reversed: { cents: 100, currency: "usd" } }).note).toBe(
      en["payoutTransfers.note.partlyReversed"],
    );
    expect(transferStatusView({ ...base, status: "reversed", reversed: base.amount }).label).toBe(
      en["payoutTransfers.status.reversed"],
    );
  });
});

describe("PayoutTransfersPanel", () => {
  it("shows skeleton rows while the first page loads", () => {
    const r = wrap(<PayoutTransfersPanel transfers={null} />);
    expect(r.getByTestId("payout-transfers")).toBeTruthy();
    expect(statuses(r.container)).toEqual([]);
    expect(r.container.textContent).not.toContain(en["payoutTransfers.empty.title"]);
  });

  it("shows the empty state for no transfers", () => {
    const r = wrap(<PayoutTransfersPanel transfers={[]} />);
    expect(r.getByTestId("payout-transfers").textContent).toContain(en["payoutTransfers.empty.title"]);
    expect(r.getByRole("heading", { level: 3 }).textContent).toBe(en["payoutTransfers.empty.title"]);
  });

  it("lists each transfer with its id, status enum and reversed cents", () => {
    const rows = [
      row({ status: "created" }),
      row({ status: "pending", failureCode: "outcome_unknown", providerRef: null }),
      row({ status: "failed", failureCode: "account_not_ready", providerRef: null }),
      row({ status: "reversed", reversed: { cents: 9_000, currency: "usd" } }),
      row({ status: "created", reversed: { cents: 1_000, currency: "usd" } }),
    ];
    const r = wrap(<PayoutTransfersPanel transfers={rows} />);
    const trs = [...r.container.querySelectorAll("tr[data-transfer-id]")];
    expect(trs.map((tr) => tr.getAttribute("data-transfer-id"))).toEqual(rows.map((x) => x.id));
    expect(trs.map((tr) => tr.getAttribute("data-payout-id"))).toEqual(rows.map((x) => x.payoutId));
    expect(statuses(r.container)).toEqual([
      { status: "created", reversed: "0", code: "", text: en["payoutTransfers.status.created"] },
      { status: "pending", reversed: "0", code: "outcome_unknown", text: en["payoutTransfers.status.outcomeUnknown"] },
      { status: "failed", reversed: "0", code: "account_not_ready", text: en["payoutTransfers.status.failed"] },
      { status: "reversed", reversed: "9000", code: "", text: en["payoutTransfers.status.reversed"] },
      { status: "created", reversed: "1000", code: "", text: en["payoutTransfers.status.created"] },
    ]);
    const text = r.container.textContent ?? "";
    expect(text).toContain("creator");
    expect(text).toContain(en["payoutTransfers.note.accountNotReady"]);
    expect(text).not.toContain("tr_");
    expect(text).not.toContain("@");
    expect(a11yViolations(r.container)).toEqual([]);
  });

  it("a failed first load says so and retries; a failed later load keeps the rows", () => {
    const onRetry = vi.fn<() => void>();
    const r = wrap(<PayoutTransfersPanel transfers={null} failed onRetry={onRetry} />);
    expect(r.container.textContent).toContain(en["payoutTransfers.loadFailed.title"]);
    expect(r.container.querySelector("table")).toBeNull();
    fireEvent.click(r.getByRole("button", { name: en["payoutTransfers.retry"] }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    const again = wrap(<PayoutTransfersPanel transfers={[row()]} failed onRetry={onRetry} />);
    expect(statuses(again.container)).toHaveLength(1);
    expect(a11yViolations(again.container)).toEqual([]);
  });

  it("loads more while there are more pages", () => {
    const onLoadMore = vi.fn<() => void>();
    const r = wrap(<PayoutTransfersPanel transfers={[row()]} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(r.getByRole("button", { name: en["payoutTransfers.loadMore"] }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    cleanup();
    const busy = wrap(<PayoutTransfersPanel transfers={[row()]} hasMore loadingMore onLoadMore={onLoadMore} />);
    expect(busy.getByRole("button", { name: en["payoutTransfers.loadMore"] }).hasAttribute("disabled")).toBe(true);
  });

  it("every key has a Spanish translation", async () => {
    const es = (await import("../src/i18n/locales/es/m1-connect.json")).default as Record<string, string>;
    const enCatalog = (await import("../src/i18n/locales/en/m1-connect.json")).default as Record<string, string>;
    expect(Object.keys(es).sort()).toEqual(Object.keys(enCatalog).sort());
    for (const v of Object.values(es)) expect(v.trim()).not.toBe("");
  });
});
