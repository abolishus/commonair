// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D7.1, the settings shell: the real layout inside a memory router with a stand-in page per nav
 * item. The grouped nav marks the route's item (nested paths included), the phone select changes
 * page, Appeals and Copyright carry their open counts, the scheduled-deletion banner sits above
 * every page with Cancel, bare /settings goes to Account, and a source policy holds every route
 * this unit owns to a PageHeader titled with the nav label plus SettingsSection blocks.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
} from "@tanstack/react-router";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openAppeals, openCopyright } from "../src/components/settings/nav-counts.ts";
import {
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  SETTINGS_PATHS,
  settingsGroupLabel,
  settingsTabFor,
  settingsTabLabel,
} from "../src/components/settings/settings-nav.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { Route as SettingsRoute } from "../src/routes/_app/settings.tsx";

configure({ asyncUtilTimeout: 5_000 });

const boot = vi.hoisted(() => ({ me: { id: "u1", username: "viewer1" } as null | { id: string; username: string } }));
const fake = vi.hoisted(() => ({
  appeals: [] as { status: string }[],
  dmca: [] as { status: string }[],
  deletion: null as null | { id: string; status: string; scheduledFor: string; retained: unknown[] },
  cancels: 0,
}));

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: boot.me, now: Date.now() }),
}));

vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: vi.fn<(...args: unknown[]) => void>() }));

vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    appeals: { mine: async () => fake.appeals },
    safety: { dmca: { mine: async () => fake.dmca } },
    me: {
      deletion: {
        get: async () => fake.deletion,
        cancel: async () => {
          fake.cancels++;
          return { ok: true };
        },
      },
    },
  }),
  errorCode: () => null,
  isApiError: () => false,
}));

afterEach(() => {
  cleanup();
  boot.me = { id: "u1", username: "viewer1" };
  fake.appeals = [];
  fake.dmca = [];
  fake.deletion = null;
  fake.cancels = 0;
});

const WEB = join(import.meta.dirname, "..");
const Layout = SettingsRoute.options.component as () => React.JSX.Element;
/** Items whose page sits under the settings layout (Following is `/following`). */
const UNDER_SETTINGS = SETTINGS_ITEMS.filter((id) => id !== "following");

async function mount(path: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: Layout });
  const pages = UNDER_SETTINGS.map((id) =>
    createRoute({
      getParentRoute: () => settings,
      path: SETTINGS_PATHS[id].slice("/settings/".length),
      component: () => <p data-testid="page">{id}</p>,
    }),
  );
  const unsubscribe = createRoute({
    getParentRoute: () => settings,
    path: "notifications/unsubscribe",
    component: () => <p data-testid="page">unsubscribe</p>,
  });
  const following = createRoute({
    getParentRoute: () => root,
    path: "/following",
    component: () => <p data-testid="page">following</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings.addChildren([...pages, unsubscribe]), following]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
  await screen.findByTestId("page");
  return router;
}

describe("settingsTabFor", () => {
  it.each(UNDER_SETTINGS.map((id) => [SETTINGS_PATHS[id], id] as const))("%s is %s", (path, id) => {
    expect(settingsTabFor(path)).toBe(id);
    expect(settingsTabFor(`${path}/`)).toBe(id);
    expect(settingsTabFor(`${path}?x=1`)).toBe(id);
  });

  it("matches nested paths by prefix, not by exact string", () => {
    expect(settingsTabFor("/settings/notifications/channels")).toBe("notifications");
    expect(settingsTabFor("/settings/copyright/abc")).toBe("copyright");
  });

  it("has no item for the unsubscribe page, look-alikes, bare /settings, or pages outside settings", () => {
    expect(settingsTabFor("/settings/notifications/unsubscribe")).toBeNull();
    expect(settingsTabFor("/settings/privacyx")).toBeNull();
    expect(settingsTabFor("/settings")).toBeNull();
    expect(settingsTabFor("/following")).toBeNull();
    expect(settingsTabFor("/coop/settings")).toBeNull();
    expect(settingsTabFor("/")).toBeNull();
  });

  it("groups the ten items as account-admin P1 agreed", () => {
    expect(SETTINGS_GROUPS.map((g) => [g.id, [...g.items]])).toEqual([
      ["account", ["account", "security", "preferences"]],
      ["activity", ["notifications", "following", "subscriptions"]],
      ["safety", ["privacy", "appeals", "copyright"]],
      ["apps", ["connections"]],
    ]);
    expect(SETTINGS_PATHS.following).toBe("/following");
    expect(SETTINGS_PATHS.security).toBe("/settings/security");
  });
});

