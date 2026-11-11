// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-settings (F36, F37; D7.4 for the page order): `/settings/privacy` runs download, who can see
 * you, then the danger zone, and "Tell me if
 * they move" lives on notifications; the two long follow lists search, page with "Load more", and
 * the move notices turn all on or all off. The privacy page and `PortabilityGrants` run against a
 * stand-in API module (the real one needs a server); `GrantsView` and `NotificationSettings` take
 * their data as props or a client.
 */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NotificationSettings } from "../src/components/notifications/settings.tsx";
import {
  GrantsView,
  PortabilityGrants,
  grantRows,
  withMoreFollows,
  type GrantRow,
} from "../src/components/portability/grants.tsx";
import { GRANTS_SET_MANY_MAX, chunked, withGrantStates } from "../src/components/portability/lib.ts";
import { LIST_PAGE_SIZE, foldForSearch, matchesQuery, windowRows } from "../src/components/settings/list-window.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { FollowDto, FollowPage, NotificationPreferencesDto, SettingsClient } from "../src/lib/notifications.ts";
import { Route as PrivacyRoute } from "../src/routes/_app/settings.privacy.tsx";

configure({ asyncUtilTimeout: 5_000 });

const fake = vi.hoisted(() => ({
  follows: [] as { items: unknown[]; nextCursor: string | null }[],
  grants: [] as unknown[],
  set: [] as { channel: string; enabled: boolean }[],
  setMany: [] as { channels: string[]; enabled: boolean }[],
  failSet: new Set<string>(),
  failSetMany: false,
  /** Holds every setMany call until released, to see the optimistic state. */
  holdSetMany: null as Promise<void> | null,
}));

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({
    me: { id: "u1", username: "viewer1", displayName: "Viewer One", channelSlug: null, role: "user" },
    config: { publicUrl: "https://air.example.test", features: {} },
    now: Date.now(),
  }),
}));

vi.mock("../src/lib/api.ts", () => {
  const api = () => ({
    me: {
      deletion: { get: async () => null },
      exports: { list: async () => [] },
      blocks: { list: async () => ({ items: [], nextCursor: null }) },
      follows: async ({ cursor }: { cursor?: string }) => {
        const index = cursor ? Number(cursor) : 0;
        return fake.follows[index] ?? { items: [], nextCursor: null };
      },
    },
    portability: {
      grants: {
        mine: async () => fake.grants,
        set: async (input: { channel: string; enabled: boolean }) => {
          if (fake.failSet.has(input.channel)) throw new Error("down");
          fake.set.push(input);
          return { enabled: input.enabled };
        },
        setMany: async (input: { channels: string[]; enabled: boolean }) => {
          fake.setMany.push(input);
          if (fake.holdSetMany) await fake.holdSetMany;
          if (fake.failSetMany) throw new Error("down");
          return { enabled: input.enabled, updated: input.channels.length };
        },
      },
    },
  });
  return { api, errorCode: () => null, isApiError: () => false };
});

afterEach(() => {
  cleanup();
  fake.follows = [];
  fake.grants = [];
  fake.set = [];
  fake.setMany = [];
  fake.failSet = new Set();
  fake.failSetMany = false;
  fake.holdSetMany = null;
});

const WEB = join(import.meta.dirname, "..");

function wrap(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{node}</> });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <NowProvider now={Date.parse("2026-11-04T12:00:00.000Z")}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </NowProvider>
    </LocaleProvider>,
  );
}

const channel = (i: number, name = `Channel ${String(i).padStart(3, "0")}`) => ({
  slug: `ch${String(i).padStart(3, "0")}`,
  displayName: name,
  avatarUrl: null,
});
const rowsOf = (n: number): GrantRow[] =>
  grantRows(
    Array.from({ length: n }, (_, i) => channel(i)),
    [],
  );
const shown = () => screen.queryAllByTestId("portability-grant").map((r) => r.dataset.channel);

// ── F37: the privacy page ─────────────────────────────────────────────────────────────────────

describe("privacy page (F37)", () => {
  it("D7.4: download, who can see you, then the danger zone; P2P moved to Preferences", async () => {
    const Page = PrivacyRoute.options.component as React.ComponentType;
    wrap(<Page />);
    const danger = await screen.findByTestId("privacy-delete");
    expect(within(danger).getByRole("heading", { level: 2 }).textContent).toBe(t("d7Settings.delete.title"));
    expect(await within(danger).findByTestId("deletion-request")).toBeTruthy();
    const page = screen.getByTestId("privacy-page");
    const sections = [...page.children].map((el) => el.getAttribute("data-testid") ?? el.tagName.toLowerCase());
    expect(sections).toEqual(["header", "privacy-download", "blocked-users", "privacy-delete"]);
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe(t("d7Settings.nav.privacy"));
    expect(screen.queryByTestId("privacy-p2p-toggle")).toBeNull();
    // The move notices left the page.
    expect(screen.queryByTestId("portability-grants")).toBeNull();
  });

  it("the move notices are on notifications now", () => {
    const privacy = readFileSync(join(WEB, "src/routes/_app/settings.privacy.tsx"), "utf8");
    const notifications = readFileSync(join(WEB, "src/routes/_app/settings.notifications.index.tsx"), "utf8");
    expect(privacy).not.toContain("PortabilityGrants");
    expect(notifications).toContain("<PortabilityGrants />");
  });
});

