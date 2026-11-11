// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 5, ADR 0042: the delete dialog says renewals stop now, paid time runs out, nothing
 * is charged again, how many end early without an automatic refund, and how the share comes back;
 * a request the provider refused says nothing was scheduled. The treasury shares tab lists members
 * leaving with a share, soonest first, with "Ask for refund details" behind a ConfirmDialog that
 * waits a day between asks.
 */
import type { DeletionPreview } from "@commonair/contracts/dto";
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { ShareDto } from "../src/lib/coop.ts";
import { share as shareFixture } from "./coop-fixtures.ts";

configure({ asyncUtilTimeout: 5_000 });

const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: unknown) => void>(),
  error: vi.fn<(message: unknown) => void>(),
  warning: vi.fn<(message: unknown) => void>(),
  info: vi.fn<(message: unknown) => void>(),
}));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));
vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: vi.fn<(...args: unknown[]) => void>() }));
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, instance: { p2pDefault: "off" }, now: Date.now() }),
}));

const { impactLines } = await import("../src/components/settings/delete-model.ts");
const { DeleteAccountSection, deletionRequestErrorText } =
  await import("../src/components/settings/delete-account.tsx");
const { LeavingSharesPanel, askErrorText, askedRecently, leavingShares } =
  await import("../src/components/treasury/share-refund-leaving.tsx");
const { leavingFirst } = await import("../src/components/coop/treasury-tabs.tsx");
type DeletionClient = import("../src/components/settings/deletion-state.tsx").DeletionClient;

afterEach(() => {
  cleanup();
  for (const f of Object.values(toasts)) f.mockReset();
});

const NOW = Date.parse("2026-11-11T12:00:00.000Z");

function wrap(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{node}</> });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <NowProvider now={NOW}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </NowProvider>
    </LocaleProvider>,
  );
}

const preview = (over: Partial<DeletionPreview> = {}): DeletionPreview => ({
  graceDays: 30,
  activeSubscriptions: 0,
  endingBeforePaidThrough: 0,
  channelSubscriptions: 0,
  pendingPayout: null,
  memberships: [],
  legalHold: false,
  scheduled: null,
  ...over,
});

const deletionClient: DeletionClient = {
  get: async () => null,
  request: async () => ({ id: "d", status: "scheduled", scheduledFor: "2026-12-11T12:00:00.000Z", retained: [] }),
  cancel: async () => ({ ok: true }),
};
const exports = { exports: [], failed: false, load: async () => {}, request: async () => {} };

describe("impactLines: endingEarly", () => {
  it("follows the subscription lines when some are paid past the date, and is absent at zero", () => {
    const lines = impactLines(preview({ activeSubscriptions: 2, channelSubscriptions: 1, endingBeforePaidThrough: 1 }));
    expect(lines.map((l) => l.kind)).toEqual([
      "removed",
      "kept",
      "subscriptions",
      "channelSubscriptions",
      "endingEarly",
    ]);
    expect(lines[4]).toEqual({ kind: "endingEarly", count: 1 });
    expect(impactLines(preview({ activeSubscriptions: 2 })).map((l) => l.kind)).not.toContain("endingEarly");
  });
});

describe("the delete dialog's copy (ADR 0042)", () => {
  it("says renewals stop now, nothing more is charged, what ends early, and how the share comes back", async () => {
    const full = preview({
      activeSubscriptions: 2,
      channelSubscriptions: 1,
      endingBeforePaidThrough: 1,
      memberships: [{ class: "viewer", shareRefund: { cents: 500, currency: "usd" } }],
    });
    wrap(
      <DeleteAccountSection username="viewer1" exports={exports} client={deletionClient} preview={async () => full} />,
    );
    fireEvent.click(await screen.findByTestId("deletion-request"));
    const dialog = await screen.findByTestId("deletion-dialog");
    await waitFor(() => expect(within(dialog).getAllByTestId("deletion-impact-line")).toHaveLength(6));
    const line = (kind: string) => dialog.querySelector(`[data-kind="${kind}"]`)?.textContent ?? "";
    expect(line("subscriptions")).toContain("The 2 subscriptions you pay for stop renewing now.");
    expect(line("subscriptions")).toContain("nothing is charged again");
    expect(line("channelSubscriptions")).toContain("1 paid subscription to your channel stops renewing now.");
    expect(line("endingEarly")).toContain("1 subscription is paid past your deletion date");
    expect(line("endingEarly")).toContain("without an automatic refund");
    expect(line("membership")).toContain("The co-op's treasury emails you before the deletion date");
    expect(line("membership")).toContain("share reference");
    expect(dialog.querySelector('[data-kind="membership"] data')?.getAttribute("value")).toBe("500");
    // Never a promise of an automatic refund.
    expect(dialog.textContent ?? "").not.toMatch(/refunded automatically|automatic(ally)? refund(ed)? (is|for)/i);
  });

  it("a refused renewal stop says nothing was scheduled; anything else is the general failure", () => {
    const refused = Object.assign(new Error("x"), {
      code: "PRECONDITION_FAILED",
      data: { requirement: "payment_provider" },
    });
    expect(deletionRequestErrorText(refused)).toBe(en["w5Deletion.renewalStopFailed"]);
    expect(deletionRequestErrorText(new Error("down"))).toBe(en["privacy.deletion.failed"]);
  });

  it("the banner copy says renewals stopped and cancelling turns them back on", () => {
    expect(en["w5Deletion.banner.body"]).toContain("stopped renewing");
    expect(en["w5Deletion.banner.body"]).toContain("turn renewals back on");
  });
});

