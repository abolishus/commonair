// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Chrome follow-ups in the real header: the account avatar's initial comes from the display name
 * (F38), and the phone sheet opens with the search first and closes when a link in it navigates.
 * Also the rest of the site chrome: staff menu entries per role, sign-out (success and failure),
 * the studio sidebar toggle, the rail and footer, and the account menu on its own.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import type { Theme } from "@commonair/ui";
import { SidebarProvider } from "@commonair/ui/components/sidebar";
import { Toaster } from "@commonair/ui/toast";
import type * as React from "react";
import { AccountMenu } from "../src/components/discovery/account-menu.tsx";
import { t } from "../src/i18n/index.ts";
import { ThemeContext } from "../src/lib/theme-context.ts";
import { MEMBER, boot, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
vi.mock("../src/components/notifications/bell.tsx", () => ({ NotificationBell: () => null }));

const { AppFooter, AppHeader, AppRail } = await import("../src/components/site-chrome.tsx");
const { resetHomeFeed } = await import("../src/components/discovery/feed.ts");

const header = (
  <ThemeContext.Provider value={{ theme: "dark", setTheme: () => {} }}>
    <AppHeader />
  </ThemeContext.Provider>
);

beforeEach(() => {
  fake.boot = boot();
  resetHomeFeed();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("the account avatar (F38)", () => {
  it("shows the display name's initial, not the username's", async () => {
    fake.boot = boot({ me: { ...MEMBER, username: "demo_streamer1", displayName: "Aurora Pixel" } });
    await renderInRouter(header, "/");
    const trigger = screen.getByTestId("nav-user");
    expect(trigger.dataset.username).toBe("demo_streamer1");
    expect(trigger.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("A");
  });
});

// The phone sheet is on pages without the bottom tab bar (here a channel page); on browsing pages
// the tab bar carries the sections instead, so there is no menu button.
describe("the phone sheet", () => {
  async function openSheet() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    });
    return screen.findByRole("dialog");
  }

  it("has the search first, above the nav", async () => {
    await renderInRouter(header, "/rivertide");
    const dialog = await openSheet();
    const search = dialog.querySelector('[data-testid="header-search"]');
    const nav = dialog.querySelector("nav");
    expect(search).not.toBeNull();
    expect(nav).not.toBeNull();
    expect((search as Node).compareDocumentPosition(nav as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes when a link in it navigates", async () => {
    const { router } = await renderInRouter(header, "/rivertide");
    const dialog = await openSheet();
    const browse = dialog.querySelector('[data-testid="nav-directory"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(browse);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/directory"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the route changes some other way", async () => {
    const { router } = await renderInRouter(header, "/rivertide");
    await openSheet();
    await act(async () => {
      await router.navigate({ to: "/signin" });
    });
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each(["/", "/directory", "/directory/art", "/search?q=a"])(
    "is not offered on %s (the tab bar's page)",
    async (path) => {
      // As the `_app` layout renders it there: told the page has the tab bar.
      await renderInRouter(
        <ThemeContext.Provider value={{ theme: "dark", setTheme: () => {} }}>
          <AppHeader tabBar />
        </ThemeContext.Provider>,
        path,
      );
      expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    },
  );

  it.each(["/rivertide", "/signin", "/signup"])("is offered on %s", async (path) => {
    await renderInRouter(header, path);
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
  });
});

describe("the account menu's staff entries", () => {
  async function openMenu(role: string) {
    fake.boot = boot({ me: { ...MEMBER, role } as typeof MEMBER });
    await renderInRouter(header, "/");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Viewer One/ }));
    });
    await screen.findByTestId("account-theme-switcher");
  }
  const staff = ["account-treasury-link", "account-moderation-link", "account-legal-link", "account-admin-coop-link"];
  const shown = () => staff.filter((id) => screen.queryByTestId(id) !== null);

  it.each([
    ["user", []],
    ["treasurer", ["account-treasury-link"]],
    ["moderator", ["account-moderation-link"]],
    ["legal", ["account-moderation-link", "account-legal-link"]],
    ["admin", ["account-moderation-link", "account-admin-coop-link"]],
  ])("a %s sees %j", async (role, expected) => {
    await openMenu(role);
    expect(shown()).toEqual(expected);
  });

  it("each staff entry links to its page, above the theme", async () => {
    await openMenu("admin");
    expect(screen.getByTestId("account-moderation-link").getAttribute("href")).toBe("/admin/moderation");
    expect(screen.getByTestId("account-admin-coop-link").getAttribute("href")).toBe("/admin/coop");
    const group = screen.getByTestId("account-theme-switcher");
    const coop = screen.getByTestId("account-admin-coop-link");
    expect(coop.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    await openMenu("treasurer");
    expect(screen.getByTestId("account-treasury-link").getAttribute("href")).toBe("/treasury");
    cleanup();
    await openMenu("legal");
    expect(screen.getByTestId("account-legal-link").getAttribute("href")).toBe("/admin/legal");
  });
});

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("signing out", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function clickSignOut() {
    fake.boot = boot({ me: MEMBER });
    await renderInRouter(
      <>
        {header}
        <Toaster />
      </>,
      "/",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Viewer One/ }));
    });
    const item = await screen.findByTestId("nav-signout");
    expect(item.getAttribute("data-variant")).toBe("destructive");
    await act(async () => {
      fireEvent.click(item);
    });
  }

  it("posts the sign-out and reloads the home page", async () => {
    const fetch = vi.fn<FetchFn>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await clickSignOut();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(fetch).toHaveBeenCalledWith(AUTH_ROUTES.signOut, expect.objectContaining({ method: "POST" }));
  });

  it("stays on the page and says so when the sign-out fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => new Response("{}", { status: 500 })),
    );
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await clickSignOut();
    expect(await screen.findByText(t("auth.signOutFailed"))).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("the sign-in page", () => {
  it("marks Sign in as the current page and drops the redirect", async () => {
    await renderInRouter(header, "/signin");
    const signIn = screen.getAllByText("Sign in")[0]?.closest("a");
    expect(signIn?.getAttribute("aria-current")).toBe("page");
    expect(signIn?.getAttribute("href")).toBe("/signin");
    const signUp = screen.getAllByText("Sign up")[0]?.closest("a");
    expect(signUp?.getAttribute("aria-current")).toBeNull();
    // Sign up is the primary button, Sign in the quiet one.
    expect(signUp?.className).not.toBe(signIn?.className);
  });
});

