// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  EmptyState,
  NO_VALUE,
  Skeleton,
  SkeletonGroup,
  formatInteger,
  formatPercent,
  useLocale,
  useRequestNow,
} from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Label } from "@commonair/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@commonair/ui/components/tooltip";
import { Shield01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { monthOptions } from "../../lib/money.ts";
import { FormError } from "../form-error.tsx";
import { useLoad } from "../money/use-load.ts";

/**
 * The open enforcement report on `/transparency` (`transparency.enforcement`, ADR 0019, batch 6
 * decision (d)): per rule, how many platform actions, how they were decided and how many were
 * overturned on appeal, plus the NCII 48-hour line. Figures under 10 arrive suppressed and show
 * as `—` with a "fewer than 10" tooltip. Clause titles come from the API in the request locale.
 * Each area is a list that reads as a table from `sm` up and as stacked cards at 320 px.
 */

type Api = ReturnType<typeof api>;
export type EnforcementReportDto = Awaited<ReturnType<Api["transparency"]["enforcement"]>>;
export type EnforcementRowDto = EnforcementReportDto["rows"][number];
type Count = EnforcementReportDto["total"];
type Group = EnforcementRowDto["group"];

export type LoadEnforcement = (window: string) => Promise<EnforcementReportDto>;
const defaultLoad: LoadEnforcement = (window) => api().transparency.enforcement({ window });

const GROUPS: readonly Group[] = ["safety", "decency", "honesty", "creative", "mature", "illegal", "general"];
const GROUP_KEYS: Record<Group, MessageKey> = {
  safety: "enforcement.group.safety",
  decency: "enforcement.group.decency",
  honesty: "enforcement.group.honesty",
  creative: "enforcement.group.creative",
  mature: "enforcement.group.mature",
  illegal: "enforcement.group.illegal",
  general: "enforcement.group.general",
};
const TIER_KEYS: Record<NonNullable<EnforcementRowDto["tier"]> | "none", MessageKey> = {
  t0: "enforcement.tier.t0",
  t1: "enforcement.tier.t1",
  t2: "enforcement.tier.t2",
  none: "enforcement.tier.none",
};

/** `data-*` value of a published count: the number, or `suppressed`. */
export const countAttr = (c: Count): string => (c.suppressed ? "suppressed" : String(c.value));

/** The overturn rate (overturned ÷ actions), or null when either side is suppressed (a row's count is never 0). */
export function overturnRate(row: Pick<EnforcementRowDto, "count" | "overturned">): number | null {
  if (row.count.suppressed || row.overturned.suppressed || row.count.value === 0) return null;
  return row.overturned.value / row.count.value;
}

/** NCII requests still open: due − on time − late, when all three are published. */
export function nciiPending(n: EnforcementReportDto["ncii"]): Count {
  if (n.due.suppressed || n.onTime.suppressed || n.late.suppressed) return { suppressed: true };
  return { suppressed: false, value: Math.max(0, n.due.value - n.onTime.value - n.late.value) };
}

/** `30d`, then the current UTC month and the 11 before it. */
export function windowOptions(now: number): { value: string; label: string }[] {
  return [{ value: "30d", label: t("enforcement.window.rolling") }, ...monthOptions(now, 12)];
}

function Suppressed(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        data-testid="enforcement-report-suppressed"
        aria-label={t("enforcement.suppressedHint")}
        className="cursor-help tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {NO_VALUE}
      </TooltipTrigger>
      <TooltipContent>{t("enforcement.suppressedHint")}</TooltipContent>
    </Tooltip>
  );
}

function Value({ count }: { count: Count }): React.JSX.Element {
  const { locale } = useLocale();
  if (count.suppressed) return <Suppressed />;
  return <span className="tabular-nums">{formatInteger(count.value, locale)}</span>;
}

/** A small "label value" pair inside a cell. */
function Pair({ label, count, muted = false }: { label: string; count: Count; muted?: boolean }): React.JSX.Element {
  return (
    <span className={muted ? "flex gap-2 text-muted-foreground" : "flex gap-2"}>
      <span>{label}</span>
      <Value count={count} />
    </span>
  );
}