// ── F36: search and paging ────────────────────────────────────────────────────────────────────

describe("list search", () => {
  it("folds case and accents", () => {
    expect(foldForSearch("  ÁdA Lóvelace ")).toBe("ada lovelace");
    expect(matchesQuery("ada", ["Ádá"])).toBe(true);
    expect(matchesQuery("", ["anything"])).toBe(true);
    expect(matchesQuery("   ", ["anything"])).toBe(true);
    expect(matchesQuery("zed", ["Ada", "ada_slug"])).toBe(false);
    expect(matchesQuery("slug", ["Ada", "ada_slug"])).toBe(true);
  });

  it("windows the matches", () => {
    const rows = Array.from({ length: 50 }, (_, i) => i);
    const fields = (n: number) => [String(n)];
    expect(windowRows(rows, "", fields, 20).shown).toHaveLength(20);
    expect(windowRows(rows, "", fields, 20).matched).toHaveLength(50);
    expect(windowRows(rows, "4", fields, 3)).toEqual({
      matched: [4, 14, 24, 34, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49],
      shown: [4, 14, 24],
    });
    expect(windowRows([], "x", fields, 20)).toEqual({ matched: [], shown: [] });
  });
});

describe("GrantsView (F36)", () => {
  const view = (props: Partial<React.ComponentProps<typeof GrantsView>> = {}) => {
    const onSetAll = vi.fn<NonNullable<React.ComponentProps<typeof GrantsView>["onSetAll"]>>();
    const onServerMore = vi.fn<() => void>();
    wrap(
      <GrantsView
        rows={rowsOf(45)}
        loadFailed={false}
        busy={new Set()}
        onToggle={vi.fn<(slug: string, on: boolean) => void>()}
        onSetAll={onSetAll}
        onServerMore={onServerMore}
        {...props}
      />,
    );
    return { onSetAll, onServerMore };
  };

  it("shows a page, then Load more adds a page until the list ends", async () => {
    view();
    await screen.findByTestId("portability-grants-search");
    expect(shown()).toHaveLength(LIST_PAGE_SIZE);
    fireEvent.click(screen.getByTestId("portability-grants-more"));
    expect(shown()).toHaveLength(40);
    fireEvent.click(screen.getByTestId("portability-grants-more"));
    expect(shown()).toHaveLength(45);
    expect(screen.queryByTestId("portability-grants-more")).toBeNull();
  });

  it("asks the server once the loaded rows run out", async () => {
    const { onServerMore } = view({ rows: rowsOf(25), serverHasMore: true });
    await screen.findByTestId("portability-grants-search");
    fireEvent.click(screen.getByTestId("portability-grants-more"));
    expect(onServerMore).toHaveBeenCalledTimes(1);
    expect(shown()).toHaveLength(25);
    // Still more on the server: the button stays.
    expect(screen.getByTestId("portability-grants-more")).toBeTruthy();
  });

  it("searches by name or handle, starts at the first page again, and says when nothing matches", async () => {
    view({ rows: [...rowsOf(30), { slug: "ada_l", displayName: "Ádá Lovelace", avatarUrl: null, on: false }] });
    fireEvent.click(await screen.findByTestId("portability-grants-more"));
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "ada" } });
    expect(shown()).toEqual(["ada_l"]);
    expect(screen.queryByTestId("portability-grants-more")).toBeNull();
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "ch01" } });
    expect(shown()).toHaveLength(10);
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "nobody" } });
    expect(screen.getByTestId("settings-list-no-match").textContent).toContain("nobody");
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "" } });
    expect(shown()).toHaveLength(LIST_PAGE_SIZE);
  });

  it("says a search covers only the loaded channels while more are on the server", async () => {
    view({ rows: rowsOf(25), serverHasMore: true });
    fireEvent.change(await screen.findByTestId("portability-grants-search"), { target: { value: "ch" } });
    expect(screen.getByText(t("settings.list.searchLoaded", { count: 25 }))).toBeTruthy();
  });

  it("all on / all off: every channel without a search, the matches with one", async () => {
    const { onSetAll } = view({ rows: rowsOf(30) });
    fireEvent.click(await screen.findByTestId("portability-grants-all-on"));
    expect(onSetAll).toHaveBeenLastCalledWith(true, expect.objectContaining({ everything: true }));
    expect(screen.getByText(t("settings.grants.allScopeEvery"))).toBeTruthy();
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "ch02" } });
    fireEvent.click(screen.getByTestId("portability-grants-all-off"));
    expect(onSetAll).toHaveBeenLastCalledWith(false, {
      everything: false,
      slugs: Array.from({ length: 10 }, (_, i) => `ch0${20 + i}`),
    });
    expect(screen.getByText(t("settings.grants.allScopeSearch", { count: 10 }))).toBeTruthy();
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "nobody" } });
    expect((screen.getByTestId("portability-grants-all-on") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables every switch and both buttons while a bulk change runs", async () => {
    view({ rows: rowsOf(3), bulkBusy: true });
    await screen.findByTestId("portability-grants-search");
    expect((screen.getByTestId("portability-grants-all-on") as HTMLButtonElement).disabled).toBe(true);
    for (const s of screen.getAllByTestId("portability-grant-toggle"))
      expect(s.getAttribute("data-disabled")).not.toBeNull();
  });
});