describe("the phone search button", () => {
  it("opens the search sheet", async () => {
    await renderInRouter(header, "/");
    expect(screen.queryByTestId("mobile-search-sheet")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("discovery.search.open") }));
    });
    expect(await screen.findByTestId("mobile-search-sheet")).toBeTruthy();
  });
});

describe("the studio header", () => {
  it("adds the sidebar toggle only in the studio", async () => {
    await renderInRouter(
      <ThemeContext.Provider value={{ theme: "dark", setTheme: () => {} }}>
        <SidebarProvider>
          <AppHeader studio />
        </SidebarProvider>
      </ThemeContext.Provider>,
      "/",
    );
    expect(document.querySelector('header [data-sidebar="trigger"]')).not.toBeNull();
    cleanup();
    await renderInRouter(header, "/");
    expect(document.querySelector('header [data-sidebar="trigger"]')).toBeNull();
  });
});

describe("the rail and footer", () => {
  it("AppRail is the side rail", async () => {
    await renderInRouter(
      <SidebarProvider>
        <AppRail />
      </SidebarProvider>,
      "/",
    );
    expect(screen.getByTestId("side-rail")).toBeTruthy();
  });

  it("AppFooter shows the instance and links the source only when it is a safe http(s) URL", async () => {
    fake.boot = boot({
      instance: { name: "Test Air", sourceUrl: "https://example.org/src", p2pDefault: "off", chatSafety: false },
    });
    await renderInRouter(<AppFooter />, "/");
    const footer = screen.getByRole("contentinfo");
    expect(footer.textContent).toContain("Test Air");
    expect(screen.getByTestId("footer-source-link").getAttribute("href")).toBe("https://example.org/src");
    for (const id of ["transparency", "attestations", "takedown", "dmca"])
      expect(screen.getByTestId(`footer-${id}-link`).tagName).toBe("A");
    cleanup();
    fake.boot = boot({
      instance: { name: "Test Air", sourceUrl: "javascript:alert(1)", p2pDefault: "off", chatSafety: false },
    });
    await renderInRouter(<AppFooter />, "/");
    expect(screen.queryByTestId("footer-source-link")).toBeNull();
  });
});

describe("AccountMenu on its own", () => {
  async function open(props: Partial<React.ComponentProps<typeof AccountMenu>> = {}) {
    const onThemeChange = vi.fn<(theme: Theme) => void>();
    await renderInRouter(
      <AccountMenu
        username="viewer1"
        menuLabel="Account"
        theme="dark"
        onThemeChange={onThemeChange}
        items={[]}
        {...props}
      />,
      "/",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Account" }));
    });
    const group = await screen.findByTestId("account-theme-switcher");
    return { group, onThemeChange };
  }

  it.each([undefined, null, ""])("takes the initial from the username when the display name is %j", async (name) => {
    await renderInRouter(
      <AccountMenu
        username="viewer1"
        displayName={name}
        menuLabel="Account"
        theme="dark"
        onThemeChange={() => {}}
        items={[]}
      />,
      "/",
    );
    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("V");
    expect(trigger.textContent).toContain("viewer1");
  });

  it("with no separated item, every item comes before the theme", async () => {
    const { group } = await open({
      items: [
        { id: "a", label: "Alpha", href: "/a", testId: "item-a" },
        { id: "b", label: "Beta", onSelect: () => {}, testId: "item-b" },
      ],
    });
    for (const id of ["item-a", "item-b"]) {
      const item = screen.getByTestId(id);
      expect(item.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("renders an href item as a plain link and runs onSelect for an action item", async () => {
    const onSelect = vi.fn<() => void>();
    await open({
      items: [
        { id: "a", label: "Alpha", href: "/a", testId: "item-a", icon: <span data-testid="icon-a" /> },
        { id: "b", label: "Beta", onSelect, testId: "item-b", separatorBefore: true, destructive: true },
      ],
    });
    const link = screen.getByTestId("item-a");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/a");
    expect(link.getAttribute("data-variant")).toBe("default");
    expect(link.querySelector('[data-testid="icon-a"]')).not.toBeNull();
    expect(link.textContent).toBe("Alpha");
    const action = screen.getByTestId("item-b");
    expect(action.tagName).not.toBe("A");
    expect(action.getAttribute("data-variant")).toBe("destructive");
    // The separated item sits after the theme, behind a separator.
    const group = screen.getByTestId("account-theme-switcher");
    expect(group.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.previousElementSibling?.getAttribute("data-slot")).toBe("dropdown-menu-separator");
    await act(async () => {
      fireEvent.click(action);
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not report the theme already chosen", async () => {
    const { group, onThemeChange } = await open({ theme: "light" });
    const radios = [...group.querySelectorAll('[role="menuitemradio"]')];
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(radios[1] as Element);
    });
    expect(onThemeChange).not.toHaveBeenCalled();
  });
});