/** A label/value pair; the label is visible when stacked and screen-reader only as a table row. */
function Field({
  label,
  className,
  children,
  ...props
}: { label: string; className?: string; children: React.ReactNode } & Record<
  `data-${string}`,
  string
>): React.JSX.Element {
  return (
    <div className={className} {...props}>
      <dt className="text-xs text-muted-foreground sm:sr-only">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function RuleRow({ row }: { row: EnforcementRowDto }): React.JSX.Element {
  const { locale } = useLocale();
  const rate = overturnRate(row);
  const a = row.automatedDecision;
  return (
    <li
      data-testid="enforcement-report-row"
      data-rule-ref={row.ruleRef}
      data-tier={row.tier ?? "none"}
      {...(row.count.suppressed ? { "data-suppressed": "true" } : { "data-count": String(row.count.value) })}
      className="border-b border-border py-3 last:border-b-0"
    >
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-baseline sm:gap-4">
        <Field label={t("enforcement.column.rule")} className="sm:col-span-5">
          <span className="font-medium">{row.clauseTitle}</span>
          <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono break-all">{row.ruleRef}</span>
            <span>{t(TIER_KEYS[row.tier ?? "none"])}</span>
          </span>
        </Field>
        <Field label={t("enforcement.column.actions")} className="sm:col-span-2 sm:text-end">
          <Value count={row.count} />
        </Field>
        <Field
          label={t("enforcement.column.automated")}
          className="sm:col-span-3"
          data-testid="enforcement-report-automated"
          data-fully={countAttr(a.fully)}
          data-partially={countAttr(a.partially)}
          data-not={countAttr(a.not)}
        >
          <span className="flex flex-col text-xs">
            <Pair label={t("enforcement.automated.fully")} count={a.fully} />
            <Pair label={t("enforcement.automated.partially")} count={a.partially} />
            <Pair label={t("enforcement.automated.not")} count={a.not} />
            <Pair label={t("enforcement.detected")} count={row.automatedDetection} muted />
          </span>
        </Field>
        <Field
          label={t("enforcement.column.overturned")}
          className="sm:col-span-2 sm:text-end"
          data-testid="enforcement-report-overturn"
          {...(rate === null
            ? { "data-suppressed": "true" }
            : { "data-numerator": countAttr(row.overturned), "data-denominator": countAttr(row.count) })}
        >
          <span className="flex flex-col text-xs sm:items-end">
            <span className="text-sm">
              {rate === null ? (
                <Suppressed />
              ) : (
                t("enforcement.overturn.rate", { rate: formatPercent(rate, locale, { maximumFractionDigits: 1 }) })
              )}
            </span>
            <Pair label={t("enforcement.overturn.appealed")} count={row.appealed} muted />
            <Pair label={t("enforcement.overturn.overturned")} count={row.overturned} muted />
          </span>
        </Field>
      </dl>
    </li>
  );
}

function GroupTable({ group, rows }: { group: Group; rows: EnforcementRowDto[] }): React.JSX.Element {
  const id = React.useId();
  return (
    <Card data-testid="enforcement-report-group" data-group={group}>
      <CardHeader>
        <CardTitle id={id}>{t(GROUP_KEYS[group])}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          aria-hidden
          className="hidden border-b border-border pb-2 text-xs text-muted-foreground sm:grid sm:grid-cols-12 sm:gap-4"
        >
          <span className="sm:col-span-5">{t("enforcement.column.rule")}</span>
          <span className="sm:col-span-2 sm:text-end">{t("enforcement.column.actions")}</span>
          <span className="sm:col-span-3">{t("enforcement.column.automated")}</span>
          <span className="sm:col-span-2 sm:text-end">{t("enforcement.column.overturned")}</span>
        </div>
        <ul aria-labelledby={id}>
          {rows.map((row) => (
            <RuleRow key={`${row.ruleRef}|${row.tier ?? ""}`} row={row} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function NciiLine({ ncii }: { ncii: EnforcementReportDto["ncii"] }): React.JSX.Element {
  const pending = nciiPending(ncii);
  const items: { key: MessageKey; count: Count }[] = [
    { key: "enforcement.ncii.due", count: ncii.due },
    { key: "enforcement.ncii.onTime", count: ncii.onTime },
    { key: "enforcement.ncii.late", count: ncii.late },
    { key: "enforcement.ncii.pending", count: pending },
  ];
  return (
    <Card
      data-testid="enforcement-report-ncii"
      data-due={countAttr(ncii.due)}
      data-on-time={countAttr(ncii.onTime)}
      data-late={countAttr(ncii.late)}
      data-pending={countAttr(pending)}
    >
      <CardHeader>
        <CardTitle>{t("enforcement.ncii.title")}</CardTitle>
        <CardDescription>{t("enforcement.ncii.intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {items.map((item) => (
            <div key={item.key} className="flex items-baseline gap-2">
              <dt className="text-sm text-muted-foreground">{t(item.key)}</dt>
              <dd className="text-sm font-medium">
                <Value count={item.count} />
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** The figures for one loaded report (exported for tests and stories). */
export function EnforcementFigures({ report }: { report: EnforcementReportDto }): React.JSX.Element {
  const empty = report.rows.length === 0;
  return (
    <div className="flex flex-col gap-4">
      {empty ? (
        <EmptyState
          data-testid="enforcement-report-empty"
          icon={Shield01Icon}
          headingLevel={3}
          title={t("enforcement.empty")}
          description={t("enforcement.emptyHint")}
        />
      ) : (
        <>
          <p
            className="flex flex-wrap items-baseline gap-2 text-sm"
            data-testid="enforcement-report-total"
            data-count={countAttr(report.total)}
          >
            <span className="text-muted-foreground">{t("enforcement.total")}</span>
            <span className="text-base font-medium">
              <Value count={report.total} />
            </span>
          </p>
          {GROUPS.map((group) => {
            const rows = report.rows.filter((r) => r.group === group);
            return rows.length ? <GroupTable key={group} group={group} rows={rows} /> : null;
          })}
        </>
      )}
      <NciiLine ncii={report.ncii} />
    </div>
  );
}

export function EnforcementReport({ load = defaultLoad }: { load?: LoadEnforcement } = {}): React.JSX.Element {
  const requestNow = useRequestNow();
  // From the request time, so the server render and hydration agree on the month list.
  const [now] = React.useState(() => requestNow ?? Date.now());
  const options = React.useMemo(() => windowOptions(now), [now]);
  const [period, setPeriod] = React.useState("30d");
  const report = useLoad(period, () => load(period));
  const titleId = React.useId();
  const selectId = React.useId();
  return (
    <section data-testid="enforcement-report" aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-lg font-medium">
            {t("enforcement.title")}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">{t("enforcement.intro")}</p>
        </div>
        <div className="flex min-w-48 flex-col gap-1">
          <Label htmlFor={selectId} className="text-xs text-muted-foreground">
            {t("enforcement.window.label")}
          </Label>
          <Select
            items={options}
            value={period}
            onValueChange={(value) => {
              if (value !== null) setPeriod(value);
            }}
          >
            <SelectTrigger id={selectId} data-testid="enforcement-report-window" data-value={period}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem
                  key={o.value}
                  value={o.value}
                  data-value={o.value}
                  data-testid={`enforcement-report-window-${o.value}`}
                >
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {report.failed && <FormError>{t("enforcement.loadFailed")}</FormError>}
      {report.data ? (
        <EnforcementFigures report={report.data} />
      ) : (
        !report.failed && (
          <SkeletonGroup label={t("enforcement.loading")}>
            <div className="flex flex-col gap-4">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </SkeletonGroup>
        )
      )}
    </section>
  );
}
