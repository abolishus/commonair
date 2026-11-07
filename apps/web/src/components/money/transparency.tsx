// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  EmptyState,
  MoneyAmount,
  RelativeTime,
  formatMoney,
  formatNumber,
  formatPercent,
  useLocale,
} from "@commonair/ui";
import {
  BreakdownBar,
  DataTable,
  MetricPanel,
  StatCard,
  StatGrid,
  Legend,
  getSegmentShares,
  type BreakdownSegment,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { ResponsiveGrid } from "@commonair/ui/layouts";
import { PieChartIcon, Radio02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { egressShare, monthCosts, monthLabel, transparencyTotals, type TransparencyMonthDto } from "../../lib/money.ts";
import { formatBytes } from "../../lib/relays.ts";
import { CoopTransparency } from "../coop/transparency.tsx";
import { FeeSchedule } from "./fee-schedule.tsx";
import {
  creatorSharePercent,
  lastDecision,
  latestMemberCount,
  revenueSegments,
  revenueSplit,
  spendingSegments,
  type RevenueSplit,
} from "./transparency-split.ts";

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

/** The split-shortfall write-off cost line across the months shown (ADR 0013 decision 6). */
export function splitWriteOffCents(months: readonly Pick<TransparencyMonthDto, "costs">[]): number {
  return months.reduce(
    (sum, m) => sum + m.costs.filter((c) => c.category === SPLIT_WRITEOFF).reduce((s, c) => s + c.amount.cents, 0),
    0,
  );
}

const SPLIT_WRITEOFF = "split-shortfall-writeoff";

/**
 * Split shortfalls written off (the co-op's own expense line, never inside payment fees) and
 * withheld split shares (ADR 0013 decisions 6, 7): totals and counts only, never who.
 */
export function SplitLines({
  months,
  currency,
}: {
  months: readonly TransparencyMonthDto[];
  currency: string;
}): React.JSX.Element {
  const writeOff = splitWriteOffCents(months);
  // Months arrive newest first: the latest month end is what is withheld now.
  const held = months[0]?.splitSuspense.heldAtMonthEnd.cents ?? 0;
  const counts = months.reduce(
    (acc, m) => ({
      released: acc.released + m.splitSuspense.released,
      forfeited: acc.forfeited + m.splitSuspense.forfeited,
      writeOffs: acc.writeOffs + m.splitSuspense.writeOffs,
    }),
    { released: 0, forfeited: 0, writeOffs: 0 },
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("splits.transparency.title")}</CardTitle>
        <CardDescription>{t("splits.transparency.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div data-testid="transparency-split-writeoff" data-cents={writeOff} className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t("splits.transparency.writeOff")}</dt>
            <dd className="text-lg font-medium tabular-nums">
              <MoneyAmount value={{ cents: writeOff, currency }} />
            </dd>
            <dd className="text-xs text-muted-foreground">
              {t("splits.transparency.writeOffCount", { count: counts.writeOffs })}
            </dd>
          </div>
          <div data-testid="transparency-split-suspense" data-cents={held} className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t("splits.transparency.suspense")}</dt>
            <dd className="text-lg font-medium tabular-nums">
              <MoneyAmount value={{ cents: held, currency }} />
            </dd>
            <dd className="text-xs text-muted-foreground">
              {t("splits.transparency.suspenseCounts", { released: counts.released, forfeited: counts.forfeited })}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

interface SplitRow extends BreakdownSegment {
  share: number;
}

/**
 * One whole as a bar, with its table: the table is the legend and the text alternative, so the
 * numbers never depend on telling chart colours apart (F4).
 */
export function SplitBarCard({
  title,
  description,
  segments,
  currency,
  empty,
  note,
  ...props
}: {
  title: string;
  description: string;
  segments: BreakdownSegment[];
  currency: string;
  empty: string;
  /** A line under the table. */
  note?: string;
} & Record<`data-${string}`, string>): React.JSX.Element {
  const { locale } = useLocale();
  const shares = getSegmentShares(segments);
  const rows: SplitRow[] = segments.map((s, i) => ({ ...s, share: shares[i] ?? 0 }));
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const columns: DataTableColumn<SplitRow>[] = [
    {
      id: "label",
      header: t("fixWeb.transparency.table.part"),
      // A key-only legend item: the bar's swatch beside the label, drawn by the design system.
      cell: ({ row }) => (
        <Legend
          layout="inline"
          items={[{ id: row.original.id, label: row.original.label, color: row.original.color }]}
        />
      ),
    },
    {
      id: "amount",
      header: t("fixWeb.transparency.table.amount"),
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={{ cents: row.original.value, currency }} />,
    },
    {
      id: "share",
      header: t("fixWeb.transparency.table.share"),
      align: "numeric",
      cell: ({ row }) => formatPercent(row.original.share / 100, locale),
    },
  ];
  return (
    <Card {...props} data-total={total}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {total > 0 ? (
          <>
            <BreakdownBar
              label={title}
              segments={segments}
              showLegend={false}
              formatValue={(cents) => formatMoney(cents, currency, locale)}
              formatLabel={(items, parts) =>
                items
                  .map((item, i) => t("money.shareLabel", { label: item.label, share: parts[i] ?? 0 }))
                  .join(t("common.listSeparator"))
              }
            />
            <DataTable
              caption={title}
              columns={columns}
              rows={rows}
              getRowId={(r) => r.id}
              rowProps={(r) => ({
                "data-testid": "transparency-split-row",
                "data-part": r.id,
                "data-cents": r.value,
                "data-share": r.share,
              })}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{empty}</p>
        )}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}

/** "By the numbers" (coop-trust P3): members, creators paid, the creator share and the last decision. */
export function NumbersStrip({
  months,
  split,
  currency,
}: {
  months: readonly TransparencyMonthDto[];
  split: RevenueSplit;
  currency: string;
}): React.JSX.Element {
  const { locale } = useLocale();
  const share = creatorSharePercent(split);
  const decision = lastDecision(months);
  const paid = months.reduce((sum, m) => sum + m.streamerPayouts.cents, 0);
  const items: { id: string; label: string; value: React.ReactNode }[] = [
    {
      id: "members",
      label: t("fixWeb.transparency.numbers.members"),
      value: formatNumber(latestMemberCount(months), locale),
    },
    {
      id: "paid",
      label: t("fixWeb.transparency.numbers.paid"),
      value: <MoneyAmount value={{ cents: paid, currency }} />,
    },
    {
      id: "share",
      label: t("fixWeb.transparency.numbers.share"),
      value: share === null ? t("fixWeb.transparency.numbers.noRevenue") : formatPercent(share / 100, locale),
    },
    {
      id: "decision",
      label: t("fixWeb.transparency.numbers.decision"),
      value: decision ? <RelativeTime date={decision.decidedAt} /> : t("fixWeb.transparency.numbers.noDecision"),
    },
  ];
  return (
    <section aria-label={t("fixWeb.transparency.numbers.title")} data-testid="transparency-numbers">
      <dl className="grid grid-cols-2 gap-px bg-border ring-1 ring-border sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.id} data-stat={item.id} className="flex min-w-0 flex-col gap-1 bg-card p-4">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
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
  const split = revenueSplit(months);
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
      <NumbersStrip months={months} split={split} currency={totals.currency} />
      <SplitBarCard
        data-testid="transparency-flow"
        title={t("transparency.flow.title")}
        description={t("transparency.flow.hint")}
        segments={revenueSegments(split)}
        currency={totals.currency}
        empty={t("fixWeb.transparency.split.empty")}
        note={t("fixWeb.transparency.split.feeNote")}
      />
      <SplitBarCard
        data-testid="transparency-spending"
        title={t("fixWeb.transparency.spending.title")}
        description={t("fixWeb.transparency.spending.hint")}
        segments={spendingSegments(months)}
        currency={totals.currency}
        empty={t("fixWeb.transparency.spending.empty")}
      />
      {totals.surplus < 0 && (
        <AlertCallout
          data-testid="transparency-deficit"
          tone="info"
          title={t("fixWeb.transparency.deficit.title")}
          description={t("fixWeb.transparency.deficit.body")}
        />
      )}
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
      <SplitLines months={months} currency={totals.currency} />
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
