// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "By the numbers" on `/transparency` (overhaul wave 2, D2.8; growth-funnels.md P7 C): new
 * accounts, co-op members and active streamers for each of the last 12 UTC months
 * (`transparency.numbers`). The tiles show the latest month with a trend line; the table under
 * them is the full record and the text alternative. A count under the k floor reads "fewer than 5".
 */
import type * as D from "@commonair/contracts/dto";
import { GROWTH_K_FLOOR } from "@commonair/contracts/enums";
import { SkeletonGroup, SkeletonText, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn, StatGrid } from "@commonair/ui/blocks/data";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import type * as React from "react";
import type { z } from "zod";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { monthLabel } from "../../lib/money.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { flooredText, GrowthStatTile } from "../admin/growth-charts.tsx";
import { useLoad } from "../money/use-load.ts";

export type GrowthNumbersDto = z.infer<typeof D.GrowthNumbers>;
type Month = GrowthNumbersDto["months"][number];
export type LoadGrowthNumbers = () => Promise<GrowthNumbersDto>;
const defaultLoad: LoadGrowthNumbers = () => api().transparency.numbers();

const FIELDS = ["accountsCreated", "membersTotal", "activeStreamers"] as const;
type Field = (typeof FIELDS)[number];

/** The latest month that has any shown number, else the latest month. */
export function latestMonth(months: readonly Month[]): Month | null {
  for (let i = months.length - 1; i >= 0; i--) {
    const m = months[i];
    if (m && FIELDS.some((f) => m[f] !== null)) return m;
  }
  return months[months.length - 1] ?? null;
}

export function GrowthNumbersView({ numbers }: { numbers: GrowthNumbersDto }): React.JSX.Element {
  const { locale } = useLocale();
  const latest = latestMonth(numbers.months);
  const label: Record<Field, string> = {
    accountsCreated: t("d2Metrics.numbers.accounts"),
    membersTotal: t("d2Metrics.numbers.members"),
    activeStreamers: t("d2Metrics.numbers.streamers"),
  };
  const hint: Record<Field, string> = {
    accountsCreated: t("d2Metrics.numbers.accountsHint"),
    membersTotal: t("d2Metrics.numbers.membersHint"),
    activeStreamers: t("d2Metrics.numbers.streamersHint"),
  };
  const columns: DataTableColumn<Month>[] = [
    { id: "month", header: t("d2Metrics.numbers.month"), cell: ({ row }) => monthLabel(row.original.month) },
    ...FIELDS.map((f): DataTableColumn<Month> => ({
      id: f,
      header: label[f],
      align: "numeric",
      cell: ({ row }) => flooredText(row.original[f], locale),
    })),
  ];
  // Newest first in the table, oldest first along the trend lines.
  const rows = [...numbers.months].reverse();
  return (
    <div className="flex flex-col gap-4">
      {latest && (
        <StatGrid cols={3}>
          {FIELDS.map((f) => (
            <GrowthStatTile
              key={f}
              data-testid="transparency-growth-stat"
              data-stat={f}
              label={label[f]}
              hint={t("d2Metrics.numbers.inMonth", { month: monthLabel(latest.month), hint: hint[f] })}
              value={latest[f]}
              series={numbers.months.map((m) => m[f])}
            />
          ))}
        </StatGrid>
      )}
      <DataTable
        caption={t("d2Metrics.numbers.tableCaption")}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.month}
        rowProps={(r) => ({
          "data-testid": "transparency-growth-row",
          "data-month": r.month,
          "data-accounts": r.accountsCreated ?? "floored",
          "data-members": r.membersTotal ?? "floored",
          "data-streamers": r.activeStreamers ?? "floored",
        })}
      />
      <p className="text-xs text-muted-foreground">{t("d2Metrics.numbers.floorNote", { floor: GROWTH_K_FLOOR })}</p>
    </div>
  );
}

export function GrowthNumbers({ load = defaultLoad }: { load?: LoadGrowthNumbers }): React.JSX.Element {
  const numbers = useLoad("numbers", load);
  return (
    <Card data-testid="transparency-growth">
      <CardHeader>
        <CardTitle>
          <h2>{t("d2Metrics.numbers.title")}</h2>
        </CardTitle>
        <CardDescription>{t("d2Metrics.numbers.intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        {numbers.data ? (
          <GrowthNumbersView numbers={numbers.data} />
        ) : numbers.failed ? (
          <SectionLoadError section={t("d2Metrics.numbers.title")} load={numbers} headingLevel={3} />
        ) : (
          <SkeletonGroup label={t("d2Metrics.numbers.loading")}>
            <SkeletonText lines={4} />
          </SkeletonGroup>
        )}
      </CardContent>
    </Card>
  );
}
