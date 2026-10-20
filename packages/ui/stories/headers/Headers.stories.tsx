// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
import * as React from "react";
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
function PanelTabs(): React.JSX.Element {
  const [tab, setTab] = React.useState("tip");
  return (
    <PageTabs
      aria-label="Support options"
      variant="default"
      fullWidth
      value={tab}
      onValueChange={setTab}
      afterList={
        <p id="tabs-reason" className="text-muted-foreground">
          This channel has no subscription tiers yet.
        </p>
      }
      items={[
        { id: "sub", label: "Subscribe", disabled: true, "aria-describedby": "tabs-reason" },
        { id: "gift", label: "Gift subs", disabled: true, "aria-describedby": "tabs-reason" },
        { id: "tip", label: "Tip", content: <p>Tip panel</p> },
      ]}
    />
  );
}
/** Panel mode with disabled tabs: the reason sits between the list and the panels and describes the tabs. */
export const PageTabsDisabled: Story = { name: "PageTabs disabled tabs", render: () => <PanelTabs /> };
export const PageTabsDisabledMobile320: Story = {
  ...PageTabsDisabled,
  name: "PageTabs disabled tabs Mobile320",
  globals: { viewport: { value: "mobile320" } },
};
export const Light: Story = { ...PageHeaderStory, globals: { theme: "light" } };
export const Mobile320: Story = { ...PageHeaderStory, globals: { viewport: { value: "mobile320" } } };

export const PageHeaderLight: Story = { ...PageHeaderStory, name: "PageHeader Light", globals: { theme: "light" } };
export const PageHeaderMobile320: Story = {
  ...PageHeaderStory,
  name: "PageHeader Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const CompactPageHeaderLight: Story = {
  ...CompactPageHeader,
  name: "CompactPageHeader Light",
  globals: { theme: "light" },
};
export const CompactPageHeaderMobile320: Story = {
  ...CompactPageHeader,
  name: "CompactPageHeader Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const SectionLight: Story = { ...SectionStory, name: "Section Light", globals: { theme: "light" } };
export const SectionMobile320: Story = {
  ...SectionStory,
  name: "Section Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const BreadcrumbLight: Story = { ...BreadcrumbStory, name: "Breadcrumb Light", globals: { theme: "light" } };
export const BreadcrumbMobile320: Story = {
  ...BreadcrumbStory,
  name: "Breadcrumb Mobile320",
  globals: { viewport: { value: "mobile320" } },
};

export const PageTabsLight: Story = { ...PageTabsStory, name: "PageTabs Light", globals: { theme: "light" } };
export const PageTabsMobile320: Story = {
  ...PageTabsStory,
  name: "PageTabs Mobile320",
  globals: { viewport: { value: "mobile320" } },
};
