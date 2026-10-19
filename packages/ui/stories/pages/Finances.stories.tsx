// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { ApiIcon, Download01Icon, Invoice01Icon, Message01Icon } from "@hugeicons/core-free-icons";
import { MoneyAmount, StatusBadge } from "@commonair/ui";
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
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import {
  DataTable,
  FilterBar,
  ProgressList,
  ProgressRow,
  StatCard,
  StatGrid,
  TrendChart,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import {
  budget,
  intro,
  kpis,
  ledgerClosed,
  monthly,
  periodLabels,
  periods,
  queries,
  reserves,
  statement,
  tabs,
  type Period,
  type StatementRow,
} from "./fixtures/Finances.ts";
import { FigureValue, moneyText, noteText } from "./money.tsx";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Platform/Finances", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const statementColumns: DataTableColumn<StatementRow>[] = [
  { id: "line", header: "Line", accessorKey: "line" },
  {
    id: "amount",
    header: "Amount",
    align: "numeric",
    cell: ({ row }) =>
      row.original.cents === null ? (
        "—"
      ) : (
        <MoneyAmount value={{ cents: row.original.cents, currency: "USD" }} locale="en-US" />
      ),
  },
  { id: "share", header: "% of gross", accessorKey: "share", align: "numeric" },
  {
    id: "source",
    header: () => <span className="sr-only">Source</span>,
    cell: ({ row }) =>
      row.original.source ? <a href={row.original.source.href}>{row.original.source.label}</a> : null,
  },
];

function FinancesPage(): React.JSX.Element {
  const [period, setPeriod] = React.useState<Period>("month");
  return (
    <ViewerPage>
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader title="Platform finances" description={intro} tabs={<PageTabs variant="default" items={tabs} />} />
        <FilterBar
          toggleLabel="Period"
          toggleValue={period}
          toggleOptions={periods}
          onToggleChange={(value) => value && setPeriod(value as Period)}
          actions={
            <>
              <StatusBadge tone="neutral">{ledgerClosed}</StatusBadge>
              <div className="flex flex-wrap gap-2 sm:ms-auto">
                <Button variant="outline" size="sm">
                  <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
                  CSV
                </Button>
                <Button variant="outline" size="sm">
                  <HugeiconsIcon icon={ApiIcon} aria-hidden="true" />
                  JSON API
                </Button>
                <Button variant="outline" size="sm">
                  <HugeiconsIcon icon={Invoice01Icon} aria-hidden="true" />
                  Audited statements
                </Button>
              </div>
            </>
          }
        />
        <StatGrid cols={3}>
          {kpis[period].map((kpi) => (
            <StatCard
              key={kpi.label}
              label={kpi.label}
              value={<FigureValue value={kpi.value} />}
              hint={kpi.up ? undefined : noteText(kpi.note)}
              delta={kpi.up ? { direction: "up", label: noteText(kpi.note), sentiment: "positive" } : undefined}
            />
          ))}
        </StatGrid>
        <Card>
          <CardHeader>
            <CardTitle>Platform income vs. operating expenses, by month</CardTitle>
            <CardDescription>
              Income is what the co-op keeps after creator payouts and payment processing. Creator money passes through
              and is shown separately below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart
              type="bar"
              grouped
              data={monthly}
              xKey="month"
              series={[
                { key: "income", label: "Income ($K)", color: "--chart-2" },
                { key: "expenses", label: "Expenses ($K)", color: "--chart-5" },
              ]}
              ariaLabel="Monthly income rose from 14 to 33 thousand dollars over 12 months; expenses rose from 17 to 24 thousand, crossing below income in March"
            />
          </CardContent>
        </Card>
        <SplitLayout
          asideWidth="lg"
          main={
            <Section heading="Income statement" description={periodLabels[period]}>
              <DataTable
                caption="Income statement"
                columns={statementColumns}
                rows={statement}
                getRowId={(row) => row.id}
                groupBy={(row) => row.group}
              />
            </Section>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>2026 budget vs. actual</CardTitle>
                  <CardDescription>
                    Budget approved by members, proposal #38. Overspend over 10% on any line needs a council sign-off,
                    logged here.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ProgressList
                    rows={budget.map((line) => ({
                      label: line.label,
                      value: line.percent,
                      valueText: `${moneyText(line.actual)} of ${moneyText(line.target)}`,
                      tone: line.tone,
                      note: noteText(line.note),
                      noteTone: line.tone,
                    }))}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Reserves</CardTitle>
                  <CardAction>
                    <StatusBadge tone="warning">Below target</StatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <ProgressRow
                    label={reserves.months}
                    value={reserves.percent}
                    valueText={moneyText(reserves.amount)}
                    tone="warning"
                    minLabel="0"
                    maxLabel={noteText(reserves.target)}
                  />
                  <p>{noteText(reserves.note)}</p>
                </CardContent>
              </Card>
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <HugeiconsIcon icon={Message01Icon} aria-hidden="true" />
                    Question a number
                  </CardTitle>
                  <CardDescription>{queries.text}</CardDescription>
                </CardHeader>
                <CardFooter className="justify-between gap-2">
                  <Button variant="outline" size="sm">
                    Open a query
                  </Button>
                  <span className="tabular-nums">{queries.counts}</span>
                </CardFooter>
              </Card>
            </div>
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <FinancesPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
