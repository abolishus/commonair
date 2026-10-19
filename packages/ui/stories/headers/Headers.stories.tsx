// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@commonair/ui/components/button";
import { Breadcrumbs, PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
const meta = { title: "Blocks/Headers", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj;
const crumbs = (
  <Breadcrumbs
    label="Breadcrumbs"
    items={[{ label: "Home", href: "#home" }, { label: "Settings", href: "#settings" }, { label: "Account" }]}
  />
);
const tabs = (
  <PageTabs
    items={[
      { id: "overview", label: "Overview", current: true, href: "#overview" },
      { id: "activity", label: "Activity", href: "#activity", count: 8 },
    ]}
  />
);
export const PageHeaderStory: Story = {
  name: "PageHeader",
  render: () => (
    <PageHeader
      title="Channel settings"
      description="Manage your channel and account."
      breadcrumbs={crumbs}
      tabs={tabs}
      actions={<Button>Save changes</Button>}
      meta="Updated just now"
    />
  ),
};
export const CompactPageHeader: Story = {
  name: "PageHeader compact",
  render: () => <PageHeader title="Analytics" size="compact" description="Your recent performance." />,
};
export const SectionStory: Story = {
  name: "Section",
  render: () => (
    <Section
      heading="Recent activity"
      description="Your latest updates."
      action={<Button variant="ghost">Show all</Button>}
    >
      <p>Activity content</p>
    </Section>
  ),
};
export const BreadcrumbStory: Story = {
  name: "Breadcrumbs",
  render: () => (
    <Breadcrumbs
      label="Breadcrumbs"
      items={["Home", "Category", "Games", "Live", "Channel"].map((label) => ({
        label,
        href: `#${label.toLowerCase()}`,
      }))}
    />
  ),
};
export const PageTabsStory: Story = { name: "PageTabs", render: () => tabs };
export const Light: Story = { ...PageHeaderStory, globals: { theme: "light" } };
export const Mobile320: Story = { ...PageHeaderStory, globals: { viewport: { value: "mobile320" } } };
