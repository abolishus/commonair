// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 5: each followed channel's go-live alerts on `/following` (moved from
 * `/settings/notifications`). Live cards and offline rows both get the bell; while it is on,
 * "Email and push" opens the channel's overrides. The page loads no preferences until someone
 * opens them, then once for every row; a change is optimistic, toasts, and rolls back on failure.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NotificationPreferencesDto, SetPreferenceInput } from "../src/lib/notifications.ts";
import { MEMBER, home, live, offline } from "./d1-fixtures.tsx";
import { renderHome } from "./d3-home-fixtures.tsx";

type Row = { channel: ReturnType<typeof live>["channel"]; live: unknown; followedAt: string; notify: boolean };
const fake = vi.hoisted(() => ({
  follows: null as unknown as () => Promise<{ items: Row[]; nextCursor: string | null }>,
  follow: null as unknown as (input: unknown) => Promise<unknown>,
  prefsGet: null as unknown as (input: unknown) => Promise<NotificationPreferencesDto>,
  prefsSet: null as unknown as (input: unknown) => Promise<NotificationPreferencesDto>,
  toasts: [] as string[],
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    me: { follows: () => fake.follows() },
    channels: { follow: (input: unknown) => fake.follow(input) },
    directory: { home: () => new Promise(() => {}) },
    notifications: {
      preferences: { get: (input: unknown) => fake.prefsGet(input), set: (input: unknown) => fake.prefsSet(input) },
    },
  }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: () => undefined }));
// A toast's node is rendered to text, so the saved and error ids can be checked too.
vi.mock("@commonair/ui/toast", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const text = (m: unknown) => (typeof m === "string" ? m : renderToStaticMarkup(m as React.ReactElement));
  return {
    toast: {
      success: (m: unknown) => fake.toasts.push(`ok:${text(m)}`),
      error: (m: unknown) => fake.toasts.push(`err:${text(m)}`),
    },
  };
});

