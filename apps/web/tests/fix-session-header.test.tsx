// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F1 in the header: while the session is unresolved (the API was busy when the document checked
 * it), the visitor may well be signed in. The header shows a neutral account placeholder that asks
 * again, never Sign in or Sign up.
 */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Theme } from "@commonair/ui";
import { en } from "../src/i18n/en.ts";
import type { SessionRetry } from "../src/lib/session-view.ts";
import { ThemeContext } from "../src/lib/theme-context.ts";
import { MEMBER, boot, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({
  boot: null as unknown,
  session: null as unknown as SessionRetry,
}));
vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => fake.boot,
  useSessionRetry: () => fake.session,
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
vi.mock("../src/components/notifications/bell.tsx", () => ({
  NotificationBell: () => <button type="button" aria-label="Notifications" data-testid="notification-bell" />,
}));

const { AppHeader } = await import("../src/components/site-chrome.tsx");

function themed(node: React.ReactNode) {
  return (
    <ThemeContext.Provider value={{ theme: "dark", setTheme: vi.fn<(theme: Theme) => void>() }}>
      {node}
    </ThemeContext.Provider>
  );
}

const authLinks = () => document.querySelectorAll("header [data-auth-link]");

function session(over: Partial<SessionRetry> = {}): SessionRetry {
  return { unresolved: true, retrying: false, gaveUp: false, retry: vi.fn<() => void>(), ...over };
}

beforeEach(() => {
  fake.session = session();
});
afterEach(cleanup);

describe("the header while the session is unresolved", () => {
  it("has no Sign in or Sign up, but an account placeholder whose Retry asks again", async () => {
    fake.boot = { ...boot(), sessionUnresolved: true };
    await renderInRouter(themed(<AppHeader />), "/");
    expect(authLinks()).toHaveLength(0);
    expect(screen.queryByText(en["nav.signIn"])).toBeNull();
    expect(screen.queryByText(en["nav.signUp"])).toBeNull();
    const retry = screen.getByTestId("session-retry");
    expect(retry.getAttribute("aria-label")).toBe(en["fixSession.session.retry"]);
    expect(retry.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(retry);
    expect(fake.session.retry).toHaveBeenCalledOnce();
  });

  it("says it is checking, busy, while a lookup is under way", async () => {
    fake.boot = { ...boot(), sessionUnresolved: true };
    fake.session = session({ retrying: true });
    await renderInRouter(themed(<AppHeader />), "/");
    const retry = screen.getByTestId("session-retry");
    expect(retry.getAttribute("aria-label")).toBe(en["fixSession.session.checking"]);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(authLinks()).toHaveLength(0);
  });

  it("a definitive signed-out answer has Sign in and Sign up, and no placeholder", async () => {
    fake.boot = { ...boot(), sessionUnresolved: false };
    await renderInRouter(themed(<AppHeader />), "/");
    expect(authLinks()).toHaveLength(2);
    expect(screen.queryByTestId("session-retry")).toBeNull();
  });

  it("a member is shown as the member, never the placeholder", async () => {
    fake.boot = { ...boot({ me: MEMBER }), sessionUnresolved: false };
    await renderInRouter(themed(<AppHeader />), "/");
    expect(screen.getByTestId("nav-user")).toBeTruthy();
    expect(screen.queryByTestId("session-retry")).toBeNull();
  });
});
