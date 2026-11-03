// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppShell, ChannelSidebar, SiteFooter, SiteHeader } from "@commonair/ui/layouts";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";

/**
 * D4 (F16): the skip link is the first thing Tab reaches, before the header and the sidebar. Click
 * into the frame and press Tab once: "Skip to content" appears top-start in both variants. Check
 * dark and light (toolbar) and 320 px and 1440 px (viewport).
 */
const meta = { title: "Layouts/Skip link", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj;

const header = (
  <SiteHeader
    brand={{ mark: <span aria-hidden>●</span>, name: "CommonAir", href: "#home" }}
    nav={[
      { id: "browse", label: "Browse", href: "#browse", current: true },
      { id: "coop", label: "Co-op", href: "#coop" },
    ]}
    navLabel="Main navigation"
    menuLabel="Open navigation"
  />
);
const footer = <SiteFooter instanceName="CommonAir" links={[{ label: "About", href: "#about" }]} license="AGPL-3.0" />;
const body = (
  <PageContainer>
    <PageHeader title="Browse" description="Press Tab once: the skip link comes first." />
  </PageContainer>
);

export const WithoutSidebar: Story = {
  name: "Without sidebar (public pages)",
  render: () => (
    <AppShell header={header} footer={footer} skipLabel="Skip to content">
      {body}
    </AppShell>
  ),
};

export const WithSidebar: Story = {
  name: "With sidebar (studio and admin)",
  render: () => (
    <AppShell
      header={header}
      sidebar={<ChannelSidebar label="Followed channels" groups={[]} />}
      footer={footer}
      skipLabel="Skip to content"
    >
      {body}
    </AppShell>
  ),
};

export const LongLabel: Story = {
  name: "Long label (translated)",
  render: () => (
    <AppShell header={header} footer={footer} skipLabel="Saltar al contenido principal de esta página">
      {body}
    </AppShell>
  ),
};