const { FollowingPage } = await import("../src/components/following/following-page.tsx");
const { primeHomeFeed, resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { t } = await import("../src/i18n/index.ts");

const row = (slug: string, over: Partial<Row> = {}): Row => ({
  channel: live(slug).channel,
  live: null,
  followedAt: "2026-11-01T12:00:00.000Z",
  notify: true,
  ...over,
});

const prefs = (channels: NotificationPreferencesDto["channels"] = []): NotificationPreferencesDto => ({
  type: "go_live",
  defaults: { in_app: true, email: true, push: false },
  builtIn: { in_app: true, email: false, push: true },
  channels,
  emailVerified: true,
});

let gets: unknown[];
let sets: SetPreferenceInput[];
beforeEach(() => {
  gets = [];
  sets = [];
  fake.toasts = [];
  fake.follow = async () => ({ following: true, followerCount: 1 });
  fake.prefsGet = async (input) => {
    gets.push(input);
    return prefs();
  };
  fake.prefsSet = async (input) => {
    sets.push(input as SetPreferenceInput);
    const i = input as SetPreferenceInput & { type: string };
    const ch = live(i.channel ?? "x").channel;
    return prefs(
      i.enabled === null
        ? []
        : [{ channel: { id: ch.id, slug: ch.slug, displayName: ch.displayName }, media: { [i.medium]: i.enabled } }],
    );
  };
});
afterEach(() => {
  cleanup();
  resetHomeFeed();
});

const controlsOf = (slug: string) => {
  const el = document.querySelector(`[data-testid="notify-channel"][data-slug="${slug}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no controls for ${slug}`);
  return el;
};

async function openOptions(slug: string): Promise<HTMLElement> {
  await act(async () => fireEvent.click(within(controlsOf(slug)).getByTestId("following-alert-options")));
  return screen.findByTestId("following-alert-popover");
}

async function pick(field: string, option: string): Promise<void> {
  fireEvent.click(screen.getByTestId(field));
  const item = await screen.findByTestId(option);
  // Base UI commits a mouse click only when the press started on the item.
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  await act(async () => fireEvent.click(item));
}

describe("/following alert controls", () => {
  it("a live card and an offline row each get the bell; Email and push only while it is on", async () => {
    primeHomeFeed(home({ following: [live("busy", { viewers: 5 })], followingOffline: [] }), MEMBER.id);
    fake.follows = async () => ({
      items: [row("busy", { live: live("busy", { viewers: 5 }).broadcast }), row("quiet", { notify: false })],
      nextCursor: null,
    });
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    await screen.findByTestId("following-live");
    const busy = controlsOf("busy");
    const quiet = controlsOf("quiet");
    expect(within(busy).getByTestId("notify-channel-bell").getAttribute("data-state")).toBe("on");
    expect(within(quiet).getByTestId("notify-channel-bell").getAttribute("data-state")).toBe("off");
    expect(within(busy).getByTestId("following-alert-options").getAttribute("aria-label")).toBe(
      t("w5Watch.alerts.optionsLabel", { channel: "busy" }),
    );
    expect(within(quiet).queryByTestId("following-alert-options")).toBeNull();
    // The page asks for no preferences until someone opens the options.
    expect(gets).toEqual([]);

    // Turning the live channel's bell off goes through channels.follow and hides its options.
    await act(async () => fireEvent.click(within(busy).getByTestId("notify-channel-bell")));
    await waitFor(() =>
      expect(within(controlsOf("busy")).getByTestId("notify-channel-bell").getAttribute("data-state")).toBe("off"),
    );
    expect(within(controlsOf("busy")).queryByTestId("following-alert-options")).toBeNull();
    expect(fake.toasts).toContain(`ok:${t("d3Home.followingPage.alertOffToast", { channel: "busy" })}`);
  });

  it("opening the options loads the go-live preferences once for the whole page", async () => {
    fake.follows = async () => ({ items: [row("alpha"), row("bravo")], nextCursor: null });
    fake.prefsGet = async (input) => {
      gets.push(input);
      return prefs([{ channel: { id: "id-alpha", slug: "alpha", displayName: "alpha" }, media: { push: true } }]);
    };
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    await screen.findAllByTestId("following-row");
    const popover = await openOptions("alpha");
    await waitFor(() => expect(within(popover).getByTestId("notify-channel-email")).toBeTruthy());
    expect(gets).toEqual([{ type: "go_live" }]);
    expect(within(popover).getByTestId("notify-channel-email").getAttribute("data-value")).toBe("default");
    expect(within(popover).getByTestId("notify-channel-email").textContent).toContain(
      t("notifySettings.option.defaultOn"),
    );
    expect(within(popover).getByTestId("notify-channel-push").getAttribute("data-value")).toBe("on");
    expect(within(popover).getByTestId("notify-channel-push").getAttribute("aria-label")).toBe(
      t("notifySettings.channels.push", { channel: "alpha" }),
    );
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("following-alert-popover")).toBeNull());

    const other = await openOptions("bravo");
    await waitFor(() => expect(within(other).getByTestId("notify-channel-push")).toBeTruthy());
    expect(within(other).getByTestId("notify-channel-push").getAttribute("data-value")).toBe("default");
    expect(gets).toHaveLength(1);
  });

  it("a choice saves with the channel (on, off, default → null) and toasts", async () => {
    fake.follows = async () => ({ items: [row("alpha")], nextCursor: null });
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    await screen.findByTestId("following-row");
    const popover = await openOptions("alpha");
    await waitFor(() => expect(within(popover).getByTestId("notify-channel-email")).toBeTruthy());

    await pick("notify-channel-email", "notify-channel-email-off");
    await waitFor(() => expect(screen.getByTestId("notify-channel-email").getAttribute("data-value")).toBe("off"));
    await pick("notify-channel-push", "notify-channel-push-on");
    await waitFor(() => expect(screen.getByTestId("notify-channel-push").getAttribute("data-value")).toBe("on"));
    await pick("notify-channel-push", "notify-channel-push-default");
    await waitFor(() => expect(screen.getByTestId("notify-channel-push").getAttribute("data-value")).toBe("default"));
    expect(sets).toEqual([
      { type: "go_live", medium: "email", channel: "alpha", enabled: false },
      { type: "go_live", medium: "push", channel: "alpha", enabled: true },
      { type: "go_live", medium: "push", channel: "alpha", enabled: null },
    ]);
    const saved = t("w5Watch.alerts.saved", { medium: "email", channel: "alpha", choice: "off" });
    expect(saved).toBe("Email from alpha: off.");
    expect(fake.toasts.some((m) => m.startsWith("ok:") && m.includes('data-testid="following-alert-saved"'))).toBe(
      true,
    );
    expect(fake.toasts.some((m) => m.includes(saved))).toBe(true);
    expect(t("w5Watch.alerts.saved", { medium: "push", channel: "alpha", choice: "default" })).toBe(
      "Push from alpha: your default.",
    );
  });

  it("a failed choice rolls back and says which channel", async () => {
    fake.follows = async () => ({ items: [row("alpha")], nextCursor: null });
    fake.prefsSet = async () => {
      throw new Error("down");
    };
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    await screen.findByTestId("following-row");
    const popover = await openOptions("alpha");
    await waitFor(() => expect(within(popover).getByTestId("notify-channel-email")).toBeTruthy());
    await pick("notify-channel-email", "notify-channel-email-on");
    await waitFor(() => expect(screen.getByTestId("notify-channel-email").getAttribute("data-value")).toBe("default"));
    // Static markup escapes the apostrophe, so compare the escaped message.
    const message = t("d3Home.followingPage.alertFailed", { channel: "alpha" }).replaceAll("'", "&#x27;");
    expect(
      fake.toasts.some(
        (m) => m.startsWith("err:") && m.includes('data-testid="following-alert-error"') && m.includes(message),
      ),
    ).toBe(true);
  });

  it("a failed load offers Retry inside the options, which asks again", async () => {
    fake.follows = async () => ({ items: [row("alpha")], nextCursor: null });
    let fail = true;
    fake.prefsGet = async (input) => {
      gets.push(input);
      if (fail) throw new Error("down");
      return prefs();
    };
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    await screen.findByTestId("following-row");
    const popover = await openOptions("alpha");
    const error = await within(popover).findByTestId("following-alert-load-error");
    expect(error.textContent).toContain(t("w5Watch.alerts.loadFailed"));
    fail = false;
    await act(async () => fireEvent.click(within(error).getByTestId("following-alert-retry")));
    await waitFor(() => expect(within(popover).getByTestId("notify-channel-email")).toBeTruthy());
    expect(gets).toHaveLength(2);
  });

  it("an offline row keeps its bell on the name line", async () => {
    primeHomeFeed(home({ following: [], followingOffline: [offline("old", "2026-10-01T00:00:00.000Z")] }), MEMBER.id);
    fake.follows = async () => ({ items: [row("old")], nextCursor: null });
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    const r = await screen.findByTestId("following-row");
    expect(within(r).getByTestId("notify-channel").getAttribute("data-slug")).toBe("old");
    expect(within(r).getByTestId("notify-channel-bell").getAttribute("aria-pressed")).toBe("true");
  });
});
