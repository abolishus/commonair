// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D1 shell (design overhaul batch D1 item 6): one geometry for every area (the header full width,
 * the sidebar under it), the phone's bottom tab bar, the brand that collapses to its mark, the
 * 44 px icon hit areas below md, the three-column footer and the shared breakpoints.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  AdminShell,
  AppShell,
  BREAKPOINTS,
  BottomTabBar,
  CONTENT_MAX,
  PageContainer,
  SiteFooter,
  SiteHeader,
  StudioShell,
  TAB_BAR_HEIGHT,
  WORDMARK_MIN,
  below,
  type SiteHeaderProps,
  type TabBarItem,
} from "../../src/layouts/index.ts";

afterEach(cleanup);

const brand = { mark: <svg data-testid="mark" aria-hidden />, name: "CommonAir", label: "CommonAir, home", href: "/" };

function header(props: Partial<SiteHeaderProps> = {}) {
  return <SiteHeader brand={brand} nav={[]} navLabel="Main" menuLabel="Menu" {...props} />;
}

function RouterLink({ children, ...props }: React.ComponentProps<"a">) {
  return <a {...props}>{children}</a>;
}

/** Stands in for the cookie settings button: the footer passes the label in. */
function PlainButton({ children }: { children?: React.ReactNode }) {
  return <button type="button">{children}</button>;
}

const tabs: TabBarItem[] = [
  { id: "home", label: "Home", icon: <svg aria-hidden />, href: "/", current: true },
  { id: "browse", label: "Browse", icon: <svg aria-hidden />, render: <RouterLink href="/directory" /> },
  { id: "coop", label: "Co-op", icon: <svg aria-hidden />, href: "/coop" },
  { id: "you", label: "You", icon: <svg aria-hidden />, onSelect: () => {}, expanded: false },
];

describe("breakpoints", () => {
  test("are Tailwind's, with content capped at 1600 and the wordmark from the @sm container (384)", () => {
    expect(BREAKPOINTS).toEqual({ sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 });
    expect(CONTENT_MAX).toBe(1600);
    expect(WORDMARK_MIN).toBe(384);
    expect(TAB_BAR_HEIGHT).toBe(56);
    expect(below("md")).toBe("(max-width: 767.98px)");
  });

  test("PageContainer page width is the 1600 px cap", () => {
    render(<PageContainer width="page" data-testid="page" />);
    // 400 × the 0.25rem spacing unit = 100rem = 1600 px.
    expect(screen.getByTestId("page").className).toMatch(/\bmax-w-400\b/);
  });
});

