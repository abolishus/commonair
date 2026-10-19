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
    <StudioShell header={header} groups={groups} sidebarLabel="Studio navigation">
      <p>Studio content</p>
    </StudioShell>
  ),
};
export const AdminShellStory: Story = {
  name: "AdminShell",
  render: () => (
    <AdminShell header={header} groups={groups} sidebarLabel="Administration navigation">
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
export const Mobile320: Story = {
  name: "SiteHeader mobile menu open",
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
