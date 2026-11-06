// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The site header's follow-ups: the search centred on `lg`, the mobile sheet with the search first
 * and closing on navigation, and the account avatar's initial from the display name (F38). Also
 * the rest of the header's props (palette button, context, brand, actions) and the user menu items.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { SiteHeader, UserMenu, type SiteHeaderProps, type UserMenuItem } from "../../src/layouts/index.ts";

afterEach(cleanup);

const brand = { mark: <span aria-hidden>CA</span>, name: "CommonAir", href: "/" };
const nav = [
  { id: "browse", label: "Browse", href: "/directory" },
  { id: "coop", label: "Co-op", href: "/coop" },
];
const search = <input aria-label="Search CommonAir" data-testid="search" />;

function header(props: Partial<SiteHeaderProps> = {}) {
  return <SiteHeader brand={brand} nav={nav} navLabel="Main" menuLabel="Open navigation" {...props} />;
}

/** Stands in for a router link element: the component passes the content in. */
function RouterLink({ children, ...props }: React.ComponentProps<"a">) {
  return <a {...props}>{children}</a>;
}

/** Stops happy-dom following the link, so the test sees only the header's own reaction. */
function noNavigation(): () => void {
  const stop = (event: Event) => event.preventDefault();
  document.addEventListener("click", stop);
  return () => document.removeEventListener("click", stop);
}

async function openSheet() {
  await userEvent.setup().click(screen.getByRole("button", { name: "Open navigation" }));
  return screen.getByRole("dialog");
}

describe("the search on lg", () => {
  test("sits in the middle column of a three-column grid, the account controls in the last", () => {
    render(header({ search, user: <span>me</span> }));
    const bar = screen.getByRole("banner");
    expect(bar.className).toMatch(/\blg:grid\b/);
    expect(bar.className).toMatch(/\blg:grid-cols-3\b/);
    const slots = [...bar.children].map((child) => child.getAttribute("data-slot"));
    expect(slots).toEqual(["site-header-start", "site-header-search", "site-header-end"]);
    const middle = bar.querySelector('[data-slot="site-header-search"]');
    expect(middle?.className).toMatch(/\blg:col-start-2\b/);
    expect(middle?.className).toMatch(/\blg:justify-self-center\b/);
    expect(middle?.contains(screen.getByTestId("search"))).toBe(true);
    const end = bar.querySelector('[data-slot="site-header-end"]');
    expect(end?.className).toMatch(/\blg:col-start-3\b/);
    expect(end?.className).toMatch(/\blg:justify-self-end\b/);
    expect(end?.textContent).toContain("me");
  });

  test("without a search the bar stays a flex row (no empty middle column)", () => {
    render(header());
    const bar = screen.getByRole("banner");
    expect(bar.className).not.toMatch(/\blg:grid\b/);
    expect(bar.querySelector('[data-slot="site-header-search"]')).toBeNull();
  });
});

