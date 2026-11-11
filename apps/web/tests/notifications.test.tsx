// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The bell, its popover inbox and the notification settings page, with fixture clients (N1-inbox). */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { toast } from "@commonair/ui/toast";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NotificationBell } from "../src/components/notifications/bell.tsx";
import { NotificationSettings } from "../src/components/notifications/settings.tsx";

// The real switch needs a browser's push stack; this one only reports "turned on".
// Counting is a network call; these tests do not count.
vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: () => undefined }));
vi.mock("../src/components/pwa/push-toggle.tsx", () => ({
  PushToggle: ({ onPushOn }: { onPushOn?: () => void }) => (
    <button type="button" data-testid="fake-push-on" onClick={() => onPushOn?.()}>
      push on
    </button>
  ),
}));
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type {
  FollowPage,
  InboxClient,
  NotificationDto,
  NotificationPage,
  NotificationPreferencesDto,
  SetPreferenceInput,
  SettingsClient,
  UnreadCount,
} from "../src/lib/notifications.ts";
import { UNREAD_POLL_MS } from "../src/lib/notifications.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <NowProvider now={Date.parse("2026-10-20T00:05:00.000Z")}>
          <TooltipProvider>{node}</TooltipProvider>
        </NowProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allById = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

const CH = "0192f000-0000-7000-8000-0000000000c1";
const BC = "0192f000-0000-7000-8000-0000000000b1";

const goLive = (id: string, over: Partial<NotificationDto> = {}): NotificationDto => ({
  id,
  type: "go_live",
  payload: { channelId: CH, slug: "rivertide", broadcastId: BC, title: "Night run" },
  readAt: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  ...over,
});

interface InboxFixture extends InboxClient {
  unreadCount: ReturnType<typeof vi.fn<() => Promise<UnreadCount>>>;
  list: ReturnType<typeof vi.fn<(cursor: string | null) => Promise<NotificationPage>>>;
  markRead: ReturnType<typeof vi.fn<(ids?: string[]) => Promise<void>>>;
}

function inbox(unread: UnreadCount, pages: NotificationPage[] = [{ items: [], nextCursor: null }]): InboxFixture {
  let current = unread;
  return {
    unreadCount: vi.fn<() => Promise<UnreadCount>>(async () => current),
    list: vi.fn<(cursor: string | null) => Promise<NotificationPage>>(
      async (cursor: string | null) => (cursor === null ? pages[0] : pages[1]) ?? { items: [], nextCursor: null },
    ),
    markRead: vi.fn<(ids?: string[]) => Promise<void>>(async () => {
      current = { count: 0, capped: false };
    }),
  };
}

const bell = () => byId("notification-bell");

async function openBell(): Promise<void> {
  const b = bell();
  if (!b) throw new Error("no bell");
  fireEvent.click(b);
  await waitFor(() => expect(byId("notification-list") ?? byId("notification-empty")).not.toBeNull());
}

