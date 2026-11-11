// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The wave-1 leftover (README Wave 2): the header's compact Sign up is the zinc fill until an open
 * `<AuthGatePrompt>` puts its brand "Create account" (`data-filled-cta`) on screen, then an
 * outline, and filled again once the prompt closes.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Theme } from "@commonair/ui";
import { tabBarVisible } from "../src/lib/nav.ts";
import { ThemeContext } from "../src/lib/theme-context.ts";
import { boot, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => fake.boot,
  useSessionRetry: () => ({ retry: () => {}, retrying: false }),
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
const { AuthGatePrompt } = await import("../src/components/auth-gate/auth-gate-prompt.tsx");
const { FollowButton } = await import("../src/components/channel-follow.tsx");

function LayoutHeader() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return <AppHeader tabBar={tabBarVisible(pathname)} />;
}

function themed(node: React.ReactNode) {
  const setTheme = vi.fn<(theme: Theme) => void>();
  return <ThemeContext.Provider value={{ theme: "dark", setTheme }}>{node}</ThemeContext.Provider>;
}

const signUpStyle = () =>
  document.querySelector('header [data-auth-link="signUp"]')?.getAttribute("data-cta-style") ?? null;

/** An IntersectionObserver the test drives: everything observed is reported on screen. */
class OnScreenObserver {
  static all: OnScreenObserver[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    OnScreenObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
    this.callback(
      [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  fake.boot = boot();
  OnScreenObserver.all = [];
  vi.stubGlobal("IntersectionObserver", OnScreenObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}")),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("header Sign up next to the sign-up prompt", () => {
  it("is filled with no prompt open, an outline while it is open, and filled again after", async () => {
    await renderInRouter(
      themed(
        <>
          <LayoutHeader />
          <AuthGatePrompt intent="clip" trigger={<button type="button" aria-label="clip" data-testid="clip" />}>
            Clip
          </AuthGatePrompt>
        </>,
      ),
      "/rivertide",
    );
    await waitFor(() => expect(signUpStyle()).toBe("fill"));
    act(() => {
      fireEvent.click(screen.getByTestId("clip"));
    });
    const create = await screen.findByTestId("auth-gate-create");
    expect(create.hasAttribute("data-filled-cta")).toBe(true);
    await waitFor(() => expect(signUpStyle()).toBe("outline"));
    act(() => {
      fireEvent.keyDown(screen.getByTestId("auth-gate"), { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("auth-gate")).toBeNull());
    await waitFor(() => expect(signUpStyle()).toBe("fill"));
  });

  it("for report (no brand fill in the prompt), Sign up stays filled", async () => {
    await renderInRouter(
      themed(
        <>
          <LayoutHeader />
          <AuthGatePrompt intent="report" trigger={<button type="button" aria-label="report" data-testid="report" />}>
            Report
          </AuthGatePrompt>
        </>,
      ),
      "/rivertide",
    );
    act(() => {
      fireEvent.click(screen.getByTestId("report"));
    });
    await screen.findByTestId("auth-gate");
    // Give the observer's rescan a frame.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(signUpStyle()).toBe("fill");
  });

  it("beside Follow's prompt, the fill moves from Follow to Create account and Sign up stays an outline", async () => {
    const state = { following: null, count: 0, pending: false, previous: null, settledAt: 0 };
    await renderInRouter(
      themed(
        <>
          <LayoutHeader />
          <FollowButton signedIn={false} state={state} onToggle={() => {}} />
        </>,
      ),
      "/rivertide",
    );
    await waitFor(() => expect(signUpStyle()).toBe("outline"));
    act(() => {
      fireEvent.click(screen.getByTestId("follow-button"));
    });
    await screen.findByTestId("auth-gate-create");
    expect(screen.getByTestId("follow-button").hasAttribute("data-filled-cta")).toBe(false);
    await waitFor(() => expect(signUpStyle()).toBe("outline"));
  });
});