describe("the mobile sheet", () => {
  test("puts the search first, above the nav and the sheet actions", async () => {
    render(header({ search, mobileActions: <span data-testid="sheet-actions">actions</span> }));
    const dialog = await openSheet();
    const field = dialog.querySelector('[data-testid="search"]');
    const sheetNav = dialog.querySelector("nav");
    const actions = dialog.querySelector('[data-testid="sheet-actions"]');
    expect(field).not.toBeNull();
    expect(sheetNav).not.toBeNull();
    expect((field as Node).compareDocumentPosition(sheetNav as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((sheetNav as Node).compareDocumentPosition(actions as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("closes when a link inside it is activated", async () => {
    const release = noNavigation();
    try {
      render(header({ mobileActions: <a href="/settings">Settings</a> }));
      const dialog = await openSheet();
      const link = [...dialog.querySelectorAll("a")].find((a) => a.textContent === "Browse") as HTMLElement;
      act(() => {
        fireEvent.click(link);
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // A link in the sheet's actions too.
      const again = await openSheet();
      act(() => {
        fireEvent.click(again.querySelector('a[href="/settings"]') as HTMLElement);
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      release();
    }
  });

  test("stays open on a modified click (a new tab) and on a click that is not a link", async () => {
    const release = noNavigation();
    try {
      render(header({ mobileActions: <button type="button">Theme</button> }));
      const dialog = await openSheet();
      const link = [...dialog.querySelectorAll("a")].find((a) => a.textContent === "Browse") as HTMLElement;
      act(() => {
        fireEvent.click(link, { metaKey: true });
        fireEvent.click(link, { ctrlKey: true });
        fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      });
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally {
      release();
    }
  });

  test("closes when the location key changes, and not on the first render", async () => {
    const view = render(header({ locationKey: "/", mobileMenuOpen: true }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(header({ locationKey: "/", mobileMenuOpen: true }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(header({ locationKey: "/directory", mobileMenuOpen: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("controlled: reports open and close to the caller instead of keeping its own state", async () => {
    const onChange = vi.fn<(open: boolean) => void>();
    const view = render(header({ mobileMenuOpen: false, onMobileMenuOpenChange: onChange, locationKey: "/" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Open navigation" }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(header({ mobileMenuOpen: true, onMobileMenuOpenChange: onChange, locationKey: "/" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(header({ mobileMenuOpen: true, onMobileMenuOpenChange: onChange, locationKey: "/coop" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(false));
  });

  test("closes when only the search part of the location key changes", async () => {
    const view = render(header({ locationKey: "/search?q=a", mobileMenuOpen: true }));
    view.rerender(header({ locationKey: "/search?q=b", mobileMenuOpen: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("controlled: a location change while the sheet is closed tells the caller nothing", () => {
    const onChange = vi.fn<(open: boolean) => void>();
    const view = render(header({ mobileMenuOpen: false, onMobileMenuOpenChange: onChange, locationKey: "/" }));
    view.rerender(header({ mobileMenuOpen: false, onMobileMenuOpenChange: onChange, locationKey: "/coop" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("UserMenu avatar (F38)", () => {
  const initial = () => document.querySelector('[data-slot="avatar-fallback"]')?.textContent;

  test("takes the initial from the display name", () => {
    render(<UserMenu username="demo_streamer1" displayName="Aurora Pixel" menuLabel="Account" items={[]} />);
    expect(initial()).toBe("A");
    // The username stays the visible label.
    expect(screen.getByRole("button", { name: "Account" }).textContent).toContain("demo_streamer1");
  });

  test.each([undefined, null, ""])("falls back to the username when the display name is %j", (displayName) => {
    render(<UserMenu username="demo_streamer1" displayName={displayName} menuLabel="Account" items={[]} />);
    expect(initial()).toBe("D");
  });
});

describe("the bar's controls", () => {
  test("the phone search button opens the palette, and is absent without one", async () => {
    const onOpenPalette = vi.fn<() => void>();
    const view = render(header({ onOpenPalette, searchLabel: "Search" }));
    const button = screen.getByRole("button", { name: "Search" });
    expect(button.className).toMatch(/\bmd:hidden\b/);
    await userEvent.setup().click(button);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    view.unmount();
    render(header({ searchLabel: "Search" }));
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  });

  test("desktop actions sit in the bar from md only; actions and the user always", () => {
    render(
      header({
        desktopActions: <span data-testid="desktop">Sign up</span>,
        actions: <span data-testid="actions">toggle</span>,
        user: <span data-testid="user">me</span>,
      }),
    );
    const desktop = screen.getByTestId("desktop").parentElement as HTMLElement;
    expect(desktop.className).toMatch(/\bhidden\b/);
    expect(desktop.className).toMatch(/\bmd:flex\b/);
    const row = desktop.parentElement as HTMLElement;
    expect(row.contains(screen.getByTestId("actions"))).toBe(true);
    expect(row.contains(screen.getByTestId("user"))).toBe(true);
    expect(screen.getByTestId("actions").parentElement).toBe(row);
  });

  test("an empty nav renders no navigation in the bar or the sheet", async () => {
    render(header({ nav: [] }));
    expect(screen.queryByRole("navigation")).toBeNull();
    const dialog = await openSheet();
    expect(dialog.querySelector("nav")).toBeNull();
    expect(dialog.textContent).toContain("CommonAir");
  });

  test("the context follows the brand in the bar and heads the sheet", async () => {
    render(header({ context: { label: "Creator studio", href: "/studio" } }));
    const inBar = screen.getByRole("banner").querySelector('[data-slot="site-header-context"]') as HTMLElement;
    expect(inBar.getAttribute("href")).toBe("/studio");
    expect(inBar.textContent).toBe("Creator studio");
    expect(inBar.previousElementSibling?.getAttribute("data-slot")).toBe("separator");
    const dialog = await openSheet();
    const inSheet = dialog.querySelector('[data-slot="site-header-context"]') as HTMLElement;
    expect(inSheet.getAttribute("href")).toBe("/studio");
    expect(
      inSheet.compareDocumentPosition(dialog.querySelector("nav") as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("the brand renders through a router element when given one, else a plain link", () => {
    const view = render(header());
    const plain = screen.getByRole("link", { name: "CommonAir" });
    expect(plain.getAttribute("href")).toBe("/");
    expect(plain.textContent).toContain("CA");
    view.unmount();
    render(header({ brand: { ...brand, render: <RouterLink href="/home" data-testid="router-brand" /> } }));
    const routed = screen.getByTestId("router-brand");
    expect(routed.getAttribute("href")).toBe("/home");
    expect(routed.className).toMatch(/\bfont-semibold\b/);
    expect(routed.textContent).toContain("CommonAir");
  });

  test("uncontrolled: mobileMenuOpen alone is the initial state, then the sheet keeps its own", async () => {
    render(header({ mobileMenuOpen: true }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a non-primary mouse button on a link leaves the sheet open", async () => {
    const release = noNavigation();
    try {
      render(header());
      const dialog = await openSheet();
      const link = [...dialog.querySelectorAll("a")].find((a) => a.textContent === "Browse") as HTMLElement;
      act(() => {
        fireEvent.click(link, { shiftKey: true });
        fireEvent.click(link, { altKey: true });
        fireEvent.click(link, { button: 1 });
      });
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally {
      release();
    }
  });
});

describe("UserMenu items", () => {
  async function openMenu(items: UserMenuItem[]) {
    render(<UserMenu username="demo" menuLabel="Account" items={items} data-testid="menu" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Account" }));
    return screen.getByRole("menu");
  }

  test("an href item is a link that keeps its icon and label", async () => {
    await openMenu([{ id: "a", label: "Settings", href: "/settings", icon: <span data-testid="icon" />, testId: "a" }]);
    const item = screen.getByTestId("a");
    expect(item.tagName).toBe("A");
    expect(item.getAttribute("href")).toBe("/settings");
    expect(item.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(item.textContent).toBe("Settings");
    expect(item.getAttribute("data-variant")).toBe("default");
  });

  test("a render item uses the router element; an action item runs onSelect", async () => {
    const onSelect = vi.fn<() => void>();
    const menu = await openMenu([
      { id: "r", label: "Dashboard", render: <RouterLink href="/dashboard" data-router="yes" />, testId: "r" },
      { id: "s", label: "Sign out", onSelect, destructive: true, separatorBefore: true, testId: "s" },
    ]);
    expect(screen.getByTestId("r").getAttribute("data-router")).toBe("yes");
    expect(screen.getByTestId("r").textContent).toBe("Dashboard");
    const signOut = screen.getByTestId("s");
    expect(signOut.tagName).not.toBe("A");
    expect(signOut.getAttribute("data-variant")).toBe("destructive");
    expect(signOut.previousElementSibling?.getAttribute("data-slot")).toBe("dropdown-menu-separator");
    expect(menu.querySelectorAll('[data-slot="dropdown-menu-separator"]')).toHaveLength(1);
    await userEvent.setup().click(signOut);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
