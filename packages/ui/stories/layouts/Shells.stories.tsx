// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AppShell,
  AdminShell,
  ChannelSidebar,
  HeaderSearch,
  SectionNav,
  SiteFooter,
  SiteHeader,
  StudioShell,
  UserMenu,
  type NavGroup,
} from "@commonair/ui/layouts";
import { PageContainer, ResponsiveGrid, SplitLayout } from "@commonair/ui/layouts";
import { Button } from "@commonair/ui/components/button";
import { PageHeader } from "@commonair/ui/blocks/headers";
const meta = { title: "Layouts/Shells", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj;
const nav = [
  { id: "browse", label: "Browse", href: "#browse", current: true },
  { id: "following", label: "Following", href: "#following" },
];
const groups: NavGroup[] = [
  {
    id: "main",
    label: "Workspace",
    items: [
      { id: "overview", label: "Overview", href: "#overview", current: true },
      { id: "moderation", label: "Moderation", href: "#moderation", badge: { label: "3", tone: "destructive" } },
    ],
  },
];
const footer = <SiteFooter instanceName="CommonAir" links={[{ label: "About", href: "#about" }]} license="AGPL-3.0" />;
const header = (
  <SiteHeader
    brand={{ mark: <span aria-hidden>●</span>, name: "CommonAir", href: "#home" }}
    nav={nav}
    navLabel="Main navigation"
    menuLabel="Open navigation"
  />
);
export const AppShellStory: Story = {
  name: "AppShell",
  render: () => (
    <AppShell header={header} footer={footer} skipLabel="Skip to content">
      <PageContainer>
        <PageHeader title="Browse" description="Find channels live now." />
        <p>Page content</p>
      </PageContainer>
    </AppShell>
  ),
};
export const AppShellWithChannelSidebar: Story = {
  name: "AppShell with ChannelSidebar",
  render: () => (
    <AppShell
      header={header}
      sidebar={<ChannelSidebar label="Followed channels" groups={[]} />}
      footer={footer}
      skipLabel="Skip to content"
    >
      <p>Signed in view</p>
    </AppShell>
  ),
};
export const StudioShellStory: Story = {
  name: "StudioShell",
  render: () => (
    <StudioShell header={header} groups={groups} sidebarLabel="Studio navigation" skipLabel="Skip to content">
      <p>Studio content</p>
    </StudioShell>
  ),
};
export const AdminShellStory: Story = {
  name: "AdminShell",
  render: () => (
    <AdminShell header={header} groups={groups} sidebarLabel="Administration navigation" skipLabel="Skip to content">
      <p>Admin content</p>
    </AdminShell>
  ),
};
export const SiteHeaderStory: Story = {
  name: "SiteHeader",
  render: () => (
    <SiteHeader
      brand={header.props.brand}
      nav={nav}
      navLabel="Main navigation"
      menuLabel="Open navigation"
      search={<HeaderSearch label="Search CommonAir" placeholder="Search" shortcut="⌘ K" />}
    />
  ),
};
export const HeaderSearchStory: Story = {
  name: "HeaderSearch",
  render: () => <HeaderSearch label="Search CommonAir" placeholder="Search channels" shortcut="⌘ K" />,
};
export const UserMenuStory: Story = {
  name: "UserMenu",
  render: () => (
    <UserMenu
      username="Creator"
      menuLabel="Account menu"
      items={[
        { id: "settings", label: "Settings", href: "#settings" },
        { id: "signout", label: "Sign out", destructive: true, separatorBefore: true },
      ]}
    />
  ),
};
export const SiteFooterStory: Story = {
  name: "SiteFooter",
  render: () => (
    <SiteFooter
      instanceName="CommonAir"
      links={[
        { label: "About", href: "#about" },
        { label: "Privacy", href: "#privacy" },
      ]}
      sourceLink={{ label: "Source", href: "#source", "data-testid": "footer-source-link" }}
      license="AGPL-3.0-or-later"
    />
  ),
};
export const ChannelSidebarStory: Story = {
  name: "ChannelSidebar",
  render: () => (
    <ChannelSidebar
      label="Followed channels"
      groups={[
        {
          id: "live",
          label: "Followed live",
          channels: [
            {
              id: "one",
              name: "Nadia",
              category: "Creative",
              href: "#nadia",
              live: true,
              viewers: 1284,
              accent: "red",
            },
          ],
          moreLink: { label: "Show all 38 followed", href: "#following" },
        },
      ]}
      callout="Counts show verified viewers."
    />
  ),
};
export const SectionNavStory: Story = {
  name: "SectionNav",
  render: () => (
    <SectionNav
      label="Settings sections"
      heading="Settings"
      items={nav}
      action={<Button variant="outline">New</Button>}
    />
  ),
};
export const PageLayoutsStory: Story = {
  name: "PageLayout",
  render: () => (
    <PageContainer>
      <SplitLayout
        main={
          <ResponsiveGrid cols={3}>
            {[1, 2, 3].map((n) => (
              <div key={n} className="border p-4">
                Card {n}
              </div>
            ))}
          </ResponsiveGrid>
        }
        aside={<div className="border p-4">Sidebar</div>}
      />
    </PageContainer>
  ),
};
export const Light: Story = { ...AppShellStory, globals: { theme: "light" } };
export const SiteHeaderMobileMenuOpen: Story = {
  name: "SiteHeader Mobile320 menu open",
  render: () => (
    <SiteHeader
      brand={header.props.brand}
      nav={nav}
      navLabel="Main navigation"
      menuLabel="Open navigation"
      mobileMenuOpen
    />
  ),
  globals: { viewport: { value: "mobile320" } },
};

/** `context` after the brand: the studio and admin headers ("Creator studio", "Admin"). */
export const SiteHeaderWithContext: Story = {
  name: "SiteHeader with context",
  render: () => (
    <SiteHeader
      brand={header.props.brand}
      context={{ label: "Creator studio", href: "#studio" }}
      nav={[]}
      navLabel="Creator studio"
      menuLabel="Open navigation"
    />
  ),
};
export const SiteHeaderWithContextLight: Story = {
  ...SiteHeaderWithContext,
  name: "SiteHeader with context Light",
  globals: { theme: "light" },
};
export const SiteHeaderWithContextMobile320: Story = {
  ...SiteHeaderWithContext,
  name: "SiteHeader with context Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const AppShellLight: Story = { ...AppShellStory, name: "AppShell Light", globals: { theme: "light" } };
export const AppShellMobile320: Story = {
  ...AppShellStory,
  name: "AppShell Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const AppShellWithChannelSidebarLight: Story = {
  ...AppShellWithChannelSidebar,
  name: "AppShellWithChannelSidebar Light",
  globals: { theme: "light" },
};
export const AppShellWithChannelSidebarMobile320: Story = {
  ...AppShellWithChannelSidebar,
  name: "AppShellWithChannelSidebar Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const StudioShellLight: Story = { ...StudioShellStory, name: "StudioShell Light", globals: { theme: "light" } };
export const StudioShellMobile320: Story = {
  ...StudioShellStory,
  name: "StudioShell Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const AdminShellLight: Story = { ...AdminShellStory, name: "AdminShell Light", globals: { theme: "light" } };
export const AdminShellMobile320: Story = {
  ...AdminShellStory,
  name: "AdminShell Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const SiteHeaderLight: Story = { ...SiteHeaderStory, name: "SiteHeader Light", globals: { theme: "light" } };
export const SiteHeaderMobile320: Story = {
  ...SiteHeaderStory,
  name: "SiteHeader Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const HeaderSearchLight: Story = {
  ...HeaderSearchStory,
  name: "HeaderSearch Light",
  globals: { theme: "light" },
};
export const HeaderSearchMobile320: Story = {
  ...HeaderSearchStory,
  name: "HeaderSearch Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const UserMenuLight: Story = { ...UserMenuStory, name: "UserMenu Light", globals: { theme: "light" } };
export const UserMenuMobile320: Story = {
  ...UserMenuStory,
  name: "UserMenu Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const SiteFooterLight: Story = { ...SiteFooterStory, name: "SiteFooter Light", globals: { theme: "light" } };
export const SiteFooterMobile320: Story = {
  ...SiteFooterStory,
  name: "SiteFooter Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const ChannelSidebarLight: Story = {
  ...ChannelSidebarStory,
  name: "ChannelSidebar Light",
  globals: { theme: "light" },
};
export const ChannelSidebarMobile320: Story = {
  ...ChannelSidebarStory,
  name: "ChannelSidebar Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const SectionNavLight: Story = { ...SectionNavStory, name: "SectionNav Light", globals: { theme: "light" } };
export const SectionNavMobile320: Story = {
  ...SectionNavStory,
  name: "SectionNav Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const PageLayoutsLight: Story = { ...PageLayoutsStory, name: "PageLayouts Light", globals: { theme: "light" } };
export const PageLayoutsMobile320: Story = {
  ...PageLayoutsStory,
  name: "PageLayouts Mobile320",
  globals: { viewport: { value: "mobile320" } },
};
