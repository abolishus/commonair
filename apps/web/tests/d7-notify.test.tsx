// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 4, D7.3 (d7-notify): the notifications grid, the `/inbox` page, the inbox rows
 * (display names, glyphs, context lines, report outcomes, the mod view link) and `?src=digest`.
 */
import { NOTIFICATION_TYPES, PREFERENCE_MEDIA, PREFERENCE_TYPES } from "@commonair/contracts/enums";
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({ tracked: [] as string[], toasts: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => fake.tracked.push(`${surface}|${action}|${step}`),
}));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: () => fake.toasts.push("success"),
    error: () => fake.toasts.push("error"),
  },
}));
vi.mock("../src/components/pwa/push-toggle.tsx", () => ({
  PushToggle: () => <div data-testid="push-toggle" />,
}));

import { consumeEmailSource } from "../src/components/notifications/email-source.tsx";
import { InboxPage } from "../src/components/notifications/inbox-page.tsx";
import { NotificationInbox } from "../src/components/notifications/inbox.tsx";
import { NotificationItem } from "../src/components/notifications/item.tsx";
import { NotificationSettings } from "../src/components/notifications/settings.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import {
  INBOX_FILTERS,
  INBOX_FILTER_TYPES,
  LOCKED_CELLS,
  PREFERENCE_CELL_TEST_IDS,
  describeNotification,
  emailSourceOf,
  groupInbox,
  inboxGroup,
  targetPath,
  type InboxClient,
  type NotificationDto,
  type NotificationPage,
  type NotificationPreferencesDto,
  type PreferenceTypesClient,
  type SettingsClient,
} from "../src/lib/notifications.ts";

