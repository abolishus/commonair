// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `/settings/subscriptions` list states, server-rendered from the page's own component. */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { Window } from "happy-dom";
import type * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SubscriptionList } from "../src/components/support/subscription-list.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { SubscriptionDto } from "../src/lib/support.ts";
import { subscription } from "./support-fixtures.ts";

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function render(node: React.ReactNode): Document {
  const html = renderToString(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <NowProvider now={Date.parse("2026-10-20T00:00:00.000Z")}>
          <TooltipProvider>{node}</TooltipProvider>
        </NowProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
  const { document } = new Window();
  document.body.innerHTML = html;
  return document as unknown as Document;
}

const list = (subscriptions: SubscriptionDto[] | null) =>
  render(<SubscriptionList subscriptions={subscriptions} onCancel={async () => {}} onCancelError={() => {}} />);

const rows = (doc: Document) => [...doc.querySelectorAll('[data-testid="subscription-row"]')];

describe("SubscriptionList", () => {
  it("loading: skeletons, no rows and no empty state", () => {
    const doc = list(null);
    expect(rows(doc)).toHaveLength(0);
    expect(doc.querySelector('[data-testid="subscriptions-empty"]')).toBeNull();
    expect(doc.querySelector("output")).not.toBeNull();
  });

  it("empty: subscriptions-empty", () => {
    const doc = list([]);
    expect(doc.querySelectorAll('[data-testid="subscriptions-empty"]')).toHaveLength(1);
    expect(rows(doc)).toHaveLength(0);
  });

  it("active: every row attribute and a cancel button", () => {
    const doc = list([subscription()]);
    const [row] = rows(doc);
    expect(
      [
        "data-subscription-id",
        "data-channel",
        "data-tier",
        "data-status",
        "data-gifted",
        "data-cancel-at-period-end",
      ].map((a) => row?.getAttribute(a)),
    ).toEqual(["0192f000-0000-7000-8000-000000000001", "rivertide", "2", "active", "false", "false"]);
    expect(row?.querySelectorAll('[data-testid="subscription-cancel"]')).toHaveLength(1);
    expect(row?.querySelector('a[href="/rivertide"]')).not.toBeNull();
    expect(row?.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-19T12:00:00.000Z");
    expect(row?.textContent).toContain("Renews");
  });

  it("cancelling: marked, says Ends, and no second cancel", () => {
    const [row] = rows(list([subscription({ cancelAtPeriodEnd: true })]));
    expect(row?.getAttribute("data-cancel-at-period-end")).toBe("true");
    expect(row?.querySelector('[data-testid="subscription-cancel"]')).toBeNull();
    expect(row?.textContent).toContain("Ends at period end");
    expect(row?.textContent).toContain("Ends");
  });

  it("gifted: data-gifted and the gift marker", () => {
    const [row] = rows(list([subscription({ gifted: true })]));
    expect(row?.getAttribute("data-gifted")).toBe("true");
    expect(row?.textContent).toContain("Gift");
    expect(row?.querySelector('[data-testid="subscription-cancel"]')).toBeNull();
  });

  it("ended and pending rows have no cancel; current ones sort first", () => {
    const doc = list([
      subscription({ id: "x1", status: "canceled", currentPeriodEnd: null }),
      subscription({ id: "x2", status: "past_due" }),
      subscription({ id: "x3", status: "incomplete", currentPeriodEnd: null }),
    ]);
    expect(rows(doc).map((r) => r.getAttribute("data-subscription-id"))).toEqual(["x2", "x3", "x1"]);
    expect(doc.querySelector('[data-testid="subscription-cancel"]')).toBeNull();
  });
});