describe("NotificationBell", () => {
  it("0 unread: data-unread 0, not capped, no badge", async () => {
    const client = inbox({ count: 0, capped: false });
    wrap(<NotificationBell client={client} />);
    await waitFor(() => expect(client.unreadCount).toHaveBeenCalled());
    expect(bell()?.getAttribute("data-unread")).toBe("0");
    expect(bell()?.getAttribute("data-capped")).toBe("false");
    expect(byId("notification-bell-badge")).toBeNull();
    expect(bell()?.getAttribute("aria-label")).toBe("Notifications");
  });

  it("5 unread: the badge says 5 and the label counts them", async () => {
    wrap(<NotificationBell client={inbox({ count: 5, capped: false })} />);
    await waitFor(() => expect(bell()?.getAttribute("data-unread")).toBe("5"));
    expect(byId("notification-bell-badge")?.textContent).toBe("5");
    expect(bell()?.getAttribute("aria-label")).toBe("Notifications, 5 unread");
  });

  it("capped: 99+ and data-capped true", async () => {
    wrap(<NotificationBell client={inbox({ count: 99, capped: true })} />);
    await waitFor(() => expect(bell()?.getAttribute("data-capped")).toBe("true"));
    expect(bell()?.getAttribute("data-unread")).toBe("99");
    expect(byId("notification-bell-badge")?.textContent).toBe("99+");
    expect(bell()?.getAttribute("aria-label")).toBe("Notifications, more than 99 unread");
  });

  it("polls every minute while visible, not while hidden, and stops on UNAUTHORIZED", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const client = inbox({ count: 1, capped: false });
    wrap(<NotificationBell client={client} />);
    await act(async () => {});
    expect(client.unreadCount).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(UNREAD_POLL_MS);
    });
    expect(client.unreadCount).toHaveBeenCalledTimes(2);

    // Hidden: no polling at all.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(UNREAD_POLL_MS * 3);
    });
    expect(client.unreadCount).toHaveBeenCalledTimes(2);

    // Visible again: asks at once, then every minute.
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(client.unreadCount).toHaveBeenCalledTimes(3);

    // Signed out elsewhere: the next answer is UNAUTHORIZED and polling stops.
    client.unreadCount.mockRejectedValue(Object.assign(new Error("signed out"), { code: "UNAUTHORIZED" }));
    await act(async () => {
      vi.advanceTimersByTime(UNREAD_POLL_MS);
    });
    expect(client.unreadCount).toHaveBeenCalledTimes(4);
    await act(async () => {
      vi.advanceTimersByTime(UNREAD_POLL_MS * 3);
      window.dispatchEvent(new Event("focus"));
    });
    expect(client.unreadCount).toHaveBeenCalledTimes(4);
  });

  it("the popover lists items: a go-live links to the channel, a generic one has its label; opening reads nothing", async () => {
    const client = inbox({ count: 2, capped: false }, [
      {
        items: [
          goLive("n1"),
          {
            id: "n2",
            type: "system",
            payload: { kind: "something", text: "<img src=x onerror=alert(1)>" },
            readAt: "2026-10-19T00:00:00.000Z",
            createdAt: "2026-10-19T00:00:00.000Z",
          },
          goLive("n3", { payload: { channelId: CH, slug: "matureone", broadcastId: BC, title: "" } }),
        ],
        nextCursor: null,
      },
    ]);
    wrap(<NotificationBell client={client} />);
    await waitFor(() => expect(bell()?.getAttribute("data-unread")).toBe("2"));
    await openBell();
    const items = allById("notification-item");
    expect(
      items.map((i) => [i.getAttribute("data-id"), i.getAttribute("data-type"), i.getAttribute("data-state")]),
    ).toEqual([
      ["n1", "go_live", "unread"],
      ["n2", "system", "read"],
      ["n3", "go_live", "unread"],
    ]);
    const [first, second, third] = items;
    const link = first?.querySelector('[data-testid="notification-item-link"]');
    expect(link?.getAttribute("href")).toBe("/rivertide");
    expect(first?.textContent).toContain("rivertide went live");
    expect(first?.textContent).toContain("Night run");
    expect(second?.querySelector('[data-testid="notification-item-link"]')).toBeNull();
    expect(second?.textContent).toContain(en["notifications.type.system"]);
    expect(second?.querySelector("img")).toBeNull();
    expect(third?.textContent).toContain("matureone went live");
    expect(third?.textContent).not.toContain("Night run");
    expect(client.list).toHaveBeenCalledWith(null);
    expect(client.markRead).not.toHaveBeenCalled();
    expect(byId("notification-settings-link")?.getAttribute("href")).toBe("/settings/notifications");
    expect(byId("notification-load-more")).toBeNull();
  });

  it("clicking an item marks that one read and counts down", async () => {
    const client = inbox({ count: 2, capped: false }, [{ items: [goLive("n1"), goLive("n2")], nextCursor: null }]);
    wrap(<NotificationBell client={client} />);
    await waitFor(() => expect(bell()?.getAttribute("data-unread")).toBe("2"));
    await openBell();
    const link = allById("notification-item-link")[1];
    if (!link) throw new Error("no link");
    fireEvent.click(link);
    expect(client.markRead).toHaveBeenCalledWith(["n2"]);
    await waitFor(() => expect(bell()?.getAttribute("data-unread")).toBe("1"));
  });

  it("empty: notification-empty instead of the list", async () => {
    wrap(<NotificationBell client={inbox({ count: 0, capped: false })} />);
    await openBell();
    expect(byId("notification-empty")).not.toBeNull();
    expect(byId("notification-list")).toBeNull();
    expect(byId("notification-mark-all-read")?.hasAttribute("disabled")).toBe(true);
  });

  it("mark all read: every item read and the badge gone", async () => {
    const client = inbox({ count: 2, capped: false }, [{ items: [goLive("n1"), goLive("n2")], nextCursor: null }]);
    wrap(<NotificationBell client={client} />);
    await waitFor(() => expect(bell()?.getAttribute("data-unread")).toBe("2"));
    await openBell();
    const mark = byId("notification-mark-all-read");
    if (!mark) throw new Error("no mark-all-read");
    fireEvent.click(mark);
    await waitFor(() => expect(bell()?.getAttribute("data-unread")).toBe("0"));
    expect(client.markRead).toHaveBeenCalledWith();
    expect(allById("notification-item").map((i) => i.getAttribute("data-state"))).toEqual(["read", "read"]);
    expect(byId("notification-bell-badge")).toBeNull();
  });

  it("load more appends the next page", async () => {
    const client = inbox({ count: 0, capped: false }, [
      { items: [goLive("n1", { readAt: "2026-10-20T00:01:00.000Z" })], nextCursor: "c1" },
      { items: [goLive("n2", { readAt: "2026-10-20T00:01:00.000Z" })], nextCursor: null },
    ]);
    wrap(<NotificationBell client={client} />);
    await openBell();
    const more = byId("notification-load-more");
    if (!more) throw new Error("no load more");
    fireEvent.click(more);
    await waitFor(() => expect(allById("notification-item")).toHaveLength(2));
    expect(client.list).toHaveBeenLastCalledWith("c1");
    expect(byId("notification-load-more")).toBeNull();
  });
});

