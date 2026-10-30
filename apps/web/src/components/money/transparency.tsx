// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, MoneyAmount, formatMoney, useLocale } from "@commonair/ui";
import {
  BreakdownBar,
  DataTable,
  MetricPanel,
  StatCard,
  StatGrid,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { ResponsiveGrid } from "@commonair/ui/layouts";
import { PieChartIcon, Radio02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  egressShare,
  monthCosts,
  monthLabel,
  transparencyFlow,
  transparencyTotals,
  type TransparencyMonthDto,
} from "../../lib/money.ts";
import { formatBytes } from "../../lib/relays.ts";
import { CoopTransparency } from "../coop/transparency.tsx";
import { FeeSchedule } from "./fee-schedule.tsx";

/**
 * `/transparency` pieces (Transparency board) for the months shown, with the co-op's governance
 * outcomes and patronage distributed per month (E5, `CoopTransparency`).
 */

export function TransparencyEmpty(): React.JSX.Element {
  return (
    <EmptyState
      data-testid="transparency-empty"
      icon={PieChartIcon}
      title={t("transparency.empty")}
      description={t("transparency.emptyHint")}
    />
  );
}

export function TransparencyReport({ months }: { months: TransparencyMonthDto[] }): React.JSX.Element {
  const { locale } = useLocale();
  const first = months[0];
  if (!first)
    return (
      <>
        <TransparencyEmpty />
        <FeeSchedule />
      </>
    );
  const totals = transparencyTotals(months, first.revenue.currency);
  const money = (cents: number) => <MoneyAmount value={{ cents, currency: totals.currency }} colorNegative />;
  const stats = [
    {
      id: "revenue",
      label: t("transparency.stat.revenue"),
      hint: t("transparency.stat.revenueHint"),
      cents: totals.revenue,
    },
    {
      id: "payouts",
      label: t("transparency.stat.payouts"),
      hint: t("transparency.stat.payoutsHint"),
      cents: totals.payouts,
    },
    { id: "costs", label: t("transparency.stat.costs"), hint: t("transparency.stat.costsHint"), cents: totals.costs },
    {
      id: "surplus",
      label: t("transparency.stat.surplus"),
      hint: t("transparency.stat.surplusHint"),
      cents: totals.surplus,
    },
  ];
  const egress = egressShare(months);
  const columns: DataTableColumn<TransparencyMonthDto>[] = [
    { id: "month", header: t("transparency.month"), cell: ({ row }) => monthLabel(row.original.month) },
    {
      id: "revenue",
      header: t("transparency.stat.revenue"),
      align: "numeric",
      cell: ({ row }) => money(row.original.revenue.cents),
    },
    {
      id: "payouts",
      header: t("transparency.stat.payouts"),
      align: "numeric",
      cell: ({ row }) => money(row.original.streamerPayouts.cents),
    },
    {
      id: "costs",
      header: t("transparency.stat.costs"),
      align: "numeric",
      cell: ({ row }) => money(monthCosts(row.original)),
    },
    {
      id: "surplus",
      header: t("transparency.stat.surplus"),
      align: "numeric",
      cell: ({ row }) => money(row.original.surplus.cents),
    },
    {
      id: "patronage",
      header: t("transparency.patronage"),
      align: "numeric",
      cell: ({ row }) => money(row.original.patronageDistributed.cents),
    },
  ];
  return (
    <>
      <StatGrid cols={4}>
        {stats.map((stat) => (
          <StatCard
            key={stat.id}
            data-testid="transparency-stat"
            data-stat={stat.id}
            data-cents={stat.cents}
            label={stat.label}
            value={money(stat.cents)}
            hint={stat.hint}
          />
        ))}
      </StatGrid>
      <Card>
        <CardHeader>
          <CardTitle>{t("transparency.flow.title")}</CardTitle>
          <CardDescription>{t("transparency.flow.hint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <BreakdownBar
            data-testid="transparency-flow"
            label={t("transparency.flow.title")}
            segments={transparencyFlow(months)}
            formatValue={(cents) => formatMoney(cents, totals.currency, locale)}
            formatLabel={(items, shares) =>
              items
                .map((item, i) => t("money.shareLabel", { label: item.label, share: shares[i] ?? 0 }))
                .join(t("common.listSeparator"))
            }
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("transparency.monthly")}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            caption={t("transparency.monthly")}
            columns={columns}
            rows={months}
            getRowId={(m) => m.month}
            rowProps={(m) => ({
              "data-testid": "transparency-month-row",
              "data-month": m.month,
              "data-revenue": m.revenue.cents,
              "data-payouts": m.streamerPayouts.cents,
              "data-costs": monthCosts(m),
              "data-surplus": m.surplus.cents,
              "data-patronage": m.patronageDistributed.cents,
            })}
          />
        </CardContent>
      </Card>
      <CoopTransparency months={months} />
      <ResponsiveGrid cols={3}>
        <MetricPanel
          icon={<HugeiconsIcon icon={Radio02Icon} strokeWidth={2} aria-hidden />}
          title={t("transparency.egress.title")}
          value={t("transparency.egress.share", { share: egress.relayPercent })}
          caption={t("transparency.egress.caption")}
          body={t("transparency.egress.body", {
            relay: formatBytes(egress.relayBytes, locale),
            total: formatBytes(egress.totalBytes, locale),
          })}
        />
      </ResponsiveGrid>
      <FeeSchedule />
    </>
  );
}