describe("PortabilityGrants bulk (F36)", () => {
  const followPage = (from: number, to: number, next: string | null) => ({
    items: Array.from({ length: to - from }, (_, i) => ({ channel: channel(from + i) })),
    nextCursor: next,
  });

  const state = (slug: string) =>
    screen.getAllByTestId("portability-grant").find((r) => r.dataset.channel === slug)?.dataset.state;

  it("all on loads the unloaded follows first, then turns on every channel that is off in one call", async () => {
    fake.follows = [followPage(0, 30, "1"), followPage(30, 45, null)];
    fake.grants = [{ channel: channel(3) }];
    wrap(<PortabilityGrants />);
    await screen.findByTestId("portability-grants-all-on");
    await act(async () => {
      fireEvent.click(screen.getByTestId("portability-grants-all-on"));
    });
    await waitFor(() => expect(fake.setMany).toHaveLength(1));
    expect(fake.set).toEqual([]);
    expect(fake.setMany[0]?.enabled).toBe(true);
    expect(fake.setMany[0]?.channels).toHaveLength(44);
    expect(fake.setMany[0]?.channels).not.toContain("ch003");
    await waitFor(() =>
      expect(screen.getAllByTestId("portability-grant").every((r) => r.dataset.state === "on")).toBe(true),
    );
    // Everything is loaded now: no Load more beyond the local pages.
    fireEvent.click(screen.getByTestId("portability-grants-more"));
    fireEvent.click(screen.getByTestId("portability-grants-more"));
    expect(shown()).toHaveLength(45);
    expect(screen.queryByTestId("portability-grants-more")).toBeNull();
  });

  it("all off within a search touches only the matches that are on", async () => {
    fake.follows = [followPage(0, 12, null)];
    fake.grants = [{ channel: channel(1) }, { channel: channel(10) }, { channel: channel(11) }];
    wrap(<PortabilityGrants />);
    fireEvent.change(await screen.findByTestId("portability-grants-search"), { target: { value: "ch01" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("portability-grants-all-off"));
    });
    await waitFor(() => expect(fake.setMany).toEqual([{ channels: ["ch010", "ch011"], enabled: false }]));
    // ch001 is on but outside the search: untouched.
    await waitFor(() => expect(screen.getByTestId("portability-grants-all-off").getAttribute("aria-busy")).toBeNull());
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "" } });
    expect(state("ch001")).toBe("on");
    expect(state("ch010")).toBe("off");
    expect(state("ch011")).toBe("off");
  });

  it("flips the switches before the server answers, and flips them back when it refuses", async () => {
    fake.follows = [followPage(0, 3, null)];
    fake.grants = [{ channel: channel(0) }];
    let release = () => {};
    fake.holdSetMany = new Promise<void>((r) => {
      release = r;
    });
    fake.failSetMany = true;
    wrap(<PortabilityGrants />);
    await screen.findByTestId("portability-grants-all-on");
    await act(async () => {
      fireEvent.click(screen.getByTestId("portability-grants-all-on"));
    });
    // Optimistic: on while the call is in flight.
    await waitFor(() => expect(state("ch001")).toBe("on"));
    expect(state("ch002")).toBe("on");
    expect(fake.setMany).toEqual([{ channels: ["ch001", "ch002"], enabled: true }]);
    await act(async () => {
      release();
    });
    // Refused: back off, and the channel that was already on stays on.
    await waitFor(() => expect(state("ch001")).toBe("off"));
    expect(state("ch002")).toBe("off");
    expect(state("ch000")).toBe("on");
    await waitFor(() => expect(screen.getByTestId("portability-grants-all-on").getAttribute("aria-busy")).toBeNull());
  });
});