beforeEach(() => {
  fake.tracked.length = 0;
  fake.toasts.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const NOW = Date.parse("2026-11-11T12:00:00.000Z");

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <NowProvider now={NOW}>
          <TooltipProvider>{node}</TooltipProvider>
        </NowProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allById = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

const CH = "0192f000-0000-7000-8000-0000000000c1";
const P1 = "0192f000-0000-7000-8000-0000000000a1";

const prefs = (type: string, over: Partial<NotificationPreferencesDto> = {}): NotificationPreferencesDto => ({
  type: type as NotificationPreferencesDto["type"],
  defaults: { in_app: true, email: false, push: false },
  builtIn: { in_app: true, email: true, push: true },
  channels: [],
  emailVerified: true,
  ...over,
});

const settingsClient = (goLive = prefs("go_live")): SettingsClient => ({
  preferences: async () => goLive,
  setPreference: async () => goLive,
  follows: async () => ({ items: [], nextCursor: null }),
  setBell: async () => {},
});

function typesClient(fail = false) {
  const state: Record<string, NotificationPreferencesDto> = {
    governance: prefs("governance"),
    payout: prefs("payout", { defaults: { in_app: true, email: true, push: false } }),
    creator: prefs("creator"),
    digest_weekly: prefs("digest_weekly", { defaults: { in_app: false, email: false, push: false } }),
  };
  const set = vi.fn<PreferenceTypesClient["set"]>(async (type, medium, enabled) => {
    if (fail) throw new Error("boom");
    const p = state[type] ?? prefs(type);
    state[type] = { ...p, defaults: { ...p.defaults, [medium]: enabled }, builtIn: { ...p.builtIn, [medium]: false } };
    return state[type];
  });
  const client: PreferenceTypesClient = {
    get: async (type) => state[type] ?? prefs(type),
    set,
  };
  return { client, set };
}

describe("the grid model", () => {
  it("every offered cell has a test id, nothing else does, and locked cells are offered cells", () => {
    for (const type of PREFERENCE_TYPES) {
      const ids = PREFERENCE_CELL_TEST_IDS[type];
      const locked = Object.keys(LOCKED_CELLS[type] ?? {});
      expect(Object.keys(ids).sort()).toEqual(PREFERENCE_MEDIA[type].filter((m) => !locked.includes(m)).sort());
      for (const m of locked) expect(PREFERENCE_MEDIA[type]).toContain(m);
    }
  });
});

describe("NotificationSettings: the grid", () => {
  it("one row per type, '–' where a medium is not offered, locked rows, and the digest unticked", async () => {
    const { client } = typesClient();
    wrap(<NotificationSettings client={settingsClient()} typesClient={client} />);
    await waitFor(() => expect(byId("notify-pref-digest_weekly-email")).not.toBeNull());
    expect(allById("notify-grid-row").map((r) => r.dataset.type)).toEqual([...PREFERENCE_TYPES]);
    const digest = allById("notify-grid-row").find((r) => r.dataset.type === "digest_weekly");
    if (!digest) throw new Error("no digest row");
    expect(within(digest).getAllByTestId("notify-cell-none")).toHaveLength(2);
    expect(byId("notify-pref-digest_weekly-email")?.getAttribute("data-state")).toBe("off");
    // Governance is in-app only; payout in-app is locked, its email offered.
    const governance = allById("notify-grid-row").find((r) => r.dataset.type === "governance");
    expect(governance && within(governance).getAllByTestId("notify-cell-none")).toHaveLength(2);
    const payout = allById("notify-grid-row").find((r) => r.dataset.type === "payout");
    expect(payout && within(payout).getAllByTestId("notify-cell-always")).toHaveLength(1);
    expect(byId("notify-pref-payout-email")?.getAttribute("data-state")).toBe("on");
    // The always rows, each with a reason.
    expect(allById("notify-always-row").map((r) => r.dataset.row)).toEqual([
      "moderation",
      "system",
      "export",
      "membership",
      "reports",
      "moderator",
    ]);
    const moderation = allById("notify-always-row").find((r) => r.dataset.row === "moderation");
    const always = moderation && within(moderation).getAllByTestId("notify-cell-always")[0];
    expect(always?.getAttribute("aria-label")).toContain(en["d7Notify.always.moderation.why"]);
    // Per-channel choices link the Following page.
    expect(byId("notify-following-link")?.getAttribute("href")).toBe("/following");
    expect(fake.tracked).toContain("settings.notifications|view|none");
  });

  it("a type's switch saves at once with a toast, and the digest opt-in counts as `weekly`", async () => {
    const { client, set } = typesClient();
    wrap(<NotificationSettings client={settingsClient()} typesClient={client} />);
    await waitFor(() => expect(byId("notify-pref-digest_weekly-email")).not.toBeNull());
    fireEvent.click(byId("notify-pref-digest_weekly-email") as HTMLElement);
    await waitFor(() => expect(set).toHaveBeenCalledWith("digest_weekly", "email", true));
    await waitFor(() => expect(byId("notify-pref-digest_weekly-email")?.getAttribute("data-state")).toBe("on"));
    expect(byId("notify-pref-digest_weekly-email")?.getAttribute("data-builtin")).toBe("false");
    expect(fake.toasts).toContain("success");
    expect(fake.tracked).toContain("settings.notifications|submit|weekly");
    fireEvent.click(byId("notify-pref-creator-email") as HTMLElement);
    await waitFor(() => expect(set).toHaveBeenCalledWith("creator", "email", true));
    expect(fake.tracked).toContain("settings.notifications|submit|email");
  });

  it("a failed save rolls the cell back and says so", async () => {
    const { client } = typesClient(true);
    wrap(<NotificationSettings client={settingsClient()} typesClient={client} />);
    await waitFor(() => expect(byId("notify-pref-governance-in_app")).not.toBeNull());
    fireEvent.click(byId("notify-pref-governance-in_app") as HTMLElement);
    await waitFor(() => expect(fake.toasts).toContain("error"));
    expect(byId("notify-pref-governance-in_app")?.getAttribute("data-state")).toBe("on");
  });

  it("the other types failing to load keep the go-live row and offer Retry", async () => {
    const client: PreferenceTypesClient = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => prefs("governance"),
    };
    wrap(<NotificationSettings client={settingsClient()} typesClient={client} />);
    await waitFor(() => expect(byId("notify-types-load-error")).not.toBeNull());
    expect(byId("notify-default-email")).not.toBeNull();
  });

  it("an unverified address: the notice, and email switches point at it", async () => {
    const { client } = typesClient();
    wrap(
      <NotificationSettings client={settingsClient(prefs("go_live", { emailVerified: false }))} typesClient={client} />,
    );
    await waitFor(() => expect(byId("notify-pref-creator-email")).not.toBeNull());
    const notice = byId("notify-email-unverified");
    const describedBy = byId("notify-pref-creator-email")?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(notice?.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(en["notifySettings.emailUnverified"]);
    expect(byId("notify-pref-governance-in_app")?.getAttribute("aria-describedby")).toBeNull();
  });
});

// ------------------------------------------------------------------ items

const item = (type: NotificationDto["type"], payload: Record<string, unknown>, over: Partial<NotificationDto> = {}) =>
  ({ id: P1, type, payload, readAt: null, createdAt: "2026-11-11T11:00:00.000Z", ...over }) as NotificationDto;

describe("inbox rows", () => {
  it("go-live rows use the joined display name and avatar; without them, the slug", () => {
    const joined = describeNotification(
      item("go_live", {
        channelId: CH,
        slug: "rivertide",
        broadcastId: CH,
        title: "Night run",
        displayName: "River Tide",
        avatarUrl: "https://media.example.test/a.png",
      }),
    );
    expect(joined).toMatchObject({
      kind: "go_live",
      name: "River Tide",
      avatarUrl: "https://media.example.test/a.png",
    });
    const bare = describeNotification(
      item("go_live", { channelId: CH, slug: "rivertide", broadcastId: CH, title: "" }),
    );
    expect(bare).toMatchObject({ name: "rivertide", avatarUrl: null });
    const hostile = describeNotification(
      item("go_live", { channelId: CH, slug: "rivertide", broadcastId: CH, title: "", avatarUrl: "javascript:x" }),
    );
    expect(hostile).toMatchObject({ avatarUrl: null });
  });

  it("context lines: the proposal and video titles, a payout amount", () => {
    expect(describeNotification(item("vote_open", { proposalId: P1, title: "Lower the cut" }))).toMatchObject({
      context: { kind: "text", text: "Lower the cut" },
    });
    expect(
      describeNotification(item("vod_ready", { vodId: P1, broadcastId: P1, slug: "rivertide", title: "Night run" })),
    ).toMatchObject({ context: { kind: "text", text: "Night run" } });
    expect(describeNotification(item("payout", { amountCents: 2500, currency: "usd" }))).toMatchObject({
      context: { kind: "money", cents: 2500, currency: "usd" },
    });
    expect(describeNotification(item("payout", { amountCents: 2.5, currency: "usd" }))).toMatchObject({
      context: null,
    });
  });

  it("report outcomes say what was decided; a new moderator links the mod view", () => {
    expect(describeNotification(item("report_outcome", { outcome: "action_taken" }))).toMatchObject({
      label: "d7Notify.item.reportActionTaken",
      target: null,
    });
    expect(describeNotification(item("report_outcome", { outcome: "no_action" }))).toMatchObject({
      label: "d7Notify.item.reportNoAction",
    });
    const mod = describeNotification(item("moderator_added", { channelId: CH, slug: "rivertide", role: "moderator" }));
    expect(mod).toMatchObject({
      label: "notifications.type.moderator_added",
      target: { kind: "mod", slug: "rivertide" },
    });
    if (mod.kind !== "generic" || !mod.target) throw new Error("no target");
    expect(targetPath(mod.target)).toBe("/mod/rivertide");
    expect(describeNotification(item("moderator_added", { slug: "rivertide", role: "editor" }))).toMatchObject({
      label: "d7Notify.item.editorAdded",
    });
  });

  it("renders the display name, a glyph per type, the context line and the mod link", () => {
    wrap(
      <ul>
        <NotificationItem
          notification={item("go_live", {
            channelId: CH,
            slug: "rivertide",
            broadcastId: CH,
            title: "Night run",
            displayName: "River Tide",
          })}
          onOpen={() => {}}
        />
        <NotificationItem
          notification={item("payout", { amountCents: 2500, currency: "usd" }, { id: `${P1.slice(0, -1)}2` })}
          onOpen={() => {}}
        />
        <NotificationItem
          notification={item(
            "moderator_added",
            { slug: "rivertide", role: "moderator" },
            { id: `${P1.slice(0, -1)}3` },
          )}
          onOpen={() => {}}
        />
      </ul>,
    );
    expect(screen.getByText("River Tide went live")).toBeTruthy();
    expect(allById("notification-item-icon")).toHaveLength(2);
    expect(allById("notification-item-context").map((e) => e.textContent)).toEqual(["$25.00", "rivertide"]);
    expect(allById("notification-item-link").map((a) => a.getAttribute("href"))).toEqual([
      "/rivertide",
      "/mod/rivertide",
    ]);
  });
});

// ------------------------------------------------------------------ the inbox page

describe("inbox filters and groups", () => {
  it("each type is under exactly one chip besides All", () => {
    const named = INBOX_FILTERS.filter((f) => f !== "all").flatMap((f) => INBOX_FILTER_TYPES[f] ?? []);
    expect(named.toSorted()).toEqual([...NOTIFICATION_TYPES].sort());
    expect(INBOX_FILTER_TYPES.all).toBeNull();
  });

  it("today, this week, earlier by the local day", () => {
    const now = new Date(2026, 10, 11, 12);
    expect(inboxGroup(new Date(2026, 10, 11, 0, 1).toISOString(), now)).toBe("today");
    expect(inboxGroup(new Date(2026, 10, 10, 23).toISOString(), now)).toBe("week");
    expect(inboxGroup(new Date(2026, 10, 5, 1).toISOString(), now)).toBe("week");
    expect(inboxGroup(new Date(2026, 10, 4, 23).toISOString(), now)).toBe("earlier");
    const items = [
      item("system", {}, { id: "a", createdAt: new Date(2026, 10, 11, 9).toISOString() }),
      item("system", {}, { id: "b", createdAt: new Date(2026, 10, 9, 9).toISOString() }),
      item("system", {}, { id: "c", createdAt: new Date(2026, 9, 1).toISOString() }),
    ];
    expect(groupInbox(items, now).map((g) => [g.group, g.items.map((n) => n.id)])).toEqual([
      ["today", ["a"]],
      ["week", ["b"]],
      ["earlier", ["c"]],
    ]);
  });
});

function inboxFixture(pages: Record<string, NotificationPage>) {
  const list = vi.fn<InboxClient["list"]>(
    async (cursor, types) => pages[`${cursor ?? ""}|${types?.join(",") ?? ""}`] ?? { items: [], nextCursor: null },
  );
  const markRead = vi.fn<InboxClient["markRead"]>(async () => {});
  const client: InboxClient = { unreadCount: async () => ({ count: 0, capped: false }), list, markRead };
  return { client, list, markRead };
}

describe("InboxPage", () => {
  const now = () => new Date(NOW);
  const today = item("system", {}, { id: "t1", createdAt: new Date(NOW - 60_000).toISOString() });
  const old = item(
    "export_ready",
    {},
    { id: "o1", createdAt: "2026-10-01T00:00:00.000Z", readAt: "2026-10-02T00:00:00.000Z" },
  );

  it("groups the newest page, pages on, marks all read, and counts its view", async () => {
    const more = item("raid", {}, { id: "m1", createdAt: "2026-09-01T00:00:00.000Z" });
    const { client, list, markRead } = inboxFixture({
      "|": { items: [today, old], nextCursor: "c1" },
      "c1|": { items: [more], nextCursor: null },
    });
    wrap(<InboxPage client={client} now={now} />);
    await waitFor(() => expect(allById("inbox-group")).toHaveLength(2));
    expect(allById("inbox-group").map((g) => g.dataset.group)).toEqual(["today", "earlier"]);
    fireEvent.click(byId("inbox-load-more") as HTMLElement);
    await waitFor(() => expect(allById("notification-item")).toHaveLength(3));
    expect(list).toHaveBeenLastCalledWith("c1", undefined);
    fireEvent.click(byId("inbox-mark-all-read") as HTMLElement);
    await waitFor(() => expect(markRead).toHaveBeenCalledWith());
    await waitFor(() => expect(allById("notification-item").every((n) => n.dataset.state === "read")).toBe(true));
    expect(fake.tracked).toContain("inbox|view|none");
  });

  it("a chip asks for its types; an empty chip offers Show all", async () => {
    const { client, list } = inboxFixture({ "|": { items: [today], nextCursor: null } });
    wrap(<InboxPage client={client} now={now} />);
    await waitFor(() => expect(allById("notification-item")).toHaveLength(1));
    fireEvent.click(byId("inbox-filter-coop") as HTMLElement);
    await waitFor(() => expect(byId("inbox-empty-filtered")).not.toBeNull());
    expect(list).toHaveBeenLastCalledWith(null, INBOX_FILTER_TYPES.coop);
    expect(fake.tracked).toContain("inbox|click|none");
    fireEvent.click(byId("inbox-show-all") as HTMLElement);
    await waitFor(() => expect(allById("notification-item")).toHaveLength(1));
  });

  it("nothing at all: the empty state links the directory", async () => {
    const { client } = inboxFixture({});
    wrap(<InboxPage client={client} now={now} />);
    await waitFor(() => expect(byId("inbox-empty")).not.toBeNull());
    expect(byId("inbox-empty-directory")?.getAttribute("href")).toBe("/directory");
  });
});

describe("the popover", () => {
  it("links the inbox page", async () => {
    const { client } = inboxFixture({});
    wrap(
      <NotificationInbox
        client={client}
        onReadOne={() => {}}
        onReadAll={() => {}}
        onRefreshCount={() => {}}
        onNavigate={() => {}}
      />,
    );
    await waitFor(() => expect(byId("notification-see-all")).not.toBeNull());
    expect(byId("notification-see-all")?.getAttribute("href")).toBe("/inbox");
  });
});

describe("?src=digest", () => {
  it("emailSourceOf finds our sources only and strips them", () => {
    expect(emailSourceOf("https://air.example.test/a/vods/1?src=digest&t=5")).toEqual({
      source: "digest",
      stripped: "https://air.example.test/a/vods/1?t=5",
    });
    expect(emailSourceOf("https://air.example.test/a?src=other")).toBeNull();
    expect(emailSourceOf("https://air.example.test/a")).toBeNull();
    expect(emailSourceOf("not a url")).toBeNull();
  });

  it("counts once and replaces the address", () => {
    const replaceState = vi.fn<History["replaceState"]>();
    const win = {
      location: { href: "https://air.example.test/coop/proposals/x?src=digest" },
      history: { state: null, replaceState },
    } as unknown as Pick<Window, "location" | "history">;
    expect(consumeEmailSource(win)).toBe(true);
    expect(fake.tracked).toEqual(["digest|click|none"]);
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://air.example.test/coop/proposals/x");
    const plain = {
      location: { href: "https://air.example.test/coop" },
      history: { state: null, replaceState },
    } as unknown as Pick<Window, "location" | "history">;
    expect(consumeEmailSource(plain)).toBe(false);
  });
});
