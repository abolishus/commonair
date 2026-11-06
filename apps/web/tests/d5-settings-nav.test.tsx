// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-settings (F27): the settings layout. The real layout component renders inside a memory
 * router with a stand-in page per tab: the tab row marks each of the seven pages from the route
 * (nested paths included), the phone `Select` changes page, and every page shares one width (the
 * layout's `default`; no page brings its own container).
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
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SETTINGS_TABS, settingsTabFor, settingsTabLabel } from "../src/components/settings/settings-nav.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { Route as SettingsRoute } from "../src/routes/_app/settings.tsx";

configure({ asyncUtilTimeout: 5_000 });

const boot = vi.hoisted(() => ({ me: { id: "u1", username: "viewer1" } as null | { id: string; username: string } }));
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: boot.me, now: Date.now() }),
}));

afterEach(() => {
  cleanup();
  boot.me = { id: "u1", username: "viewer1" };
});

const WEB = join(import.meta.dirname, "..");
const Layout = SettingsRoute.options.component as () => React.JSX.Element;

async function mount(path: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: Layout });
  const pages = SETTINGS_TABS.map((tab) =>
    createRoute({
      getParentRoute: () => settings,
      path: tab.to.slice("/settings/".length),
      component: () => <p data-testid="page">{tab.id}</p>,
    }),
  );
  const unsubscribe = createRoute({
    getParentRoute: () => settings,
    path: "notifications/unsubscribe",
    component: () => <p data-testid="page">unsubscribe</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings.addChildren([...pages, unsubscribe])]),
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
  it.each(SETTINGS_TABS.map((tab) => [tab.to, tab.id] as const))("%s is %s", (path, id) => {
    expect(settingsTabFor(path)).toBe(id);
    expect(settingsTabFor(`${path}/`)).toBe(id);
    expect(settingsTabFor(`${path}?x=1`)).toBe(id);
  });

  it("matches nested paths by prefix, not by exact string", () => {
    expect(settingsTabFor("/settings/notifications/channels")).toBe("notifications");
    expect(settingsTabFor("/settings/copyright/abc")).toBe("copyright");
  });

  it("has no tab for the unsubscribe page, look-alike paths or other pages", () => {
    expect(settingsTabFor("/settings/notifications/unsubscribe")).toBeNull();
    expect(settingsTabFor("/settings/privacyx")).toBeNull();
    expect(settingsTabFor("/settings")).toBeNull();
    expect(settingsTabFor("/coop/settings")).toBeNull();
    expect(settingsTabFor("/")).toBeNull();
  });
});

describe("the settings layout", () => {
  it.each(SETTINGS_TABS.map((tab) => [tab.id, tab.to] as const))("marks %s on its own page", async (id, path) => {
    await mount(path);
    const nav = screen.getByTestId("settings-nav");
    expect(nav.dataset.current).toBe(id);
    expect(nav.tagName).toBe("NAV");
    for (const tab of SETTINGS_TABS) {
      const link = screen.getByTestId(`settings-tab-${tab.id}`);
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe(tab.to);
      expect(link.getAttribute("aria-current")).toBe(tab.id === id ? "page" : null);
      // The styled state follows the route too (the co-op row once lit the first tab on every page).
      expect(link.hasAttribute("data-active")).toBe(tab.id === id);
    }
    expect(screen.getByTestId("settings-nav-select").dataset.value).toBe(id);
  });

  it("the phone select changes page", async () => {
    const router = await mount("/settings/privacy");
    fireEvent.click(screen.getByTestId("settings-nav-select"));
    const option = await screen.findByTestId("settings-nav-option-connections");
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/connections"));
    await waitFor(() => expect(screen.getByTestId("page").textContent).toBe("connections"));
    expect(screen.getByTestId("settings-nav").dataset.current).toBe("connections");
  });

  it("the phone select stays put when the current page is picked again", async () => {
    const router = await mount("/settings/privacy?from=mail");
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(screen.getByTestId("settings-nav-select"));
    const option = await screen.findByTestId("settings-nav-option-privacy");
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(screen.queryByTestId("settings-nav-option-privacy")).toBeNull());
    expect(navigate).not.toHaveBeenCalled();
    // The query survives: no navigation replaced it.
    expect(router.state.location.searchStr).toBe("?from=mail");
  });

  it("each tab and option carries its translated label", async () => {
    await mount("/settings/subscriptions");
    fireEvent.click(screen.getByTestId("settings-nav-select"));
    for (const tab of SETTINGS_TABS) {
      expect(screen.getByTestId(`settings-tab-${tab.id}`).textContent).toBe(settingsTabLabel(tab.id));
      expect((await screen.findByTestId(`settings-nav-option-${tab.id}`)).textContent).toBe(settingsTabLabel(tab.id));
    }
  });

  it("a tab is a link: clicking one navigates", async () => {
    const router = await mount("/settings/appeals");
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-tab-copyright"));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/copyright"));
  });

  it("the tab row shows from sm up, the select below it", async () => {
    await mount("/settings/privacy");
    const tabs = screen.getByTestId("settings-tab-privacy").closest("[data-slot=tabs]");
    expect(tabs?.className).toMatch(/\bhidden\b/);
    expect(tabs?.className).toMatch(/\bsm:flex\b/);
    expect(screen.getByTestId("settings-nav-select").parentElement?.className).toMatch(/\bsm:hidden\b/);
  });

  it("the tab row is the shared PageTabs: a line list in its own sideways scroller, in tab order", async () => {
    await mount("/settings/copyright");
    const list = screen.getByTestId("settings-tab-copyright").closest("[data-slot=tabs-list]") as HTMLElement;
    expect(list.dataset.variant).toBe("line");
    expect(list.parentElement?.className).toMatch(/\boverflow-x-auto\b/);
    const triggers = [...list.querySelectorAll("[data-slot=tabs-trigger]")];
    expect(triggers.map((el) => el.getAttribute("data-testid"))).toEqual(
      SETTINGS_TABS.map((tab) => `settings-tab-${tab.id}`),
    );
    expect(triggers.map((el) => el.textContent)).toEqual(SETTINGS_TABS.map((tab) => settingsTabLabel(tab.id)));
    // Exactly one tab is selected, the route's.
    expect(list.querySelectorAll("[data-active]")).toHaveLength(1);
  });

  it("the unsubscribe page and a signed-out visitor get no tab row", async () => {
    await mount("/settings/notifications/unsubscribe");
    expect(screen.queryByTestId("settings-nav")).toBeNull();
    cleanup();
    boot.me = null;
    await mount("/settings/privacy");
    expect(screen.queryByTestId("settings-nav")).toBeNull();
  });
});