describe("the bottom tab bar", () => {
  test("is a labelled nav of visible labels, below md only, 56 px, on a raised surface", () => {
    render(<BottomTabBar label="Sections" items={tabs} />);
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(nav.className).toMatch(/\bmd:hidden\b/);
    expect(nav.className).toMatch(/\bfixed\b/);
    expect(nav.className).toMatch(/\bbg-popover\b/);
    expect(nav.querySelector("ul")?.className).toMatch(/\bh-14\b/);
    expect(nav.querySelector("ul")?.className).toMatch(/\bgrid-cols-4\b/);
    expect(within(nav).getAllByRole("listitem")).toHaveLength(4);
    for (const label of ["Home", "Browse", "Co-op", "You"]) expect(within(nav).getByText(label)).toBeTruthy();
  });

  test("marks the current section with aria-current=page, and no other", () => {
    render(<BottomTabBar label="Sections" items={tabs} />);
    const home = screen.getByRole("link", { name: "Home" });
    expect(home.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Browse" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "Co-op" }).getAttribute("aria-current")).toBeNull();
  });

  test("renders a router element with the label inside it", () => {
    render(<BottomTabBar label="Sections" items={tabs} />);
    const browse = screen.getByRole("link", { name: "Browse" });
    expect(browse.getAttribute("href")).toBe("/directory");
    expect(browse.getAttribute("data-tab")).toBe("browse");
  });

  test("an item without a link is a button that opens a dialog", () => {
    const onSelect = vi.fn<() => void>();
    render(
      <BottomTabBar
        label="Sections"
        items={[{ id: "you", label: "You", icon: <svg aria-hidden />, onSelect, expanded: true, current: true }]}
      />,
    );
    const you = screen.getByRole("button", { name: "You" });
    expect(you.getAttribute("aria-haspopup")).toBe("dialog");
    expect(you.getAttribute("aria-expanded")).toBe("true");
    // A button is never "the current page".
    expect(you.getAttribute("aria-current")).toBeNull();
    fireEvent.click(you);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("hidden (the keyboard is open) takes it out of the page", () => {
    render(<BottomTabBar label="Sections" items={tabs} hidden data-testid="bar" />);
    const nav = screen.getByTestId("bar");
    expect(nav.hasAttribute("hidden")).toBe(true);
    expect(nav.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("the brand", () => {
  test("is named by its label whether or not the name shows", () => {
    render(header());
    const link = screen.getByRole("link", { name: "CommonAir, home" });
    expect(link.getAttribute("href")).toBe("/");
    expect(link.contains(screen.getByTestId("mark"))).toBe(true);
  });

  test("falls back to the name without a label", () => {
    render(header({ brand: { ...brand, label: undefined } }));
    expect(screen.getByRole("link", { name: "CommonAir" })).toBeTruthy();
  });

  test("collapses to the mark below 400 px, and below md when the signed-in cluster shows", () => {
    const view = render(header());
    let wordmark = screen.getByText("CommonAir");
    expect(wordmark.getAttribute("data-slot")).toBe("site-header-wordmark");
    expect(wordmark.getAttribute("aria-hidden")).toBe("true");
    expect(wordmark.className).toContain("@max-sm/site-header:hidden");
    expect(wordmark.className).not.toMatch(/max-md:hidden/);
    expect(screen.getByRole("banner").className).toContain("@container/site-header");
    view.unmount();
    render(header({ compactBrand: true }));
    wordmark = screen.getByText("CommonAir");
    expect(wordmark.className).toContain("@max-sm/site-header:hidden");
    expect(wordmark.className).toMatch(/\bmax-md:hidden\b/);
    expect(screen.getByRole("banner").hasAttribute("data-compact-brand")).toBe(true);
  });

  test("goes through a router element with the label kept", () => {
    render(header({ brand: { ...brand, render: <RouterLink href="/home" data-testid="routed" /> } }));
    const routed = screen.getByTestId("routed");
    expect(routed.getAttribute("aria-label")).toBe("CommonAir, home");
    expect(routed.getAttribute("href")).toBe("/home");
  });
});

describe("the header's phone controls", () => {
  test("icon buttons get a 44 px hit area below md", () => {
    render(header({ onOpenPalette: () => {}, searchLabel: "Search" }));
    expect(screen.getByRole("button", { name: "Search" }).className).toMatch(/\bmax-md:size-11\b/);
    expect(screen.getByRole("button", { name: "Menu" }).className).toMatch(/\bmax-md:size-11\b/);
  });

  test("mobileMenu off leaves out the menu button and its sheet", () => {
    render(header({ mobileMenu: false, nav: [{ id: "b", label: "Browse", href: "/directory" }] }));
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    // The inline nav is still there from md.
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  test("uses the 16 / 24 / 32 px gutter", () => {
    render(header());
    const classes = screen.getByRole("banner").className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["px-4", "md:px-6", "xl:px-8"]));
  });
});

describe("one shell geometry", () => {
  const top = <header data-testid="top">Header</header>;
  const groups = [{ id: "g", items: [{ id: "a", label: "Stream manager", href: "/dashboard" }] }];
  test.each([
    [
      "StudioShell",
      () => (
        <StudioShell header={top} groups={groups} sidebarLabel="Studio" skipLabel="Skip">
          <p>Page</p>
        </StudioShell>
      ),
    ],
    [
      "AdminShell",
      () => (
        <AdminShell header={top} groups={groups} sidebarLabel="Admin" skipLabel="Skip">
          <p>Page</p>
        </AdminShell>
      ),
    ],
    [
      "AppShell with a rail",
      () => (
        <AppShell header={top} sidebar={<nav aria-label="Rail" />} skipLabel="Skip">
          <p>Page</p>
        </AppShell>
      ),
    ],
  ])("%s: the header spans the page and sticks, the sidebar starts under it", (_name, Shell) => {
    render(<Shell />);
    const wrapper = screen.getByTestId("top").parentElement as HTMLElement;
    expect(wrapper.getAttribute("data-slot")).toBe("app-shell-header");
    expect(wrapper.className.split(/\s+/)).toEqual(expect.arrayContaining(["sticky", "top-0", "w-full"]));
    const sidebar = document.querySelector('[data-slot="sidebar"]') as HTMLElement;
    expect(sidebar).not.toBeNull();
    // The header comes first and is not inside the sidebar's column.
    expect(wrapper.compareDocumentPosition(sidebar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrapper.contains(sidebar)).toBe(false);
    expect(document.querySelector('[data-slot="sidebar-container"]')?.className).toMatch(/\btop-14\b/);
  });

  test("a page without a sidebar keeps the header sticky too", () => {
    render(
      <AppShell header={top} skipLabel="Skip">
        <p>Page</p>
      </AppShell>,
    );
    expect((screen.getByTestId("top").parentElement as HTMLElement).className).toMatch(/\bsticky\b/);
  });

  test("the bottom bar comes after the footer, and the page is padded for it below md", () => {
    const view = render(
      <AppShell
        header={top}
        sidebar={<nav aria-label="Rail" />}
        footer={<footer data-testid="foot" />}
        bottomBar={<nav aria-label="Sections" data-testid="bar" />}
        skipLabel="Skip"
        data-testid="shell"
      >
        <p>Page</p>
      </AppShell>,
    );
    const shell = screen.getByTestId("shell");
    expect(shell.hasAttribute("data-bottom-bar")).toBe(true);
    expect(shell.className).toMatch(/\bmax-md:pb-14\b/);
    expect(
      screen.getByTestId("foot").compareDocumentPosition(screen.getByTestId("bar")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    view.unmount();
    render(
      <AppShell header={top} skipLabel="Skip" data-testid="shell">
        <p>Page</p>
      </AppShell>,
    );
    expect(screen.getByTestId("shell").hasAttribute("data-bottom-bar")).toBe(false);
    expect(screen.getByTestId("shell").className).not.toContain("max-md:pb-");
  });
});

describe("the footer", () => {
  const columns = [
    { id: "create", heading: "Create", links: [{ label: "Stream here", href: "/creators" }] },
    {
      id: "coop",
      heading: "Co-op",
      links: [
        { label: "How it works", href: "/coop" },
        { label: "Membership", render: <RouterLink href="/coop/membership" data-testid="routed" /> },
      ],
    },
    { id: "legal", heading: "Legal", links: [{ label: "Copyright (DMCA)", href: "/dmca" }] },
  ];

  test("has the brand column, then Create, Co-op and Legal as labelled navs with headings", () => {
    render(
      <SiteFooter
        instanceName="CommonAir"
        mark={<svg data-testid="footer-mark" aria-hidden />}
        tagline="Owned by its creators."
        columns={columns}
        links={[]}
        license="AGPL"
      />,
    );
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("Owned by its creators.")).toBeTruthy();
    expect(within(footer).getByTestId("footer-mark")).toBeTruthy();
    const navs = within(footer).getAllByRole("navigation");
    expect(navs.map((n) => n.getAttribute("aria-label"))).toEqual(["Create", "Co-op", "Legal"]);
    expect(
      within(footer)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["Create", "Co-op", "Legal"]);
    expect(within(navs[1] as HTMLElement).getByTestId("routed").textContent).toBe("Membership");
    expect(
      within(navs[0] as HTMLElement)
        .getByRole("link", { name: "Stream here" })
        .getAttribute("href"),
    ).toBe("/creators");
    // One column on phones, four from md.
    expect(footer.querySelector('[data-slot="site-footer-columns"]')?.className).toMatch(/\bmd:grid-cols-4\b/);
  });

  test("the base row has the source link, the license, the controls and any extra", () => {
    render(
      <SiteFooter
        instanceName="CommonAir"
        columns={columns}
        baseLabel="Site settings"
        links={[{ label: "Cookie settings", render: <PlainButton /> }]}
        extra={<span data-testid="extra">theme</span>}
        license="AGPL"
        sourceLink={{ label: "Source", href: "https://example.org/src", "data-testid": "src" }}
      />,
    );
    const base = document.querySelector('[data-slot="site-footer-base"]') as HTMLElement;
    expect(within(base).getByTestId("src").getAttribute("rel")).toBe("noopener");
    expect(within(base).getByText("AGPL")).toBeTruthy();
    expect(within(base).getByRole("navigation", { name: "Site settings" })).toBeTruthy();
    expect(within(base).getByRole("button", { name: "Cookie settings" })).toBeTruthy();
    expect(within(base).getByTestId("extra")).toBeTruthy();
  });

  test("without columns it is the brand and the base row only", () => {
    render(<SiteFooter instanceName="CommonAir" links={[{ label: "About", href: "/about" }]} license="AGPL" />);
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "About" }).getAttribute("href")).toBe("/about");
    expect(document.querySelector('[data-slot="site-footer-columns"]')?.className).not.toContain("md:grid-cols");
  });
});
