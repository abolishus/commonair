// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** U7 follow-ups: ChannelSidebar per-group "show all" link and the SiteHeader context segment. */
import type * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";
import { SidebarProvider } from "../../src/components/sidebar.tsx";
import { ChannelSidebar, SiteHeader } from "../../src/layouts/index.ts";

const brand = { mark: <span aria-hidden="true">CA</span>, name: "CommonAir", href: "/" };
const groups = [
  {
    id: "followed",
    label: "Followed live",
    channels: [{ id: "r", name: "rivertide", category: "Science", href: "/rivertide", live: true, viewers: 2400 }],
    moreLink: { label: "Show all 38 followed", href: "/following" },
  },
  {
    id: "spotlight",
    label: "Spotlight",
    channels: [{ id: "t", name: "Tinwhistle", category: "Music", href: "/tinwhistle" }],
  },
];

const sidebar = (node: React.ReactNode): React.ReactElement => <SidebarProvider>{node}</SidebarProvider>;

describe("ChannelSidebar moreLink", () => {
  test("adds a footer link to its group only", () => {
    render(sidebar(<ChannelSidebar label="Channels" groups={groups} />));
    const link = screen.getByRole("link", { name: "Show all 38 followed" });
    expect(link.getAttribute("href")).toBe("/following");
    expect(link.hasAttribute("data-more-link")).toBe(true);
    expect(document.querySelectorAll("[data-more-link]")).toHaveLength(1);
    const lists = screen.getAllByRole("list");
    expect(
      within(lists[0] as HTMLElement)
        .getAllByRole("link")
        .at(-1),
    ).toBe(link);
  });

  test("accepts a router render element", () => {
    render(
      sidebar(
        <ChannelSidebar
          label="Channels"
          groups={[
            {
              ...groups[1]!,
              moreLink: {
                label: "Show more",
                render: (
                  <a href="/s" data-router="">
                    Show more
                  </a>
                ),
              },
            },
          ]}
        />,
      ),
    );
    expect(screen.getByRole("link", { name: "Show more" }).getAttribute("data-router")).toBe("");
  });

  test("the callout is a static note, not an alert", () => {
    render(sidebar(<ChannelSidebar label="Channels" groups={[]} callout="Viewer counts are verified." />));
    expect(screen.getByRole("note").textContent).toContain("Viewer counts are verified.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("SiteHeader context", () => {
  test("shows the context after the brand and omits an empty nav landmark", () => {
    render(
      <SiteHeader
        brand={brand}
        context={{ label: "Creator studio", href: "/studio" }}
        nav={[]}
        navLabel="Creator studio"
        menuLabel="Open navigation"
      />,
    );
    const banner = screen.getByRole("banner");
    const links = within(banner).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["CACommonAir", "Creator studio"]);
    expect(links[1]?.getAttribute("href")).toBe("/studio");
    expect(links[1]?.getAttribute("data-slot")).toBe("site-header-context");
    expect(within(banner).queryByRole("navigation")).toBeNull();
  });

  test("renders a router element for the context and keeps the nav when present", () => {
    render(
      <SiteHeader
        brand={brand}
        context={{
          label: "Admin",
          render: (
            <a href="/admin" data-router="">
              Admin
            </a>
          ),
        }}
        nav={[{ id: "reports", label: "Reports", href: "/admin/reports", current: true }]}
        navLabel="Admin"
        menuLabel="Open navigation"
      />,
    );
    expect(screen.getByRole("link", { name: "Admin" }).getAttribute("data-router")).toBe("");
    expect(screen.getByRole("navigation", { name: "Admin" })).toBeTruthy();
  });

  test("without context nothing extra renders", () => {
    const { container } = render(<SiteHeader brand={brand} nav={[]} navLabel="Main" menuLabel="Open navigation" />);
    expect(container.querySelector("[data-slot=site-header-context]")).toBeNull();
  });
});

describe("layout follow-ups SSR and hydration", () => {
  test.each([
    ["ChannelSidebar (moreLink)", sidebar(<ChannelSidebar label="Channels" groups={groups} callout="Note" />)],
    [
      "SiteHeader (context)",
      <SiteHeader
        key="h"
        brand={brand}
        context={{ label: "Creator studio", href: "/studio" }}
        nav={[]}
        navLabel="Creator studio"
        menuLabel="Open navigation"
      />,
    ],
  ] as [string, React.ReactElement][])("%s hydrates without warnings", async (_name, node) => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(node);
    document.body.append(container);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, node, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    act(() => root?.unmount());
    error.mockRestore();
    container.remove();
  });
});
