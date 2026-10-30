// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PaymentBreakdown } from "@commonair/contracts/dto";
import { MoneyAmount, formatMoney, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import type * as React from "react";
import type { z } from "zod";
import { t } from "../../i18n/index.ts";

/** `money.paymentBreakdown` as the web app receives it. */
export type PaymentBreakdownDto = z.infer<typeof PaymentBreakdown>;
export type BreakdownLineDto = PaymentBreakdownDto["lines"][number];

/** The words for one line (sign-aware for reversals and returned fees). */
export function breakdownLineLabel(line: BreakdownLineDto): string {
  switch (line.kind) {
    case "tax":
      return t("breakdown.line.tax");
    case "creator":
      return t("breakdown.line.creator");
    case "coop_share":
      return t("breakdown.line.coopShare");
    case "processor_fee":
      return t("breakdown.line.processorFee");
    case "dispute_fee":
      return line.amount.cents < 0 ? t("breakdown.line.disputeFeeReturned") : t("breakdown.line.disputeFee");
    case "coop_net":
      return t("breakdown.line.coopNet");
    case "reversal":
      return t("breakdown.line.reversal", {
        component: line.component ?? "coop_share",
        direction: line.amount.cents > 0 ? "restored" : "reversed",
      });
  }
}

/** The derived co-op net, or null when the payment has none (never: the builder always adds it). */
export const coopNetLine = (b: Pick<PaymentBreakdownDto, "lines">): BreakdownLineDto | null =>
  b.lines.find((l) => l.kind === "coop_net") ?? null;

/**
 * Every line of a breakdown as a semantic table. Amounts are signed exactly as the ledger has
 * them; a negative co-op net is also said in words below the table (not by colour alone).
 */
export function BreakdownTable({ breakdown }: { breakdown: PaymentBreakdownDto }): React.JSX.Element {
  const { locale } = useLocale();
  const columns: DataTableColumn<BreakdownLineDto>[] = [
    {
      id: "item",
      header: t("breakdown.column.item"),
      cell: ({ row }) =>
        row.original.kind === "coop_net" ? (
          <span className="font-medium">{breakdownLineLabel(row.original)}</span>
        ) : (
          breakdownLineLabel(row.original)
        ),
    },
    {
      id: "amount",
      header: t("breakdown.column.amount"),
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={row.original.amount} colorNegative />,
    },
  ];
  const net = coopNetLine(breakdown);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DataTable
        caption={t("breakdown.tableCaption")}
        columns={columns}
        rows={breakdown.lines}
        getRowId={(_line, index) => String(index)}
        rowProps={(line) => ({
          "data-testid": "breakdown-line",
          "data-kind": line.kind,
          "data-component": line.component ?? "",
          "data-cents": line.amount.cents,
        })}
      />
      {net && net.amount.cents < 0 && (
        <p className="text-sm text-muted-foreground">
          {t("breakdown.coopNegative", { amount: formatMoney(-net.amount.cents, net.amount.currency, locale) })}
        </p>
      )}
    </div>
  );
}