describe("the settings layout", () => {
  it.each(UNDER_SETTINGS.map((id) => [id, SETTINGS_PATHS[id]] as const))(
    "marks %s on its own page",
    async (id, path) => {
      await mount(path);
      const nav = screen.getByTestId("settings-nav");
      expect(nav.dataset.current).toBe(id);
      for (const item of SETTINGS_ITEMS) {
        const link = screen.getByTestId(`settings-tab-${item}`);
        expect(link.tagName).toBe("A");
        expect(link.getAttribute("href")).toBe(SETTINGS_PATHS[item]);
        expect(link.getAttribute("aria-current")).toBe(item === id ? "page" : null);
        expect(link.textContent).toContain(settingsTabLabel(item));
      }
      expect(screen.getByTestId("settings-nav-select").dataset.value).toBe(id);
    },
  );

  it("shows the group labels in order, and the section nav only from lg (the select below)", async () => {
    await mount("/settings/account");
    const nav = screen.getByTestId("settings-nav");
    const text = nav.textContent ?? "";
    const at = SETTINGS_GROUPS.map((g) => text.indexOf(settingsGroupLabel(g.id)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const sideNav = screen.getByTestId("settings-tab-account").closest("nav")?.parentElement?.closest(".hidden");
    expect(sideNav?.className).toMatch(/\blg:block\b/);
    expect(screen.getByTestId("settings-nav-select").parentElement?.className).toMatch(/\blg:hidden\b/);
  });

  it("the phone select changes page", async () => {
    const router = await mount("/settings/privacy");
    fireEvent.click(screen.getByTestId("settings-nav-select"));
    const option = await screen.findByTestId("settings-nav-option-connections");
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/connections"));
    await waitFor(() => expect(screen.getByTestId("page").textContent).toBe("connections"));
  });

  it("the select leaves settings for Following", async () => {
    const router = await mount("/settings/account");
    fireEvent.click(screen.getByTestId("settings-nav-select"));
    const option = await screen.findByTestId("settings-nav-option-following");
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/following"));
  });

  it("Appeals and Copyright show their open counts", async () => {
    fake.appeals = [{ status: "open" }, { status: "open" }, { status: "upheld" }];
    fake.dmca = [{ status: "actioned" }, { status: "restored" }, { status: "rejected" }];
    await mount("/settings/account");
    await waitFor(() => expect(screen.getByTestId("settings-tab-appeals").textContent).toContain("2"));
    expect(screen.getByTestId("settings-tab-copyright").textContent).toContain("1");
    expect(screen.getByTestId("settings-tab-privacy").textContent).toBe(settingsTabLabel("privacy"));
  });

  it("the unsubscribe page and a signed-out visitor get no nav", async () => {
    await mount("/settings/notifications/unsubscribe");
    expect(screen.queryByTestId("settings-nav")).toBeNull();
    cleanup();
    boot.me = null;
    await mount("/settings/privacy");
    expect(screen.queryByTestId("settings-nav")).toBeNull();
  });

  it("one container at the default width, the page beside the nav from lg", async () => {
    await mount("/settings/account");
    const layout = screen.getByTestId("settings-layout");
    expect(layout.dataset.width).toBe("default");
    expect(layout.className).toMatch(/\blg:flex-row\b/);
    expect(within(screen.getByTestId("settings-main")).getByTestId("page")).toBeTruthy();
  });
});

describe("the scheduled-deletion banner", () => {
  it("shows above every settings page while a deletion is scheduled, and Cancel removes it", async () => {
    fake.deletion = { id: "d", status: "scheduled", scheduledFor: "2026-12-06T12:00:00.000Z", retained: [] };
    await mount("/settings/appeals");
    const banner = await screen.findByTestId("deletion-banner");
    expect(banner.dataset.scheduledFor).toBe("2026-12-06T12:00:00.000Z");
    expect(banner.querySelector("time")?.getAttribute("dateTime")).toBe("2026-12-06T12:00:00.000Z");
    // Above the page, inside the main column.
    const main = screen.getByTestId("settings-main");
    expect(main.firstElementChild).toBe(banner);
    fireEvent.click(within(banner).getByTestId("deletion-banner-cancel"));
    await waitFor(() => expect(screen.queryByTestId("deletion-banner")).toBeNull());
    expect(fake.cancels).toBe(1);
  });

  it("is absent with nothing scheduled, or a canceled request", async () => {
    await mount("/settings/account");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("deletion-banner")).toBeNull();
    cleanup();
    fake.deletion = { id: "d", status: "canceled", scheduledFor: "2026-12-06T12:00:00.000Z", retained: [] };
    await mount("/settings/account");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("deletion-banner")).toBeNull();
  });
});

