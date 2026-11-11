// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, formatMoney, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { monthCosts, monthLabel, type TransparencyMonthDto } from "../../lib/money.ts";
import { ResponsiveRows, type StackedRow } from "../studio/stacked-rows.tsx";

/**
 * The books by month (coop-trust P3.5): a table from `sm`, stacked rows below it (one row per
 * month with its surplus or shortfall on the row), so no money column is clipped at 320 px. The
 * table rows keep the harness's `transparency-month-row` and its raw cents.
 */
export function MonthTable({
  months,
  currency,
}: {
  months: readonly TransparencyMonthDto[];
  currency: string;
}): React.JSX.Element {
  const { locale } = useLocale();
  const money = (cents: number) => <MoneyAmount value={{ cents, currency }} colorNegative />;
  const net = (cents: number) => t("d6Transparency.months.net", { sign: cents < 0 ? "negative" : "other" });
  const columns: DataTableColumn<TransparencyMonthDto>[] = [
    {
      id: "month",
      header: t("transparency.month"),
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span>{monthLabel(row.original.month)}</span>
          {row.original.note && (
            <span className="text-xs text-muted-foreground">{t("d6Transparency.months.noted")}</span>
          )}
        </span>
      ),
    },
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
  const stacked: StackedRow[] = months.map((m) => ({
    id: m.month,
    title: monthLabel(m.month),
    value: (
      <span className="flex flex-col items-end">
        <span className="text-xs text-muted-foreground">{net(m.surplus.cents)}</span>
        {money(m.surplus.cents)}
      </span>
    ),
    details: (
      <>
        <span>
          {t("d6Transparency.months.detail", {
            revenue: formatMoney(m.revenue.cents, currency, locale),
            payouts: formatMoney(m.streamerPayouts.cents, currency, locale),
            costs: formatMoney(monthCosts(m), currency, locale),
          })}
        </span>
        {m.note && <span>{t("d6Transparency.months.noted")}</span>}
      </>
    ),
    attributes: { "data-testid": "transparency-month-card", "data-month": m.month, "data-surplus": m.surplus.cents },
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("d6Transparency.months.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveRows
          label={t("d6Transparency.months.title")}
          rows={stacked}
          table={
            <DataTable
              caption={t("d6Transparency.months.title")}
              columns={columns}
              rows={[...months]}
              getRowId={(m) => m.month}
              rowProps={(m) => ({
                "data-testid": "transparency-month-row",
                "data-month": m.month,
                "data-revenue": m.revenue.cents,
                "data-payouts": m.streamerPayouts.cents,
                "data-costs": monthCosts(m),
                "data-surplus": m.surplus.cents,
                "data-patronage": m.patronageDistributed.cents,
                "data-noted": m.note ? "true" : "false",
              })}
            />
          }
        />
      </CardContent>
    </Card>
  );
}
