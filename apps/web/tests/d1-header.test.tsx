// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D1-web (F14, F18, F1): the header holds the logo, Browse (now `/directory`), search and the
 * account controls. The theme switcher left it: members find it in the account menu, visitors at
 * the bottom of the mobile sheet. Sign in and Sign up come back to the current page.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Theme } from "@commonair/ui";
import { ThemeContext } from "../src/lib/theme-context.ts";
import { MEMBER, boot, home, live, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
// Not under test here, and they would fetch.
vi.mock("../src/components/notifications/bell.tsx", () => ({ NotificationBell: () => null }));

const { AppHeader } = await import("../src/components/site-chrome.tsx");
const { primeHomeFeed, resetHomeFeed } = await import("../src/components/discovery/feed.ts");

function header(setTheme = vi.fn<(theme: Theme) => void>()) {
  return (
    <ThemeContext.Provider value={{ theme: "dark", setTheme }}>
      <AppHeader />
    </ThemeContext.Provider>
  );
}

/** The href of the header's Sign in / Sign up link (a Button rendered as a router link). */
const authLink = (label: string) => screen.getAllByText(label)[0]?.closest("a")?.getAttribute("href");

/** The bar itself: everything in the header that is not inside the (portalled) sheet or a menu. */
const bar = () => document.querySelector("header") as HTMLElement;

beforeEach(() => {
  fake.boot = boot();
  resetHomeFeed();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("the header bar", () => {
  it("has the logo, Browse to /directory, search, and no theme switcher", async () => {
    await renderInRouter(header(), "/");
    expect(screen.getByTestId("nav-directory").getAttribute("href")).toBe("/directory");
    expect(screen.getByTestId("header-search")).toBeTruthy();
    expect(bar().querySelector('[data-slot="toggle-group"]')).toBeNull();
    expect(screen.queryByRole("group", { name: "Theme" })).toBeNull();
    expect(screen.queryByTestId("account-theme-switcher")).toBeNull();
  });

  it("Sign in and Sign up return to the current page", async () => {
    await renderInRouter(header(), "/directory/art?x=1");
    expect(authLink("Sign in")).toBe("/signin?redirect=%2Fdirectory%2Fart%3Fx%3D1");
    expect(authLink("Sign up")).toBe("/signup?redirect=%2Fdirectory%2Fart%3Fx%3D1");
  });

  it("does not loop the redirect from the sign-in page or add one on /", async () => {
    await renderInRouter(header(), "/");
    expect(authLink("Sign in")).toBe("/signin");
  });
});

describe("visitors: the theme is at the bottom of the mobile sheet", () => {
  it("opens the sheet with Live now, then the theme and language", async () => {
    primeHomeFeed(home({ live: [live("demo_streamer1")] }));
    await renderInRouter(header(), "/");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    });
    const dialog = await screen.findByRole("dialog");
    const discovery = dialog.querySelector('[data-testid="sheet-discovery"]');
    const theme = dialog.querySelector('[data-testid="sheet-theme-switcher"]');
    expect(discovery).not.toBeNull();
    expect(theme).not.toBeNull();
    expect(theme?.querySelector('[data-slot="toggle-group"]')).not.toBeNull();
    // Discovery first, the theme after it.
    expect((discovery as Node).compareDocumentPosition(theme as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.textContent).toContain("Live now");
  });
});

describe("members: the theme is in the account menu", () => {
  it("lists the three themes as radios and switches on select; the sheet has none", async () => {
    fake.boot = boot({ me: MEMBER });
    const setTheme = vi.fn<(theme: Theme) => void>();
    await renderInRouter(header(setTheme), "/");
    expect(bar().querySelector('[data-slot="toggle-group"]')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Viewer One/ }));
    });
    const group = await screen.findByTestId("account-theme-switcher");
    const radios = [...group.querySelectorAll('[role="menuitemradio"]')];
    expect(radios.map((r) => r.getAttribute("data-theme-option"))).toEqual(["dark", "light", "system"]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(radios[1] as Element);
    });
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("light"));
    // Sign out stays last, after the theme.
    const signOut = screen.getByTestId("nav-signout");
    expect(group.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the theme out of the member's mobile sheet", async () => {
    fake.boot = boot({ me: MEMBER });
    await renderInRouter(header(), "/");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector('[data-testid="sheet-theme-switcher"]')).toBeNull();
  });
});