describe("bare /settings", () => {
  it("redirects to the first tab instead of an empty layout", async () => {
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
    expect(options.to).toBe(SETTINGS_TABS[0].to);
    expect(options.replace).toBe(true);
  });

  it("lands on the first tab in the router", async () => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: Layout });
    const { Route: IndexRoute } = await import("../src/routes/_app/settings.index.tsx");
    const index = createRoute({
      getParentRoute: () => settings,
      path: "/",
      beforeLoad: IndexRoute.options.beforeLoad as () => void,
    });
    const first = createRoute({
      getParentRoute: () => settings,
      path: "subscriptions",
      component: () => <p data-testid="page">subscriptions</p>,
    });
    const router = createRouter({
      routeTree: root.addChildren([settings.addChildren([index, first])]),
      history: createMemoryHistory({ initialEntries: ["/settings"] }),
    });
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/subscriptions"));
    expect((await screen.findByTestId("page")).textContent).toBe("subscriptions");
    expect(screen.getByTestId("settings-nav").dataset.current).toBe("subscriptions");
  });
});

describe("one width", () => {
  it("the layout is the one container, at the default width", async () => {
    await mount("/settings/subscriptions");
    const layout = screen.getByTestId("settings-layout");
    expect(layout.dataset.width).toBe("default");
    expect(layout.className).toContain("max-w-6xl");
  });

  it("no settings page or its component brings a container of its own", () => {
    const routes = readdirSync(join(WEB, "src/routes/_app"))
      .filter(
        (f) =>
          f.startsWith("settings.") &&
          !["settings.tsx", "settings.index.tsx"].includes(f) &&
          !f.includes("unsubscribe"),
      )
      .map((f) => `src/routes/_app/${f}`);
    expect(routes).toHaveLength(7);
    const files = [...routes, "src/components/oauth/connections.tsx", "src/components/locale/preferences-page.tsx"];
    for (const file of files) expect(readFileSync(join(WEB, file), "utf8"), file).not.toContain("PageContainer");
  });

  it("every settings page has a PageHeader with a description", () => {
    const pages = [
      "src/routes/_app/settings.appeals.tsx",
      "src/routes/_app/settings.copyright.tsx",
      "src/routes/_app/settings.notifications.index.tsx",
      "src/routes/_app/settings.privacy.tsx",
      "src/routes/_app/settings.subscriptions.tsx",
      // These two routes are thin wrappers; their page components own the header.
      "src/components/oauth/connections.tsx",
      "src/components/locale/preferences-page.tsx",
    ];
    for (const file of pages) {
      const text = readFileSync(join(WEB, file), "utf8");
      expect(text, file).toMatch(/<PageHeader[\s\S]*?description=/);
    }
  });
});