describe("nav counts", () => {
  it("counts open appeals, and copyright notices removed or countered", () => {
    expect(openAppeals([])).toBe(0);
    expect(openAppeals([{ status: "open" }, { status: "overturned" }])).toBe(1);
    expect(openCopyright([{ status: "received" }, { status: "actioned" }, { status: "countered" }])).toBe(2);
    expect(openCopyright([{ status: "rejected" }, { status: "restored" }])).toBe(0);
  });
});

describe("bare /settings", () => {
  it("redirects to Account instead of an empty layout", async () => {
    const { Route: IndexRoute } = await import("../src/routes/_app/settings.index.tsx");
    const beforeLoad = IndexRoute.options.beforeLoad as () => unknown;
    let thrown: unknown;
    try {
      beforeLoad();
    } catch (err) {
      thrown = err;
    }
    expect(isRedirect(thrown)).toBe(true);
    const options = (thrown as { options: { to: string; replace?: boolean } }).options;
    expect(options.to).toBe("/settings/account");
    expect(options.replace).toBe(true);
  });
});

/**
 * The settings page pattern (P1): each route here renders a `PageHeader` whose title is its nav
 * label, and its sections are `SettingsSection`s (in the route or the components listed with it),
 * never cards. Explicit on purpose, so a new settings page is added here by hand. Subscriptions
 * keeps its own layout for now.
 */
const PAGES: { route: string; item: string; components: string[] }[] = [
  {
    route: "src/routes/_app/settings.account.tsx",
    item: "account",
    components: ["src/components/settings/account-page.tsx"],
  },
  {
    route: "src/routes/_app/settings.preferences.tsx",
    item: "preferences",
    components: ["src/components/locale/preferences-page.tsx", "src/components/settings/preferences-sections.tsx"],
  },
  {
    route: "src/routes/_app/settings.privacy.tsx",
    item: "privacy",
    components: [
      "src/components/privacy-panels.tsx",
      "src/components/blocks/blocked-users.tsx",
      "src/components/settings/delete-account.tsx",
    ],
  },
  {
    route: "src/routes/_app/settings.security.tsx",
    item: "security",
    components: [
      "src/components/security/security-page.tsx",
      "src/components/security/account-section.tsx",
      "src/components/security/two-factor-section.tsx",
      "src/components/security/passkeys-section.tsx",
      "src/components/security/sessions-section.tsx",
    ],
  },
  {
    route: "src/routes/_app/settings.notifications.index.tsx",
    item: "notifications",
    components: ["src/components/notifications/settings.tsx", "src/components/portability/grants.tsx"],
  },
  {
    route: "src/routes/_app/settings.appeals.tsx",
    item: "appeals",
    components: ["src/components/safety/enforcement.tsx", "src/components/safety/appeals.tsx"],
  },
  { route: "src/routes/_app/settings.copyright.tsx", item: "copyright", components: [] },
  {
    route: "src/routes/_app/settings.connections.tsx",
    item: "connections",
    components: ["src/components/oauth/connections.tsx"],
  },
];

describe("settings page policy", () => {
  it.each(PAGES.map((p) => [p.route, p] as const))(
    "%s: PageHeader with the nav label, SettingsSection, no cards",
    (_, page) => {
      const route = readFileSync(join(WEB, page.route), "utf8");
      expect(route).toMatch(new RegExp(`<PageHeader[\\s\\S]*?title=\\{t\\("d7Settings\\.nav\\.${page.item}"\\)\\}`));
      expect(route).toMatch(/<PageHeader[\s\S]*?description=/);
      expect(route).toContain(`titleHead(t("d7Settings.nav.${page.item}"))`);
      const sources = [route, ...page.components.map((f) => readFileSync(join(WEB, f), "utf8"))];
      expect(sources.some((s) => /<(SettingsSection|DangerZone)\b/.test(s))).toBe(true);
      for (const [i, s] of sources.entries()) {
        const file = i === 0 ? page.route : page.components[i - 1];
        expect(s, file).not.toContain("@commonair/ui/components/card");
        expect(s, file).not.toContain("PageContainer");
      }
      // Only the route brings the page header.
      for (const f of page.components) expect(readFileSync(join(WEB, f), "utf8"), f).not.toContain("<PageHeader");
    },
  );

  it("the nav labels are the page titles' source of truth", () => {
    for (const p of PAGES) expect(t(`d7Settings.nav.${p.item}` as Parameters<typeof t>[0])).toBeTruthy();
  });
});