describe("grant helpers and withMoreFollows", () => {
  it("chunks into runs of at most the batch size, in order", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 3)).toEqual([]);
    expect(chunked([1, 2], 2)).toEqual([[1, 2]]);
    const big = Array.from({ length: GRANTS_SET_MANY_MAX + 1 }, (_, i) => i);
    expect(chunked(big, GRANTS_SET_MANY_MAX).map((c) => c.length)).toEqual([GRANTS_SET_MANY_MAX, 1]);
  });

  it("switches only the listed channels, keeping the same object when nothing changes", () => {
    const rows: GrantRow[] = [
      { ...channel(1), on: false },
      { ...channel(2), on: true },
      { ...channel(3), on: false },
    ];
    const next = withGrantStates(rows, new Set(["ch001", "ch002"]), true);
    expect(next.map((r) => r.on)).toEqual([true, true, false]);
    expect(next[1]).toBe(rows[1]);
    expect(next[2]).toBe(rows[2]);
    expect(withGrantStates(rows, new Set(), true)).toEqual(rows);
  });

  it("adds only new channels, keeps current switch states, and sorts by name", () => {
    const rows: GrantRow[] = [{ ...channel(2, "Bea"), on: true }];
    const merged = withMoreFollows(rows, [channel(2, "Bea"), channel(1, "Ada"), channel(3, "Cy")], [channel(3, "Cy")]);
    expect(merged.map((r) => [r.displayName, r.on])).toEqual([
      ["Ada", false],
      ["Bea", true],
      ["Cy", true],
    ]);
  });
});

// ── F36 + F39: channels you follow on notifications ───────────────────────────────────────────

describe("Channels you follow (F36, F39)", () => {
  const prefs: NotificationPreferencesDto = {
    type: "go_live",
    defaults: { in_app: true, email: false, push: false },
    builtIn: { in_app: true, email: true, push: true },
    channels: [],
    emailVerified: true,
  } as NotificationPreferencesDto;
  const follow = (i: number, name?: string): FollowDto =>
    ({
      channel: {
        id: `0192f000-0000-7000-8000-${String(i).padStart(12, "0")}`,
        slug: `ch${String(i).padStart(3, "0")}`,
        displayName: name ?? `Channel ${String(i).padStart(3, "0")}`,
        avatarUrl: null,
        accent: "zinc",
      },
      live: null,
      followedAt: "2026-10-01T00:00:00.000Z",
      notify: true,
    }) as FollowDto;
  const client = (pages: FollowPage[]): SettingsClient => ({
    preferences: async () => prefs,
    setPreference: async () => prefs,
    follows: async (cursor) => pages[cursor ? Number(cursor) : 0] ?? { items: [], nextCursor: null },
    setBell: async () => {},
  });
  const rows = () => screen.queryAllByTestId("notify-channel");

  it("pages the list, loads the server's next page, and searches", async () => {
    const first = { items: Array.from({ length: 25 }, (_, i) => follow(i)), nextCursor: "1" };
    const second = { items: [follow(25, "Ádá Lovelace")], nextCursor: null };
    wrap(<NotificationSettings client={client([first, second])} />);
    await waitFor(() => expect(rows()).toHaveLength(LIST_PAGE_SIZE));
    fireEvent.click(screen.getByTestId("notify-channels-more"));
    await waitFor(() => expect(rows()).toHaveLength(26));
    expect(screen.queryByTestId("notify-channels-more")).toBeNull();
    fireEvent.change(screen.getByTestId("notify-channels-search"), { target: { value: "ada" } });
    expect(rows().map((r) => r.dataset.slug)).toEqual(["ch025"]);
  });

  it("the bell switch has a visible label on the name line, and its accessible name starts with it", async () => {
    wrap(<NotificationSettings client={client([{ items: [follow(1, "Ada")], nextCursor: null }])} />);
    const row = await screen.findByTestId("notify-channel");
    const bell = within(row).getByTestId("notify-channel-bell");
    const nameLine = bell.closest("div")?.parentElement;
    expect(nameLine?.textContent).toContain("Ada");
    expect(nameLine?.textContent).toContain(t("settings.notifications.bell"));
    const label = within(row).getByText(t("settings.notifications.bell"));
    expect(label.className).not.toContain("sr-only");
    expect(bell.getAttribute("aria-label")).toBeNull();
    // WCAG 2.5.3 Label in Name: voice control can say the visible text; the channel follows it.
    const name = (bell.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(name).toBe(`${t("settings.notifications.bell")} Ada`);
    expect(screen.getByRole("switch", { name: `${t("settings.notifications.bell")} Ada` })).toBe(bell);
  });
});
