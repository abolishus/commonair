// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusBadge } from "@commonair/ui";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { Legend, UptimeStrip } from "@commonair/ui/blocks/data";
import { IncidentCard } from "@commonair/ui/blocks/feedback";
import { components, incidents, statusLabels, summary, uptimeLegend } from "./fixtures/Status.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Platform/Status", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function StatusPage(): React.JSX.Element {
  return (
    <ViewerPage>
      <PageContainer width="narrow" className="flex flex-col gap-8 py-6">
        <PageHeader
          size="compact"
          title={summary.title}
          description={summary.text}
          meta={<StatusBadge tone="warning">Degraded</StatusBadge>}
        />
        <Section heading="Components" action={<span>90-day uptime</span>}>
          <ItemGroup>
            {components.map((component) => (
              <Item key={component.id} variant="outline" size="sm">
                <ItemContent className="min-w-32 flex-none">
                  <ItemTitle>{component.name}</ItemTitle>
                  <ItemDescription>{component.description}</ItemDescription>
                </ItemContent>
                <ItemContent className="min-w-0 flex-1">
                  <UptimeStrip
                    days={component.days}
                    label={`${component.name} daily status, last 90 days`}
                    statusLabels={statusLabels}
                  />
                </ItemContent>
                <ItemActions>
                  <span className="tabular-nums">{component.uptime}</span>
                  <StatusBadge tone={component.tone}>{component.state}</StatusBadge>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
          <Legend layout="inline" items={uptimeLegend} aria-label="Legend" />
        </Section>
        <Section heading="Incidents">
          {incidents.map((incident) => (
            <IncidentCard
              key={incident.id}
              status={incident.status}
              tone={incident.tone}
              title={incident.title}
              date={incident.date}
              note={incident.note}
              link={incident.note ? { label: "Postmortem", href: "#postmortem" } : undefined}
              updates={incident.updates}
            />
          ))}
        </Section>
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <StatusPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
