// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The email unsubscribe confirm page (docs/testing/n1-selectors.md "Unsubscribe page"; ADR 0028
 * decision 4): the confirm, done and invalid states with a fake `notifications.unsubscribe`.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { ORPCError } from "@orpc/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parseUnsubscribeSearch,
  UnsubscribePage,
  type UnsubscribeInput,
  type UnsubscribeList,
} from "../src/components/notifications-unsubscribe/unsubscribe-page.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

const toasts = vi.hoisted(() => ({ success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));

afterEach(() => {
  cleanup();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

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

const TOKEN = "v1.AZCgAAAAAHAAgAAAAAAAAA.c2lnbmF0dXJlc2lnbmF0dQ";
type Apply = (input: UnsubscribeInput) => Promise<{ list: UnsubscribeList }>;

const page = () => screen.getByTestId("unsubscribe-page");

describe("parseUnsubscribeSearch", () => {
  it("accepts a known list and a token of the right shape", () => {
    expect(parseUnsubscribeSearch({ list: "go_live", token: TOKEN })).toEqual({ list: "go_live", token: TOKEN });
    expect(parseUnsubscribeSearch({ list: "governance", token: TOKEN })?.list).toBe("governance");
  });
  it.each([
    [{}],
    [{ list: "go_live" }],
    [{ token: TOKEN }],
    [{ list: "everything", token: TOKEN }],
    [{ list: "go_live", token: "" }],
    [{ list: "go_live", token: "v2.a.b" }],
    [{ list: "go_live", token: "v1.a b.c" }],
    [{ list: "go_live", token: `v1.${"a".repeat(64)}.${"b".repeat(140)}` }],
  ])("refuses %j", (search) => {
    expect(parseUnsubscribeSearch(search)).toBeNull();
  });
});

describe("UnsubscribePage", () => {
  it("shows which list and a confirm button, and applies only on the click", async () => {
    const apply = vi.fn<Apply>(async ({ list }) => ({ list }));
    wrap(<UnsubscribePage list="go_live" token={TOKEN} apply={apply} />);
    expect(page().getAttribute("data-list")).toBe("go_live");
    expect(page().textContent).toContain(en["unsubscribe.title.go_live"]);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    await waitFor(() => expect(screen.getByTestId("unsubscribe-done")).toBeTruthy());
    expect(apply).toHaveBeenCalledExactlyOnceWith({ list: "go_live", token: TOKEN });
    expect(screen.getByTestId("unsubscribe-done").textContent).toContain(en["unsubscribe.done.go_live"]);
    expect(screen.queryByTestId("unsubscribe-confirm")).toBeNull();
    const settings = screen.getByTestId("unsubscribe-done").querySelector("a");
    expect(settings?.getAttribute("href")).toBe("/settings/notifications");
    expect(settings?.textContent).toBe(en["unsubscribe.settings"]);
  });

  it("names the governance list", async () => {
    const apply = vi.fn<Apply>(async ({ list }) => ({ list }));
    wrap(<UnsubscribePage list="governance" token={TOKEN} apply={apply} />);
    expect(page().getAttribute("data-list")).toBe("governance");
    expect(page().textContent).toContain(en["unsubscribe.title.governance"]);
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("unsubscribe-done").textContent).toContain(en["unsubscribe.done.governance"]),
    );
  });

  it.each([
    ["no query", {}],
    ["an unknown list", { list: "everything", token: TOKEN }],
    ["a malformed token", { list: "go_live", token: "nope" }],
  ])("shows the invalid state for %s, with no button", (_name, search: { list?: string; token?: string }) => {
    const apply = vi.fn<Apply>();
    wrap(<UnsubscribePage {...search} apply={apply} />);
    expect(screen.getByTestId("unsubscribe-invalid").textContent).toContain(en["unsubscribe.invalid.title"]);
    expect(screen.queryByTestId("unsubscribe-confirm")).toBeNull();
    expect(page().getAttribute("data-list")).toBe("");
    expect(apply).not.toHaveBeenCalled();
  });

  it("a token the API refuses (BAD_REQUEST) shows the invalid state", async () => {
    const apply = vi.fn<Apply>(async () => {
      throw new ORPCError("BAD_REQUEST", { status: 400, message: "This unsubscribe link is not valid" });
    });
    wrap(<UnsubscribePage list="go_live" token={TOKEN} apply={apply} />);
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    await waitFor(() => expect(screen.getByTestId("unsubscribe-invalid")).toBeTruthy());
    expect(screen.queryByTestId("unsubscribe-confirm")).toBeNull();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("another failure toasts and keeps the button for a retry; a rate limit says so", async () => {
    let fail: ORPCError<string, unknown> | null = new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 });
    const apply = vi.fn<Apply>(async ({ list }) => {
      if (fail) throw fail;
      return { list };
    });
    wrap(<UnsubscribePage list="go_live" token={TOKEN} apply={apply} />);
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["unsubscribe.failed"]));
    await waitFor(() => expect((screen.getByTestId("unsubscribe-confirm") as HTMLButtonElement).disabled).toBe(false));
    fail = new ORPCError("RATE_LIMITED", { status: 429 });
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["error.rateLimited"]));
    fail = null;
    await waitFor(() => expect((screen.getByTestId("unsubscribe-confirm") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    await waitFor(() => expect(screen.getByTestId("unsubscribe-done")).toBeTruthy());
  });

  it("disables the button while the request is in flight", async () => {
    let resolve: () => void = () => {};
    const apply = vi.fn<Apply>(
      ({ list }) =>
        new Promise((r) => {
          resolve = () => r({ list });
        }),
    );
    wrap(<UnsubscribePage list="go_live" token={TOKEN} apply={apply} />);
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    await waitFor(() => expect((screen.getByTestId("unsubscribe-confirm") as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"));
    expect(apply).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(screen.getByTestId("unsubscribe-done")).toBeTruthy());
  });
});