// ------------------------------------------------------------------ settings

const prefsFixture = (over: Partial<NotificationPreferencesDto> = {}): NotificationPreferencesDto => ({
  type: "go_live",
  defaults: { in_app: true, email: false, push: false },
  builtIn: { in_app: true, email: true, push: true },
  channels: [],
  emailVerified: true,
  ...over,
});

// The per-channel bell and overrides moved to /following (overhaul wave 5): w5-following-alerts.test.tsx.
interface SettingsFixture extends SettingsClient {
  preferences: ReturnType<typeof vi.fn<() => Promise<NotificationPreferencesDto>>>;
  setPreference: ReturnType<typeof vi.fn<(input: SetPreferenceInput) => Promise<NotificationPreferencesDto>>>;
  setBell: ReturnType<typeof vi.fn<(channel: string, notify: boolean) => Promise<void>>>;
}

function settings(prefs: NotificationPreferencesDto): SettingsFixture {
  const page: FollowPage = { items: [], nextCursor: null };
  return {
    preferences: vi.fn<() => Promise<NotificationPreferencesDto>>(async () => prefs),
    setPreference: vi.fn<(input: SetPreferenceInput) => Promise<NotificationPreferencesDto>>(async () => prefs),
    follows: vi.fn<(cursor: string | null) => Promise<FollowPage>>(async () => page),
    setBell: vi.fn<(channel: string, notify: boolean) => Promise<void>>(async () => {}),
  };
}

const loaded = () => waitFor(() => expect(byId("notify-default-email")).not.toBeNull());

