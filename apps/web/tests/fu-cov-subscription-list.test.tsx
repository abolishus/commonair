// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `/settings/subscriptions` interactively: Cancel opens the confirmation named for the channel,
 * confirming calls `onCancel` with that subscription, and a refused cancel goes to
 * `onCancelError`. Plus the channel name's fallbacks (blank display name, `@slug` handle).
 */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SubscriptionList, subscriptionChannelName } from "../src/components/support/subscription-list.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { SubscriptionDto } from "../src/lib/support.ts";
import { subscription } from "./support-fixtures.ts";

afterEach(cleanup);

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <NowProvider now={Date.parse("2026-10-20T00:00:00.000Z")}>
          <TooltipProvider>{node}</TooltipProvider>
        </NowProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

async function confirmCancel() {
  fireEvent.click(screen.getByTestId("subscription-cancel"));
  const confirm = await screen.findByRole("button", { name: t("subscriptions.cancelConfirm") });
  expect(document.body.textContent).toContain(t("subscriptions.cancelTitle", { channel: "Rivertide" }));
  await act(async () => {
    fireEvent.click(confirm);
  });
}

describe("SubscriptionList cancel", () => {
  it("confirming calls onCancel with the subscription", async () => {
    const onCancel = vi.fn<(s: SubscriptionDto) => Promise<void>>(async () => {});
    const onCancelError = vi.fn<(err: unknown) => void>();
    const sub = subscription();
    wrap(<SubscriptionList subscriptions={[sub]} onCancel={onCancel} onCancelError={onCancelError} />);
    await confirmCancel();
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith(sub));
    expect(onCancelError).not.toHaveBeenCalled();
  });

  it("a refused cancel goes to onCancelError", async () => {
    const err = new Error("refused");
    const onCancelError = vi.fn<(err: unknown) => void>();
    wrap(
      <SubscriptionList
        subscriptions={[subscription()]}
        onCancel={async () => {
          throw err;
        }}
        onCancelError={onCancelError}
      />,
    );
    await confirmCancel();
    await waitFor(() => expect(onCancelError).toHaveBeenCalledWith(err));
  });
});

describe("subscriptionChannelName", () => {
  it("the display name with @slug, or the slug alone when the name is blank", () => {
    expect(subscriptionChannelName(subscription())).toEqual({ name: "Rivertide", handle: "@rivertide" });
    const blank = subscription({
      channel: { slug: "rivertide", displayName: "   ", avatarUrl: null, accent: "teal" },
    });
    expect(subscriptionChannelName(blank)).toEqual({ name: "rivertide", handle: null });
  });
});
