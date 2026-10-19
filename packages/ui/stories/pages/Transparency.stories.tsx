// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, Radio02Icon, Shield01Icon, Tick01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { MoneyAmount, formatMoney } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia } from "@commonair/ui/components/item";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import {
  BreakdownBar,
  DataTable,
  FilterBar,
  MetricPanel,
  StatCard,
  StatGrid,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import { CodeBlock } from "@commonair/ui/blocks/forms";
import { flow, formula, formulaNotes, intro, metrics, periods, statement, stats } from "./fixtures/Transparency.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Transparency", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const usd = (cents: number): React.JSX.Element => <MoneyAmount value={{ cents, currency: "USD" }} locale="en-US" />;

const statementColumns: DataTableColumn<(typeof statement)[number]>[] = [
  { id: "line", header: "Line", accessorKey: "line" },
  { id: "basis", header: "Basis", accessorKey: "basis", align: "numeric" },
  {
    id: "amount",
    header: "Amount",
    align: "numeric",
    cell: ({ row }) => <MoneyAmount value={{ cents: row.original.cents, currency: "USD" }} locale="en-US" />,
  },
];

const metricIcons = { integrity: Shield01Icon, relays: Radio02Icon, safety: UserGroupIcon } as const;

function TransparencyPage(): React.JSX.Element {
  const [period, setPeriod] = React.useState("2026-q3");
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Transparency"
          description={intro}
          actions={
            <>
              <FilterBar
                filters={[
                  {
                    id: "transparency-period",
                    label: "Period",
                    value: period,
                    options: periods,
                    onValueChange: setPeriod,
                  },
                ]}
              />
              <Button variant="outline" size="sm">
                <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
                Download ledger
              </Button>
            </>
          }
        />
        <StatGrid cols={4}>
          {stats.map((stat) => (
            <StatCard key={stat.label} label={stat.label} value={usd(stat.cents)} hint={stat.hint} />
          ))}
        </StatGrid>
        <Card>
          <CardHeader>
            <CardTitle>Where every dollar went</CardTitle>
            <CardDescription>From the append-only ledger. Each line links to its journal entries.</CardDescription>
          </CardHeader>
          <CardContent>
            <BreakdownBar
              label="Where every dollar went"
              segments={flow}
              formatValue={(cents) => formatMoney(cents, "USD", "en-US")}
              formatLabel={(segments, shares) =>
                segments.map((segment, index) => `${segment.label} ${shares[index] ?? 0}%`).join(", ")
              }
            />
          </CardContent>
        </Card>
        <ResponsiveGrid cols={2}>
          <Card>
            <CardHeader>
              <CardTitle>Patronage formula · v3</CardTitle>
              <CardDescription>Adopted by proposal #41. Versioned; old statements keep their version.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <CodeBlock
                value={formula}
                wrap={false}
                label="Copy formula"
                copiedLabel="Formula copied"
                copyFailedLabel="Could not copy the formula"
              />
              <ItemGroup>
                {formulaNotes.map((note) => (
                  <Item key={note} size="xs">
                    <ItemMedia variant="icon">
                      <HugeiconsIcon icon={Tick01Icon} aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemDescription>{note}</ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </CardContent>
          </Card>
          <Card data-accent="violet">
            <CardHeader>
              <CardTitle>Your statement (preview)</CardTitle>
              <CardDescription>Only you see this card.</CardDescription>
              <CardAction>
                <Button variant="outline" size="xs">
                  PDF
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <DataTable
                caption="Your patronage statement"
                columns={statementColumns}
                rows={statement}
                getRowId={(row) => row.id}
              />
            </CardContent>
          </Card>
        </ResponsiveGrid>
        <ResponsiveGrid cols={3}>
          {metrics.map((metric) => (
            <MetricPanel
              key={metric.id}
              icon={<HugeiconsIcon icon={metricIcons[metric.id as keyof typeof metricIcons]} aria-hidden="true" />}
              title={metric.title}
              value={metric.value}
              caption={metric.caption}
              body={metric.body}
            />
          ))}
        </ResponsiveGrid>
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <TransparencyPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
