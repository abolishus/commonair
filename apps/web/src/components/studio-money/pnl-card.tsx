// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-money (overhaul D5.6, creator-studio P6): "Earnings vs cost" from `analytics.pnl`, which the
 * contract had and no page used. Per stream, what the creator earned while it was live against
 * what it cost the co-op to serve, framed as the co-op's transparency, not a bill.
 */
import type { AnalyticsPnl, AnalyticsRange } from "@commonair/contracts/dto";
import { MoneyAmount, formatDateTime, formatMoney, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { FormError } from "../form-error.tsx";

type Row = AnalyticsPnl["byBroadcast"][number] & { title: string; startedAt: string | null };

/** The pnl rows joined to the range's titles and start times, newest first like the range. */
export function pnlRows(pnl: AnalyticsPnl, broadcasts: AnalyticsRange["broadcasts"]): Row[] {
  const byId = new Map(broadcasts.map((b) => [b.broadcastId, b]));
  const rows = pnl.byBroadcast.map((r) => {
    const b = byId.get(r.broadcastId);
    return { ...r, title: b?.title ?? "", startedAt: b?.startedAt ?? null };
  });
  return rows.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export interface PnlCardProps {
  /** null while loading. */
  pnl: AnalyticsPnl | null;
  failed: boolean;
  onRetry: () => void;
  broadcasts: AnalyticsRange["broadcasts"];
}

export function PnlCard({ pnl, failed, onRetry, broadcasts }: PnlCardProps): React.JSX.Element {
  const { locale } = useLocale();
  const columns: DataTableColumn<Row>[] = [
    {
      id: "stream",
      header: t("d5Money.pnl.stream"),
      cell: ({ row: { original: r } }) => (
        <span className="flex min-w-0 flex-col">
          <span className="break-words">{r.title.trim() || t("analytics.broadcast.untitled")}</span>
          {r.startedAt ? (
            <span className="text-muted-foreground">{formatDateTime(new Date(r.startedAt), locale)}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "revenue",
      header: t("d5Money.pnl.revenue"),
      align: "numeric",
      cell: ({ row: { original: r } }) => <MoneyAmount value={r.revenue} colorNegative />,
    },
    {
      id: "cost",
      header: t("d5Money.pnl.cost"),
      align: "numeric",
      cell: ({ row: { original: r } }) => <MoneyAmount value={r.cost} />,
    },
  ];
  return (
    <Section heading={t("d5Money.pnl.heading")} description={t("d5Money.pnl.hint")}>
      <div
        data-testid="analytics-pnl"
        data-revenue={pnl?.revenue.cents}
        data-cost={pnl?.cost.cents}
        className="flex flex-col gap-3"
      >
        {failed && !pnl ? (
          <div className="flex flex-col items-start gap-3">
            <FormError>{t("d5Money.pnl.loadFailed")}</FormError>
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <>
            {pnl ? (
              <p className="text-sm">
                {t("d5Money.pnl.totals", {
                  revenue: formatMoney(pnl.revenue.cents, pnl.revenue.currency, locale),
                  cost: formatMoney(pnl.cost.cents, pnl.cost.currency, locale),
                })}
              </p>
            ) : null}
            <DataTable
              caption={t("d5Money.pnl.caption")}
              columns={columns}
              rows={pnl ? pnlRows(pnl, broadcasts) : []}
              loading={pnl === null}
              loadingRows={2}
              getRowId={(r) => r.broadcastId}
              rowProps={(r) => ({
                "data-testid": "analytics-pnl-row",
                "data-broadcast-id": r.broadcastId,
                "data-revenue": r.revenue.cents,
                "data-cost": r.cost.cents,
              })}
            />
          </>
        )}
      </div>
    </Section>
  );
}
