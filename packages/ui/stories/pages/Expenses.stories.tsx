// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Pdf01Icon } from "@hugeicons/core-free-icons";
import { MoneyAmount, StatusBadge, formatMoney } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import {
  BreakdownBar,
  DataTable,
  FilterBar,
  KeyValueList,
  ListPanel,
  ProgressList,
  StatCard,
  StatGrid,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import {
  commitments,
  costBases,
  foss,
  intro,
  invoices,
  payRatio,
  runRate,
  services,
  servicesNote,
  stats,
  tabs,
  viewerHour,
  wages,
  type CostBasis,
  type Service,
} from "./fixtures/Expenses.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Platform/Expenses", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const usd = (cents: number): React.JSX.Element => <MoneyAmount value={{ cents, currency: "USD" }} locale="en-US" />;

const deltaTone = (delta: string): "success" | "danger" | "neutral" =>
  delta.startsWith("+") ? "danger" : delta.startsWith("−") ? "success" : "neutral";

function serviceColumns(basis: CostBasis): DataTableColumn<Service>[] {
  return [
    { id: "name", header: "Service", accessorKey: "name" },
    { id: "runs", header: "Runs", accessorKey: "runs" },
    { id: "billing", header: "Billed by", accessorKey: "billing" },
    { id: "usage", header: "Usage (30 d)", accessorKey: "usage", align: "numeric" },
    { id: "unit", header: "Unit price", accessorKey: "unitPrice", align: "numeric" },
    {
      id: "cost",
      header: basis === "unit" ? "Cost / 1K viewer-h" : "Cost / month",
      align: "numeric",
      // Per-unit costs are fractions of a cent, so the fixture carries them pre-formatted.
      cell: ({ row }) => (basis === "unit" ? row.original.unitCost : usd(row.original.monthlyCents)),
    },
    {
      id: "delta",
      header: "vs. last month",
      align: "numeric",
      cell: ({ row }) => <StatusBadge tone={deltaTone(row.original.delta)}>{row.original.delta}</StatusBadge>,
    },
    {
      id: "invoice",
      header: () => <span className="sr-only">Invoice</span>,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="xs"
          render={<a href={`#invoice/${row.original.id}`} aria-label={`Invoice for ${row.original.name}`} />}
          nativeButton={false}
        >
          <HugeiconsIcon icon={Pdf01Icon} aria-hidden="true" />
          PDF
        </Button>
      ),
    },
  ];
}

const wageColumns: DataTableColumn<(typeof wages)[number]>[] = [
  { id: "role", header: "Role", accessorKey: "role" },
  { id: "fte", header: "FTE", accessorKey: "fte", align: "numeric" },
  { id: "band", header: "Annual band", accessorKey: "band", align: "numeric" },
];

function ExpensesPage(): React.JSX.Element {
  const [basis, setBasis] = React.useState<CostBasis>("month");
  return (
    <ViewerPage>
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader title="Service expenses" description={intro} tabs={<PageTabs variant="default" items={tabs} />} />
        <StatGrid cols={4}>
          {stats.map((stat) => (
            <StatCard
              key={stat.label}
              label={stat.label}
              value={stat.value}
              hint={stat.hint}
              delta={stat.delta ? { direction: "up", label: stat.delta, sentiment: "positive" } : undefined}
            />
          ))}
        </StatGrid>
        <Card>
          <CardHeader>
            <CardTitle>Where the monthly run rate goes</CardTitle>
          </CardHeader>
          <CardContent>
            <BreakdownBar
              label="Monthly run rate by category"
              segments={runRate}
              legendLayout="inline"
              formatValue={(value) => `${value}%`}
              formatLabel={(segments, shares) =>
                segments.map((segment, index) => `${segment.label} ${shares[index] ?? 0}%`).join(", ")
              }
            />
          </CardContent>
        </Card>
        <Section
          heading="Infrastructure services"
          action={
            <FilterBar
              toggleLabel="Show cost as"
              toggleValue={basis}
              toggleOptions={costBases}
              onToggleChange={(value) => value && setBasis(value as CostBasis)}
            />
          }
        >
          <DataTable
            caption="Infrastructure services"
            columns={serviceColumns(basis)}
            rows={services}
            getRowId={(row) => row.id}
          />
          <p>
            {servicesNote} <a href="#finances">Overview</a>
          </p>
        </Section>
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>What one hour of watching costs us</CardTitle>
                  <CardDescription>
                    Per verified viewer-hour, October average. Falls as relays carry more traffic.
                  </CardDescription>
                  <CardAction>
                    <StatusBadge tone="neutral">{viewerHour.total}</StatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <ProgressList
                    rows={viewerHour.parts.map((part) => ({
                      label: part.label,
                      value: part.percent,
                      valueText: part.value,
                    }))}
                  />
                </CardContent>
                <CardFooter>{viewerHour.streamedHour}</CardFooter>
              </Card>
              <ListPanel
                variant="bare"
                title="Latest invoices"
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    render={<a href="#invoices" aria-label="All 214 invoices" />}
                    nativeButton={false}
                  >
                    All 214 invoices
                  </Button>
                }
                items={invoices.map((invoice) => ({
                  id: invoice.id,
                  media: <span className="tabular-nums">{invoice.date}</span>,
                  title: invoice.title,
                  description: `Approved by ${invoice.approvedBy}`,
                  actions: (
                    <>
                      {usd(invoice.cents)}
                      <Button
                        variant="ghost"
                        size="xs"
                        render={<a href={`#invoice/${invoice.id}`} aria-label={`Invoice PDF for ${invoice.title}`} />}
                        nativeButton={false}
                      >
                        PDF
                      </Button>
                    </>
                  ),
                }))}
              />
            </div>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Wages by role</CardTitle>
                  <CardDescription>
                    Worker members set pay bands by vote. Highest-to-lowest pay ratio is capped at 2:1.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DataTable caption="Wages by role" columns={wageColumns} rows={wages} getRowId={(row) => row.id} />
                </CardContent>
                <CardFooter>{payRatio}</CardFooter>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Commitments</CardTitle>
                </CardHeader>
                <CardContent>
                  <ItemGroup>
                    {commitments.map((commitment) => (
                      <Item key={commitment.id} variant="outline" size="sm">
                        <ItemContent>
                          <ItemTitle>{commitment.title}</ItemTitle>
                          <ItemDescription>{commitment.detail}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span className="tabular-nums">{commitment.amount}</span>
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Upstream FOSS we fund</CardTitle>
                  <CardDescription>
                    1.5% of platform income, split by how much of our stack each project carries.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <KeyValueList
                    rows={foss.map((row) => ({ term: row.term, value: formatMoney(row.cents, "USD", "en-US") }))}
                  />
                </CardContent>
              </Card>
            </div>
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <ExpensesPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
