// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F1 in the shell: while the document could not check the session, `useBootstrapView` (behind
 * `useBootstrap`) says the session is unresolved, not signed out, and `useSessionRetryWith` (behind
 * `useSessionRetry`) offers a Retry that restarts the recovery after it gave up. F1/F2 on error boundaries: `PageLoadError` for a busy API, with an
 * automatic retry and a Retry, never "Something went wrong".
 */
import { LocaleProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { Bootstrap, SessionLookup, SessionUser } from "../src/lib/bootstrap-types.ts";
import { loadErrorNote, loadErrorPageTitle } from "../src/lib/load-copy.ts";
import { PageLoadError, isBusyPageError, resetPageAttemptsForTests } from "../src/lib/page-load-error.tsx";
import {
  SESSION_UNAVAILABLE,
  SessionUnavailableError,
  noteSession,
  resetSessionForTests,
  sessionUserOf,
} from "../src/lib/session.ts";
import { useBootstrapView, useSessionRetryWith } from "../src/lib/session-view.ts";

const fake = { boot: null as unknown as Bootstrap, lookup: vi.fn<() => Promise<SessionLookup>>() };

/** As `getSessionUser` does it: record the lookup, then the user or `SessionUnavailableError`. */
async function check(): Promise<SessionUser | null> {
  const lookup = await fake.lookup();
  noteSession(lookup);
  return sessionUserOf(lookup);
}

const user: SessionUser = { id: "u1", username: "ada", displayName: "Ada", channelSlug: "ada", role: "user" };

function boot(extra: Partial<Bootstrap> = {}): Bootstrap {
  return {
    config: {} as Bootstrap["config"],
    instance: { name: "Test Air", sourceUrl: null, p2pDefault: "off", chatSafety: false },
    me: null,
    theme: "dark",
    now: 0,
    locale: "en",
    dir: "ltr",
    localeFromUser: false,
    consent: null,
    ...extra,
  };
}

function makeRouter() {
  return createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
}

function wrap(node: React.ReactNode, router = makeRouter()) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        {node}
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

/** What a shell would show: an account placeholder with Retry while unresolved. */
function Shell(): React.JSX.Element {
  const { me, sessionUnresolved } = useBootstrapView(fake.boot, check);
  const session = useSessionRetryWith(sessionUnresolved, check);
  if (me) return <span data-testid="shell-me">{me.username}</span>;
  if (sessionUnresolved)
    return (
      <button
        type="button"
        data-testid="shell-retry"
        data-retrying={String(session.retrying)}
        data-gave-up={String(session.gaveUp)}
        onClick={session.retry}
      >
        retry
      </button>
    );
  return <span data-testid="shell-signed-out" />;
}

beforeEach(() => {
  resetSessionForTests();
  resetPageAttemptsForTests();
  fake.lookup.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useBootstrapView and useSessionRetryWith (F1)", () => {
  it("a definitive answer is never unresolved", () => {
    fake.boot = boot();
    wrap(<Shell />);
    expect(screen.getByTestId("shell-signed-out")).toBeTruthy();
    expect(fake.lookup).not.toHaveBeenCalled();
  });

  it("an unavailable session is unresolved, retries by itself, gives up, and Retry starts it over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fake.boot = boot({ sessionUnavailable: true });
    fake.lookup.mockResolvedValue({ status: "unavailable", retryAfterSeconds: 1 });
    const router = makeRouter();
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    wrap(<Shell />, router);
    const retry = screen.getByTestId("shell-retry");
    await waitFor(() => expect(retry.getAttribute("data-retrying")).toBe("true"));
    for (let i = 0; i < 3; i++) await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(screen.getByTestId("shell-retry").getAttribute("data-gave-up")).toBe("true"));
    expect(fake.lookup).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("shell-signed-out")).toBeNull();

    // Retry asks at once; the answer fills `me` in and reloads the route's data.
    fake.lookup.mockResolvedValue({ status: "signedIn", user });
    fireEvent.click(screen.getByTestId("shell-retry"));
    expect(await screen.findByTestId("shell-me")).toBeTruthy();
    expect(fake.lookup).toHaveBeenCalledTimes(4);
    await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
  });

  it("a later signed-out answer settles it as signed out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fake.boot = boot({ sessionUnavailable: true });
    fake.lookup.mockResolvedValue({ status: "signedOut" });
    wrap(<Shell />);
    expect(screen.getByTestId("shell-retry")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(await screen.findByTestId("shell-signed-out")).toBeTruthy();
  });
});

describe("PageLoadError (an error boundary's page for a busy API)", () => {
  it("isBusyPageError: a session that could not be checked, a 429 or a 503; not a 500 or a bug", () => {
    expect(isBusyPageError(new SessionUnavailableError())).toBe(true);
    expect(isBusyPageError(new Error(SESSION_UNAVAILABLE))).toBe(true);
    expect(isBusyPageError(Object.assign(new Error("x"), { code: "RATE_LIMITED", status: 429 }))).toBe(true);
    expect(isBusyPageError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isBusyPageError(Object.assign(new Error("x"), { status: 500 }))).toBe(false);
    expect(isBusyPageError(new Error("bug"))).toBe(false);
  });

  it("a guard's SessionUnavailableError: the page heading, busy, and a reload after retryAfterSeconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const router = makeRouter();
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    const reset = vi.fn<() => void>();
    wrap(<PageLoadError error={new SessionUnavailableError(3)} reset={reset} />, router);
    const page = screen.getByTestId("page-load-error");
    expect(page.querySelector("h1")?.textContent).toBe(loadErrorPageTitle());
    expect(page.textContent).toContain(loadErrorNote("busy", 3));
    expect(page.textContent).not.toContain(en["polish.error.title"]);
    expect(page.getAttribute("data-busy")).toBe("true");
    await act(() => vi.advanceTimersByTimeAsync(2_900));
    expect(invalidate).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(invalidate).toHaveBeenCalledOnce();
    await waitFor(() => expect(reset).toHaveBeenCalledOnce());
  });

  it("a serialized SessionUnavailableError still retries; after three it is Retry only, which starts over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const router = makeRouter();
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    const error = new Error(SESSION_UNAVAILABLE);
    // The boundary remounts after each failed retry: the attempts carry over.
    for (let i = 0; i < 3; i++) {
      const { unmount } = wrap(<PageLoadError error={error} />, router);
      expect(screen.getByTestId("page-load-error").getAttribute("data-busy")).toBe("true");
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      unmount();
    }
    expect(invalidate).toHaveBeenCalledTimes(3);
    wrap(<PageLoadError error={error} />, router);
    const page = screen.getByTestId("page-load-error");
    expect(page.getAttribute("data-busy")).toBeNull();
    expect(page.textContent).toContain(loadErrorNote("stillFailing"));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(invalidate).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByTestId("page-load-error-retry"));
    expect(invalidate).toHaveBeenCalledTimes(4);
    // The reload failed again: the boundary's next page retries by itself once more.
    cleanup();
    wrap(<PageLoadError error={error} />, router);
    expect(screen.getByTestId("page-load-error").getAttribute("data-busy")).toBe("true");
  });
});
