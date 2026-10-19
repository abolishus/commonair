// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, test } from "vite-plus/test";
import {
  AppShell,
  NavLink,
  SectionNav,
  PageContainer,
  ResponsiveGrid,
  SiteFooter,
  SiteHeader,
  SplitLayout,
  StudioShell,
  UserMenu,
} from "../../src/layouts/index.ts";
const brand = { mark: <span aria-hidden>CA</span>, name: "CommonAir", href: "/" };
test("AppShell renders banner, main, footer, skip link, and preserves data attributes", () => {
  render(
    <AppShell
      header={<SiteHeader brand={brand} nav={[]} navLabel="Primary navigation" menuLabel="Open navigation" />}
      footer={<SiteFooter instanceName="CommonAir" links={[]} license="AGPL" data-testid="app-footer" />}
      skipLabel="Skip to content"
      data-testid="app-shell"
    >
      <p>Content</p>
    </AppShell>,
  );
  expect(screen.getByTestId("app-shell")).toBeTruthy();
  expect(screen.getByTestId("app-footer")).toBeTruthy();
  expect(screen.getByRole("banner")).toBeTruthy();
  expect(screen.getAllByRole("main").at(-1)?.textContent).toContain("Content");
  expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main-content");
});
test("SiteHeader provides navigation, current-page state, and an accessible mobile menu trigger", () => {
  render(
    <SiteHeader
      brand={brand}
      nav={[{ id: "home", label: "Home", href: "/", current: true }]}
      navLabel="Primary navigation"
      menuLabel="Open navigation"
    />,
  );
  expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Open navigation" })).toBeTruthy();
});
test("SiteFooter forwards source-link data attributes", () => {
  render(
    <SiteFooter
      instanceName="CommonAir"
      links={[]}
      license="AGPL"
      sourceLink={{ href: "/source", label: "Source", "data-testid": "footer-source-link" }}
    />,
  );
  expect(screen.getByTestId("footer-source-link").getAttribute("rel")).toBe("noopener");
});
test("dashboard shell renders labeled navigation and main content", () => {
  render(
    <StudioShell
      header={<header>Studio header</header>}
      sidebarLabel="Studio navigation"
      skipLabel="Skip to content"
      groups={[
        {
          id: "studio",
          label: "Studio",
          items: [{ id: "overview", label: "Overview", href: "/studio", current: true }],
        },
      ]}
    >
      <p>Studio content</p>
    </StudioShell>,
  );
  expect(screen.getByRole("navigation", { name: "Studio navigation" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getAllByRole("main").at(-1)?.textContent).toContain("Studio content");
});
test("layout helpers forward root attributes and render their slots", () => {
  render(
    <PageContainer data-testid="container">
      <SplitLayout
        main={
          <ResponsiveGrid cols={2} data-testid="grid">
            <span>Card</span>
          </ResponsiveGrid>
        }
        aside={<div>Aside</div>}
        data-testid="split"
      />
    </PageContainer>,
  );
  expect(screen.getByTestId("container")).toBeTruthy();
  expect(screen.getByTestId("split").textContent).toContain("Aside");
  expect(screen.getByTestId("grid").textContent).toBe("Card");
});
test("UserMenu trigger preserves selector attributes", () => {
  render(
    <UserMenu username="Creator" menuLabel="User menu" items={[]} data-testid="nav-user" data-username="creator" />,
  );
  expect(screen.getByTestId("nav-user").getAttribute("data-username")).toBe("creator");
});

test("mobile navigation sheet closes with Escape and restores trigger focus", async () => {
  const user = userEvent.setup();
  render(
    <SiteHeader
      brand={brand}
      nav={[{ id: "home", label: "Home", href: "/" }]}
      navLabel="Primary navigation"
      menuLabel="Open navigation"
    />,
  );
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  await user.click(trigger);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("UserMenu opens and supports arrow-key item navigation", async () => {
  const user = userEvent.setup();
  render(
    <UserMenu
      username="Creator"
      menuLabel="User menu"
      items={[
        { id: "settings", label: "Settings" },
        { id: "signout", label: "Sign out" },
      ]}
    />,
  );
  await user.click(screen.getByRole("button", { name: "User menu" }));
  expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
});

test("NavLink honors router render elements and current-page state", () => {
  render(
    <NavLink
      item={{
        id: "settings",
        label: "Settings",
        render: (
          <a href="/router-settings" data-router-link>
            Router destination
          </a>
        ),
        current: true,
      }}
      data-testid="route-link"
    />,
  );
  const link = screen.getByTestId("route-link");
  expect(link.getAttribute("href")).toBe("/router-settings");
  expect(link.hasAttribute("data-router-link")).toBe(true);
  expect(link.getAttribute("aria-current")).toBe("page");
});

test("disabled NavLinks and SectionNav items cannot navigate", () => {
  const disabled = { id: "disabled", label: "Unavailable", href: "/unavailable", disabled: true };
  render(
    <>
      <NavLink item={disabled} data-testid="disabled-link" />
      <SectionNav label="Settings" items={[disabled]} data-testid="section-nav" />
    </>,
  );
  expect(screen.getByTestId("disabled-link").tagName).toBe("SPAN");
  expect(screen.getByTestId("disabled-link").getAttribute("aria-disabled")).toBe("true");
  expect(screen.queryAllByRole("link", { name: "Unavailable" })).toHaveLength(0);
});
