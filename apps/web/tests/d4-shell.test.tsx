// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D4 (F16, WCAG 2.4.1): "Skip to content" is the first thing Tab reaches, before the header's logo
 * and nav and before a sidebar, in every shell: the public AppShell, the AppShell with a sidebar,
 * and the studio and admin shells built on it.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { AdminShell, AppShell, SiteFooter, SiteHeader, StudioShell } from "@commonair/ui/layouts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const header = (
  <SiteHeader
    brand={{ mark: <span aria-hidden>CA</span>, name: "CommonAir", href: "/" }}
    nav={[
      { id: "browse", label: "Browse", href: "/", current: true },
      { id: "coop", label: "Co-op", href: "/coop" },
    ]}
    navLabel="Main"
    menuLabel="Menu"
    actions={<button type="button">Sign up</button>}
  />
);
const footer = <SiteFooter instanceName="CommonAir" links={[{ label: "About", href: "/about" }]} license="AGPL" />;
const groups = [
  { id: "studio", items: [{ id: "dashboard", label: "Stream manager", href: "/dashboard", current: true }] },
];
const sidebarLinks = (
  <nav aria-label="Followed">
    <a href="/aurora">Aurora</a>
  </nav>
);

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** What Tab reaches first: the first focusable element in document order (no positive tabindex in the app). */
function firstTabStop(): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>(FOCUSABLE)][0];
}

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

describe("the skip link comes first", () => {
  it.each([
    [
      "AppShell (public pages)",
      () => (
        <AppShell header={header} footer={footer} skipLabel="Skip to content">
          <a href="/x">In the page</a>
        </AppShell>
      ),
    ],
    [
      "AppShell with a sidebar",
      () => (
        <AppShell header={header} sidebar={sidebarLinks} footer={footer} skipLabel="Skip to content">
          <a href="/x">In the page</a>
        </AppShell>
      ),
    ],
    [
      "StudioShell",
      () => (
        <StudioShell header={header} groups={groups} sidebarLabel="Studio" skipLabel="Skip to content" footer={footer}>
          <a href="/x">In the page</a>
        </StudioShell>
      ),
    ],
    [
      "AdminShell",
      () => (
        <AdminShell header={header} groups={groups} sidebarLabel="Admin" skipLabel="Skip to content" footer={footer}>
          <a href="/x">In the page</a>
        </AdminShell>
      ),
    ],
  ])("%s", (_name, Shell) => {
    wrap(<Shell />);
    const skip = screen.getByTestId("skip-link");
    expect(firstTabStop()).toBe(skip);
    expect(skip.textContent).toBe("Skip to content");
    expect(skip.getAttribute("href")).toBe("#main-content");
    // Before the logo, the nav and every header control.
    const banner = screen.getByRole("banner");
    expect(skip.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It targets the main landmark, which takes focus.
    const main = document.getElementById("main-content");
    expect(main?.tagName).toBe("MAIN");
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });

  it("is visually hidden until focused, then shown on top", () => {
    wrap(
      <AppShell header={header} footer={footer} skipLabel="Skip to content">
        <p>Page</p>
      </AppShell>,
    );
    const skip = screen.getByTestId("skip-link");
    const classes = skip.className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["sr-only", "focus:not-sr-only", "focus:fixed", "focus:ring-2"]));
    skip.focus();
    expect(document.activeElement).toBe(skip);
    fireEvent.click(skip);
  });

  it("renders once per shell", () => {
    wrap(
      <AppShell header={header} sidebar={sidebarLinks} footer={footer} skipLabel="Skip to content">
        <p>Page</p>
      </AppShell>,
    );
    expect(screen.getAllByTestId("skip-link")).toHaveLength(1);
    // The sidebar is in the document (a desktop width) and comes after the skip link.
    const sidebarLink = screen.getByText("Aurora").closest("a");
    expect(sidebarLink).toBeTruthy();
    expect(
      screen.getByTestId("skip-link").compareDocumentPosition(sidebarLink as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
