// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import {
  DataTable,
  FilterBar,
  ProgressList,
  StatCard,
  StatGrid,
  TrendChart,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import {
  integrity,
  metrics,
  ranges,
  sources,
  stats,
  streams,
  viewersByDay,
  type StreamRow,
} from "./fixtures/Analytics.ts";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/Analytics", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const streamColumns: DataTableColumn<StreamRow>[] = [
  { id: "date", header: "Date", accessorKey: "date" },
  { id: "title", header: "Title", accessorKey: "title" },
  { id: "duration", header: "Duration", accessorKey: "duration", align: "numeric" },
  { id: "avg", header: "Avg", accessorKey: "avg", align: "numeric" },
  { id: "peak", header: "Peak", accessorKey: "peak", align: "numeric" },
  { id: "followers", header: "Followers", accessorKey: "followers", align: "numeric" },
  { id: "messages", header: "Chat msgs", accessorKey: "messages", align: "numeric" },
];

const reasonColumns: DataTableColumn<(typeof integrity.reasons)[number]>[] = [
  { id: "reason", header: "Reason", accessorKey: "reason" },
  { id: "sessions", header: "Sessions", accessorKey: "sessions", align: "numeric" },
];

function AnalyticsPage(): React.JSX.Element {
  const [range, setRange] = React.useState("30");
  const [metric, setMetric] = React.useState("avg");
  return (
    <StudioPage current="analytics">
      <PageContainer className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Analytics"
          actions={
            <>
              <FilterBar toggleLabel="Range" toggleValue={range} toggleOptions={ranges} onToggleChange={setRange} />
              <Button variant="outline" size="sm">
                <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
                Export CSV
              </Button>
            </>
          }
        />
        <StatGrid cols={6}>
          {stats.map((stat) => (
            <StatCard
              key={stat.label}
              label={stat.label}
              value={stat.value}
              hint={stat.hint}
              delta={
                stat.delta
                  ? {
                      direction: stat.down ? "down" : "up",
                      label: stat.delta,
                      sentiment: stat.down ? "negative" : "positive",
                    }
                  : undefined
              }
            />
          ))}
        </StatGrid>
        <Card>
          <CardHeader>
            <CardTitle>Average verified viewers per stream day</CardTitle>
            <CardDescription>Traffic flagged by integrity checks is never counted.</CardDescription>
            <CardAction>
              <FilterBar
                filters={[
                  {
                    id: "analytics-metric",
                    label: "Metric",
                    value: metric,
                    options: metrics,
                    onValueChange: setMetric,
                  },
                ]}
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            <TrendChart
              type="bar"
              data={viewersByDay}
              xKey="day"
              series={[{ key: "viewers", label: "Average viewers", color: "--chart-1" }]}
              ariaLabel="Bar chart of average viewers over 30 days, rising from about 200 to about 340"
            />
          </CardContent>
        </Card>
        <ResponsiveGrid cols={2}>
          <Card>
            <CardHeader>
              <CardTitle>Where viewers came from</CardTitle>
            </CardHeader>
            <CardContent>
              <ProgressList
                rows={sources.map((source) => ({
                  label: source.label,
                  value: source.percent,
                  valueText: `${source.percent}%`,
                }))}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={Shield01Icon} aria-hidden="true" />
                Integrity
              </CardTitle>
              <CardDescription>Sessions excluded from your counts, and why.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <StatCard size="sm" label="Sessions excluded" value={integrity.share} hint={integrity.hint} />
              <DataTable caption="Excluded sessions by reason" columns={reasonColumns} rows={integrity.reasons} />
              <p>
                Think something was excluded by mistake? <a href="#appeal">Open an appeal</a>.
              </p>
            </CardContent>
          </Card>
        </ResponsiveGrid>
        <Section heading="Streams in this period">
          <DataTable caption="Streams in this period" columns={streamColumns} rows={streams} sortable />
        </Section>
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <AnalyticsPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
