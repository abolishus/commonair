// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The site header's follow-ups: the search centred on `lg`, the mobile sheet with the search first
 * and closing on navigation, and the account avatar's initial from the display name (F38).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { SiteHeader, UserMenu, type SiteHeaderProps } from "../../src/layouts/index.ts";

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
