// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F3 on the notification surfaces: the inbox and each notification settings section fail on their
 * own (the section's name and Retry); a 429 retries by itself (F2).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NotificationInbox } from "../src/components/notifications/inbox.tsx";
import { NotificationSettings } from "../src/components/notifications/settings.tsx";
import { en } from "../src/i18n/en.ts";
import { loadErrorNote, loadErrorTitle } from "../src/lib/load-copy.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type {
  FollowPage,
  InboxClient,
  NotificationPage,
  NotificationPreferencesDto,
  SettingsClient,
} from "../src/lib/notifications.ts";

vi.mock("../src/components/pwa/push-toggle.tsx", () => ({
  PushToggle: () => <span data-testid="fake-push" />,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

const serverError = () => Object.assign(new Error("boom"), { code: "INTERNAL_SERVER_ERROR", status: 500 });
const rateLimited = (seconds: number) =>
  Object.assign(new Error("busy"), { code: "RATE_LIMITED", status: 429, data: { retryAfterSeconds: seconds } });

const prefs: NotificationPreferencesDto = {
  defaults: { in_app: true, email: false, push: false },
  builtIn: { in_app: true, email: false, push: false },
  channels: [],
  emailVerified: true,
} as unknown as NotificationPreferencesDto;

const emptyFollows: FollowPage = { items: [], nextCursor: null } as unknown as FollowPage;

function settingsClient(over: Partial<SettingsClient> = {}): SettingsClient {
  return {
    preferences: vi.fn<() => Promise<NotificationPreferencesDto>>(async () => prefs),
    setPreference: vi.fn<SettingsClient["setPreference"]>(async () => prefs),
    follows: vi.fn<(cursor: string | null) => Promise<FollowPage>>(async () => emptyFollows),
    setBell: vi.fn<SettingsClient["setBell"]>(async () => {}),
    ...over,
  };
}

function inboxClient(list: InboxClient["list"]): InboxClient {
  return {
    unreadCount: async () => ({ count: 0, capped: false }),
    list,
    markRead: async () => {},
  };
}

const noop = () => {};

describe("NotificationInbox", () => {
  it("a failed first page is a LoadError with Retry, and Mark all read stays off", async () => {
    let fail = true;
    const list = vi.fn<(cursor: string | null) => Promise<NotificationPage>>(async () => {
      if (fail) throw serverError();
      return { items: [], nextCursor: null } as unknown as NotificationPage;
    });
    wrap(
      <NotificationInbox
        client={inboxClient(list)}
        onReadOne={noop}
        onReadAll={noop}
        onRefreshCount={noop}
        onNavigate={noop}
      />,
    );
    const error = await screen.findByTestId("notification-load-error");
    expect(error.querySelector("h3")?.textContent).toBe(loadErrorTitle(en["notifications.title"]));
    expect(error.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("notification-mark-all-read").hasAttribute("disabled")).toBe(true);
    fail = false;
    fireEvent.click(within(error).getByTestId("notification-retry"));
    expect(await screen.findByTestId("notification-empty")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("a 429 retries by itself and then shows the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const list = vi.fn<(cursor: string | null) => Promise<NotificationPage>>(async () => {
      calls++;
      if (calls === 1) throw rateLimited(2);
      return { items: [], nextCursor: null } as unknown as NotificationPage;
    });
    wrap(
      <NotificationInbox
        client={inboxClient(list)}
        onReadOne={noop}
        onReadAll={noop}
        onRefreshCount={noop}
        onNavigate={noop}
      />,
    );
    const error = await screen.findByTestId("notification-load-error");
    expect(error.textContent).toContain(loadErrorNote("busy", 2));
    expect(error.getAttribute("data-busy")).toBe("true");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await screen.findByTestId("notification-empty")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("NotificationSettings", () => {
  it("failed defaults keep their heading and the channels section", async () => {
    const preferences = vi.fn<() => Promise<NotificationPreferencesDto>>(async () => {
      throw serverError();
    });
    const client = settingsClient({ preferences });
    wrap(<NotificationSettings client={client} />);
    const error = await screen.findByTestId("notify-defaults-load-error");
    expect(error.textContent).toContain(loadErrorTitle(en["notifySettings.defaults.title"]));
    expect(error.textContent).toContain(loadErrorNote("section"));
    expect(screen.getByRole("heading", { level: 2, name: en["notifySettings.defaults.title"] })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: en["notifySettings.channels.title"] })).toBeTruthy();
    expect(await screen.findByText(en["notifySettings.channels.empty"])).toBeTruthy();
    preferences.mockResolvedValue(prefs);
    fireEvent.click(within(error).getByTestId("notify-defaults-retry"));
    await waitFor(() => expect(document.querySelector('[data-testid="notify-default-email"]')).not.toBeNull());
    expect(screen.queryByTestId("notify-defaults-load-error")).toBeNull();
  });

  it("failed channels keep the defaults", async () => {
    const follows = vi.fn<(cursor: string | null) => Promise<FollowPage>>(async () => {
      throw serverError();
    });
    const client = settingsClient({ follows });
    wrap(<NotificationSettings client={client} />);
    const error = await screen.findByTestId("notify-channels-load-error");
    expect(error.textContent).toContain(loadErrorTitle(en["notifySettings.channels.title"]));
    await waitFor(() => expect(document.querySelector('[data-testid="notify-default-email"]')).not.toBeNull());
    follows.mockResolvedValue(emptyFollows);
    fireEvent.click(within(error).getByTestId("notify-channels-retry"));
    expect(await screen.findByText(en["notifySettings.channels.empty"])).toBeTruthy();
  });
});