describe("NotificationSettings", () => {
  it("built-in markers and states on the three default switches; no unverified notice", async () => {
    wrap(
      <NotificationSettings
        client={settings(
          prefsFixture({
            defaults: { in_app: true, email: true, push: false },
            builtIn: { in_app: true, email: false, push: true },
          }),
        )}
      />,
    );
    await loaded();
    const rows = ["in_app", "email", "push"].map((m) => byId(`notify-default-${m}`));
    expect(rows.map((r) => [r?.getAttribute("data-state"), r?.getAttribute("data-builtin")])).toEqual([
      ["on", "true"],
      ["on", "false"],
      ["off", "true"],
    ]);
    expect(byId("notify-email-unverified")).toBeNull();
  });

  it("an unverified address shows the notice and email stays usable", async () => {
    const client = settings(prefsFixture({ emailVerified: false }));
    wrap(<NotificationSettings client={client} />);
    await loaded();
    expect(byId("notify-email-unverified")?.textContent).toBe(en["notifySettings.emailUnverified"]);
    const email = byId("notify-default-email");
    if (!email) throw new Error("no switch");
    expect(email.hasAttribute("disabled") || email.getAttribute("aria-disabled") === "true").toBe(false);
    fireEvent.click(email);
    await waitFor(() =>
      expect(client.setPreference).toHaveBeenCalledWith({ medium: "email", channel: null, enabled: true }),
    );
  });

  it("turning browser push on rereads the go-live push default", async () => {
    const client = settings(prefsFixture());
    wrap(<NotificationSettings client={client} />);
    await loaded();
    expect(byId("notify-default-push")?.getAttribute("data-state")).toBe("off");
    client.preferences.mockResolvedValue(
      prefsFixture({
        defaults: { in_app: true, email: false, push: true },
        builtIn: { in_app: true, email: true, push: false },
      }),
    );
    fireEvent.click(byId("fake-push-on") as HTMLElement);
    await waitFor(() => expect(byId("notify-default-push")?.getAttribute("data-state")).toBe("on"));
    expect(byId("notify-default-push")?.getAttribute("data-builtin")).toBe("false");
  });

  it("a default switch is optimistic: on at once, then the server's answer", async () => {
    const client = settings(prefsFixture());
    let resolve: (p: NotificationPreferencesDto) => void = () => undefined;
    client.setPreference.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    wrap(<NotificationSettings client={client} />);
    await loaded();
    fireEvent.click(byId("notify-default-push") as HTMLElement);
    await waitFor(() => expect(byId("notify-default-push")?.getAttribute("data-state")).toBe("on"));
    expect(byId("notify-default-push")?.getAttribute("data-builtin")).toBe("false");
    await act(async () => {
      resolve(
        prefsFixture({
          defaults: { in_app: true, email: false, push: true },
          builtIn: { in_app: true, email: true, push: false },
        }),
      );
    });
    expect(byId("notify-default-push")?.getAttribute("data-state")).toBe("on");
  });

  it("one cell's answer does not undo another cell still being saved", async () => {
    const client = settings(prefsFixture());
    const pending: ((p: NotificationPreferencesDto) => void)[] = [];
    client.setPreference.mockImplementation(
      () =>
        new Promise((r) => {
          pending.push(r);
        }),
    );
    wrap(<NotificationSettings client={client} />);
    await loaded();
    fireEvent.click(byId("notify-default-email") as HTMLElement);
    fireEvent.click(byId("notify-default-push") as HTMLElement);
    await waitFor(() => expect(pending).toHaveLength(2));
    // The email answer predates the push save, so it still says push is off.
    await act(async () => {
      pending[0]?.(
        prefsFixture({
          defaults: { in_app: true, email: true, push: false },
          builtIn: { in_app: true, email: false, push: true },
        }),
      );
    });
    expect(byId("notify-default-email")?.getAttribute("data-state")).toBe("on");
    expect(byId("notify-default-push")?.getAttribute("data-state")).toBe("on");
    expect(byId("notify-default-push")?.getAttribute("data-builtin")).toBe("false");
  });

  it("a failed default change rolls back and shows notify-save-error", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    const client = settings(prefsFixture());
    client.setPreference.mockRejectedValue(new Error("boom"));
    wrap(<NotificationSettings client={client} />);
    await loaded();
    fireEvent.click(byId("notify-default-email") as HTMLElement);
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(byId("notify-default-email")?.getAttribute("data-state")).toBe("off");
    expect(byId("notify-default-email")?.getAttribute("data-builtin")).toBe("true");
    const message = error.mock.calls[0]?.[0];
    const { container } = render(<>{message}</>);
    expect(container.querySelector('[data-testid="notify-save-error"]')?.textContent).toBe(
      en["notifySettings.saveFailed"],
    );
  });
});
