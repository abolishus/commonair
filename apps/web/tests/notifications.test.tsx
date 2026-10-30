// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The bell, its popover inbox and the notification settings page, with fixture clients (N1-inbox). */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { toast } from "@commonair/ui/toast";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NotificationBell } from "../src/components/notifications/bell.tsx";
import { NotificationSettings } from "../src/components/notifications/settings.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type {
  FollowDto,
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

const follow = (slug: string, notify = true): FollowDto => ({
  channel: { id: CH, slug, displayName: `Display ${slug}`, avatarUrl: null, accent: "zinc" },
  live: null,
  followedAt: "2026-10-01T00:00:00.000Z",
  notify,
});

interface SettingsFixture extends SettingsClient {
  setPreference: ReturnType<typeof vi.fn<(input: SetPreferenceInput) => Promise<NotificationPreferencesDto>>>;
  setBell: ReturnType<typeof vi.fn<(channel: string, notify: boolean) => Promise<void>>>;
}

function settings(prefs: NotificationPreferencesDto, follows: FollowDto[] = []): SettingsFixture {
  const page: FollowPage = { items: follows, nextCursor: null };
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

  it("lists followed channels with the bell and the email/push selects", async () => {
    const client = settings(
      prefsFixture({
        channels: [{ channel: { id: CH, slug: "alpha", displayName: "Display alpha" }, media: { push: false } }],
      }),
      [follow("alpha"), follow("bravo", false)],
    );
    wrap(<NotificationSettings client={client} />);
    await waitFor(() => expect(allById("notify-channel")).toHaveLength(2));
    const [alpha, bravo] = allById("notify-channel");
    expect([alpha?.getAttribute("data-slug"), bravo?.getAttribute("data-slug")]).toEqual(["alpha", "bravo"]);
    const cell = (row: HTMLElement | undefined, id: string) => row?.querySelector(`[data-testid="${id}"]`);
    expect(cell(alpha, "notify-channel-bell")?.getAttribute("data-state")).toBe("on");
    expect(cell(bravo, "notify-channel-bell")?.getAttribute("data-state")).toBe("off");
    expect(cell(alpha, "notify-channel-email")?.getAttribute("data-value")).toBe("default");
    expect(cell(alpha, "notify-channel-push")?.getAttribute("data-value")).toBe("off");
    expect(cell(alpha, "notify-channel-email")?.textContent).toContain(en["notifySettings.option.defaultOff"]);
  });

  it("the channel bell calls channels.follow with notify, and rolls back on failure", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => 1);
    const client = settings(prefsFixture(), [follow("alpha")]);
    wrap(<NotificationSettings client={client} />);
    await waitFor(() => expect(byId("notify-channel-bell")).not.toBeNull());
    fireEvent.click(byId("notify-channel-bell") as HTMLElement);
    await waitFor(() => expect(client.setBell).toHaveBeenCalledWith("alpha", false));
    expect(byId("notify-channel-bell")?.getAttribute("data-state")).toBe("off");

    client.setBell.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(byId("notify-channel-bell") as HTMLElement);
    await waitFor(() => expect(client.setBell).toHaveBeenCalledWith("alpha", true));
    await waitFor(() => expect(byId("notify-channel-bell")?.getAttribute("data-state")).toBe("off"));
  });

  it("out-of-order bell answers: a late failure of an older click does not undo the newer one", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => 1);
    const client = settings(prefsFixture(), [follow("alpha")]);
    const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
    client.setBell.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    wrap(<NotificationSettings client={client} />);
    await waitFor(() => expect(byId("notify-channel-bell")).not.toBeNull());
    fireEvent.click(byId("notify-channel-bell") as HTMLElement); // on -> off
    await waitFor(() => expect(byId("notify-channel-bell")?.getAttribute("data-state")).toBe("off"));
    fireEvent.click(byId("notify-channel-bell") as HTMLElement); // off -> on
    await waitFor(() => expect(byId("notify-channel-bell")?.getAttribute("data-state")).toBe("on"));
    fireEvent.click(byId("notify-channel-bell") as HTMLElement); // on -> off
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => pending[2]?.resolve());
    await act(async () => pending[1]?.resolve());
    // The first click's failure arrives last; rolling it back would turn the bell on again.
    await act(async () => pending[0]?.reject(new Error("boom")));
    expect(byId("notify-channel-bell")?.getAttribute("data-state")).toBe("off");
  });

  it("a failed bell rolls back to the value before the click", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => 1);
    const client = settings(prefsFixture(), [follow("alpha", false)]);
    client.setBell.mockRejectedValueOnce(new Error("boom"));
    wrap(<NotificationSettings client={client} />);
    await waitFor(() => expect(byId("notify-channel-bell")).not.toBeNull());
    fireEvent.click(byId("notify-channel-bell") as HTMLElement);
    await waitFor(() => expect(client.setBell).toHaveBeenCalledWith("alpha", true));
    await waitFor(() => expect(byId("notify-channel-bell")?.getAttribute("data-state")).toBe("off"));
  });

  async function pick(field: string, option: string): Promise<void> {
    const trigger = byId(field);
    if (!trigger) throw new Error(`no ${field}`);
    fireEvent.click(trigger);
    await waitFor(() => expect(byId(option)).not.toBeNull());
    // Base UI commits a mouse click only when the press started on the item.
    const item = byId(option) as HTMLElement;
    fireEvent.pointerDown(item, { pointerType: "mouse" });
    fireEvent.click(item);
  }

  it("a select change calls preferences.set with the right enabled (on, off, default → null)", async () => {
    const client = settings(prefsFixture(), [follow("alpha")]);
    const answers: NotificationPreferencesDto[] = [
      prefsFixture({
        channels: [{ channel: { id: CH, slug: "alpha", displayName: "Display alpha" }, media: { email: true } }],
      }),
      prefsFixture({
        channels: [
          { channel: { id: CH, slug: "alpha", displayName: "Display alpha" }, media: { email: true, push: false } },
        ],
      }),
      prefsFixture({
        channels: [{ channel: { id: CH, slug: "alpha", displayName: "Display alpha" }, media: { push: false } }],
      }),
    ];
    for (const a of answers) client.setPreference.mockResolvedValueOnce(a);
    wrap(<NotificationSettings client={client} />);
    await waitFor(() => expect(byId("notify-channel-email")).not.toBeNull());

    await pick("notify-channel-email", "notify-channel-email-on");
    await waitFor(() =>
      expect(client.setPreference).toHaveBeenLastCalledWith({ medium: "email", channel: "alpha", enabled: true }),
    );
    await waitFor(() => expect(byId("notify-channel-email")?.getAttribute("data-value")).toBe("on"));

    await pick("notify-channel-push", "notify-channel-push-off");
    await waitFor(() =>
      expect(client.setPreference).toHaveBeenLastCalledWith({ medium: "push", channel: "alpha", enabled: false }),
    );

    await pick("notify-channel-email", "notify-channel-email-default");
    await waitFor(() =>
      expect(client.setPreference).toHaveBeenLastCalledWith({ medium: "email", channel: "alpha", enabled: null }),
    );
    await waitFor(() => expect(byId("notify-channel-email")?.getAttribute("data-value")).toBe("default"));
    expect(byId("notify-channel-push")?.getAttribute("data-value")).toBe("off");
  });

  it("a failed select change rolls back", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    const client = settings(prefsFixture(), [follow("alpha")]);
    client.setPreference.mockRejectedValueOnce(new Error("boom"));
    wrap(<NotificationSettings client={client} />);
    await waitFor(() => expect(byId("notify-channel-email")).not.toBeNull());
    await pick("notify-channel-email", "notify-channel-email-off");
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(byId("notify-channel-email")?.getAttribute("data-value")).toBe("default");
  });

  it("no follows: an empty state", async () => {
    wrap(<NotificationSettings client={settings(prefsFixture())} />);
    await loaded();
    await waitFor(() => expect(screen.getByText(en["notifySettings.channels.empty"])).toBeTruthy());
    expect(within(document.body).queryByTestId("notify-channel")).toBeNull();
  });
});
