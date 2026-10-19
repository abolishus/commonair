// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { BankIcon, Download01Icon, Invoice01Icon } from "@hugeicons/core-free-icons";
import { MoneyAmount, StatusBadge, formatMoney } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@commonair/ui/components/item";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import {
  BreakdownBar,
  DataTable,
  FilterBar,
  StatCard,
  StatGrid,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import { balances, bySource, ledger, months, payout, subscribers, type LedgerRow } from "./fixtures/Revenue.ts";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/Revenue", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const usd = (cents: number): React.JSX.Element => <MoneyAmount value={{ cents, currency: "USD" }} locale="en-US" />;
const optionalUsd = (cents: number | null): React.ReactNode => (cents === null ? "—" : usd(cents));

const ledgerColumns: DataTableColumn<LedgerRow>[] = [
  { id: "date", header: "Date", accessorKey: "date" },
  { id: "type", header: "Type", cell: ({ row }) => <StatusBadge tone={row.original.tone}>{row.original.type}</StatusBadge> },
  { id: "from", header: "From", accessorKey: "from" },
  { id: "gross", header: "Gross", align: "numeric", cell: ({ row }) => optionalUsd(row.original.gross) },
  { id: "fees", header: "Fees & co-op", align: "numeric", cell: ({ row }) => optionalUsd(row.original.fees) },
  {
    id: "net",
    header: "Net to you",
    align: "numeric",
    cell: ({ row }) => <MoneyAmount value={{ cents: row.original.net, currency: "USD" }} locale="en-US" colorNegative />,
  },
];

const tierColumns: DataTableColumn<(typeof subscribers.tiers)[number]>[] = [
  { id: "tier", header: "Tier", accessorKey: "tier" },
  { id: "subs", header: "Subs", accessorKey: "subs", align: "numeric" },
  { id: "share", header: "Your share / mo", align: "numeric", cell: ({ row }) => usd(row.original.share) },
];

function RevenuePage(): React.JSX.Element {
  const [month, setMonth] = React.useState("2026-10");
  return (
    <StudioPage current="revenue">
      <PageContainer className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Revenue"
          actions={
            <FilterBar filters={[{ id: "revenue-month", label: "Month", value: month, options: months, onValueChange: setMonth }]} />
          }
        />
        <StatGrid cols={3}>
          <StatCard label="Available balance" value={usd(balances.available.cents)} hint={balances.available.hint} />
          <StatCard
            label="Earned this month"
            value={usd(balances.earned.cents)}
            delta={{ direction: "up", label: balances.earned.delta, sentiment: "positive" }}
          />
          <StatCard
            label="Patronage (estimated)"
            value={usd(balances.patronage.cents)}
            hint={
              <>
                {balances.patronage.hint} <a href="#transparency">How it’s calculated</a>
              </>
            }
          />
        </StatGrid>
        <ResponsiveGrid cols={2}>
          <Card>
            <CardHeader>
              <CardTitle>By source</CardTitle>
            </CardHeader>
            <CardContent>
              <BreakdownBar
                label="Revenue by source"
                segments={bySource}
                formatValue={(cents) => formatMoney(cents, "USD", "en-US")}
                formatLabel={(segments, shares) =>
                  segments.map((segment, index) => `${segment.label} ${shares[index] ?? 0}%`).join(", ")
                }
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Active subscribers</CardTitle>
              <CardAction>
                <StatusBadge tone="neutral">{subscribers.total}</StatusBadge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <DataTable caption="Active subscribers by tier" columns={tierColumns} rows={subscribers.tiers} />
            </CardContent>
          </Card>
        </ResponsiveGrid>
        <Section
          heading="Ledger"
          description="Append-only; every entry balances."
          action={
            <Button variant="outline" size="sm">
              <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
              Statement (CSV)
            </Button>
          }
        >
          <DataTable caption="Ledger" columns={ledgerColumns} rows={ledger} getRowId={(row) => row.id} />
        </Section>
        <Card>
          <CardHeader>
            <CardTitle>Payout method</CardTitle>
            <CardDescription>Paid monthly once your balance reaches the minimum.</CardDescription>
            <CardAction>
              <Button variant="outline" size="sm">
                Change
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ResponsiveGrid cols={2}>
              {payout.map((method) => (
                <Item key={method.id} variant="outline">
                  <ItemMedia variant="icon">
                    <HugeiconsIcon icon={method.id === "bank" ? BankIcon : Invoice01Icon} aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{method.title}</ItemTitle>
                    <ItemDescription>{method.description}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ResponsiveGrid>
          </CardContent>
        </Card>
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <RevenuePage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