// ── the treasury ───────────────────────────────────────────────────────────────────────────────

const leaving = (id: string, at: string, asked: string | null = null): ShareDto => ({
  ...shareFixture(id, "held"),
  deletionScheduledFor: at,
  refundDetailsRequestedAt: asked,
});

describe("leavingShares, leavingFirst and askedRecently", () => {
  it("keeps members with a deletion scheduled, soonest first", () => {
    const later = leaving("a", "2026-12-20T00:00:00.000Z");
    const sooner = leaving("b", "2026-11-20T00:00:00.000Z");
    const staying = shareFixture("c", "held");
    expect(leavingShares(null)).toBeNull();
    expect(leavingShares([later, staying, sooner])?.map((s) => s.id)).toEqual(["b", "a"]);
    expect(leavingFirst([staying, later, sooner])?.map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(leavingFirst(null)).toBeNull();
  });
  it("a day between asks", () => {
    expect(askedRecently({ refundDetailsRequestedAt: null }, NOW)).toBe(false);
    expect(askedRecently({ refundDetailsRequestedAt: new Date(NOW - 23 * 3_600_000).toISOString() }, NOW)).toBe(true);
    expect(askedRecently({ refundDetailsRequestedAt: new Date(NOW - 25 * 3_600_000).toISOString() }, NOW)).toBe(false);
  });
  it("a refusal for asking too soon says so", () => {
    expect(askErrorText(Object.assign(new Error("x"), { code: "CONFLICT" }))).toBe(
      en["w5Deletion.treasury.askTooSoon"],
    );
    expect(askErrorText(new Error("x"))).toBe(en["w5Deletion.treasury.askFailed"]);
  });
});

describe("LeavingSharesPanel", () => {
  it("renders nothing without members leaving", () => {
    wrap(<LeavingSharesPanel shares={[]} onAsk={async () => {}} now={() => NOW} />);
    expect(screen.queryByTestId("treasury-leaving-shares")).toBeNull();
  });

  it("asks through a confirm dialog, then says the email went", async () => {
    const onAsk = vi.fn<(s: ShareDto) => Promise<void>>(async () => {});
    const first = leaving("s1", "2026-11-20T00:00:00.000Z");
    wrap(<LeavingSharesPanel shares={[first]} onAsk={onAsk} now={() => NOW} />);
    const row = await screen.findByTestId("treasury-leaving-share");
    expect(row.dataset.shareId).toBe("s1");
    expect(within(row).getByTestId("treasury-leaving-share-asked").textContent).toBe(
      en["w5Deletion.treasury.neverAsked"],
    );
    fireEvent.click(within(row).getByTestId("treasury-share-ask-refund-details"));
    const dialog = await screen.findByTestId("treasury-share-ask-refund-details-dialog");
    expect(dialog.textContent).toContain("You won't see their address");
    expect(onAsk).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(first));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(en["w5Deletion.treasury.asked"]));
  });

  it("asked within the day: the button waits and says why", async () => {
    const recent = leaving("s2", "2026-11-20T00:00:00.000Z", new Date(NOW - 3_600_000).toISOString());
    wrap(<LeavingSharesPanel shares={[recent]} onAsk={async () => {}} now={() => NOW} />);
    const button = await screen.findByTestId("treasury-share-ask-refund-details");
    expect(button.getAttribute("aria-disabled") === "true" || button.hasAttribute("disabled")).toBe(true);
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(en["w5Deletion.treasury.askedToday"]);
  });
});
