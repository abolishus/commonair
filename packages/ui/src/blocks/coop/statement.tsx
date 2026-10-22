// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";
import { useResolvedLocale } from "../../lib/locale.tsx";
import { MoneyAmount, type MoneyValue } from "../../primitives/money-amount.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { KeyValueList, type KeyValueRow } from "../data/key-value-list.tsx";
import { StatCard, StatGrid } from "../data/stat-card.tsx";
import { patronageStatusTone } from "./tones.ts";

/** One component of a patronage allocation (`PatronageLine`). */
export interface StatementLineItem {
  /** `PATRONAGE_COMPONENTS` value; set as `data-component`. */
  component: string;
  label: React.ReactNode;
  /** The line's explanation (`explainLine`), translated. */
  explanation: React.ReactNode;
  /** "$120.00 of $4,000.00" / "36 h of 1,200 h": the member's value over the pool total. */
  basis: React.ReactNode;
  /** The component's pool ("$1,600.00 pool"). */
  pool?: React.ReactNode;
  /** 0–1; set as `data-share` and shown as a percentage. */
  share: number;
  amount: MoneyValue;
  capApplied: boolean;
}

export interface StatementLabels {
  total: string;
  surplus: string;
  /** Third header figure, e.g. "Formula" (its value is `formula`). */
  formula: string;
  lines: string;
  share: string;
  amount: string;
  /** The badge on a line whose cap applied. */
  capApplied: string;
  inputs: string;
}

export interface StatementViewProps extends Omit<React.ComponentProps<"section">, "children" | "title"> {
  title: React.ReactNode;
  /** The period ("1–31 Oct 2026"). */
  period?: React.ReactNode;
  /** `PATRONAGE_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  /** The member's total; its cents are set as `data-cents`. */
  total: MoneyValue;
  surplus: MoneyValue;
  /** Formula version text ("v3, weights 50/20/10/20"). */
  formula: React.ReactNode;
  lines: readonly StatementLineItem[];
  /** The member's inputs (revenue, hours, relay bytes, viewer hours). */
  inputs?: readonly KeyValueRow[];
  labels: StatementLabels;
  /** Set on every line besides its `data-*` (e.g. `{ "data-testid": "statement-line" }`). */
  lineProps?: DataAttributes;
  /** Set on every line's explanation (e.g. `statement-line-explanation`). */
  explanationProps?: DataAttributes;
  /** Set on the inputs list (`statement-inputs` with its raw values). */
  inputsProps?: DataAttributes;
  locale?: string;
}

/** One patronage statement, explained line by line. */
export function StatementView({
  title,
  period,
  status,
  statusLabel,
  total,
  surplus,
  formula,
  lines,
  inputs,
  labels,
  lineProps,
  explanationProps,
  inputsProps,
  locale,
  className,
  ...props
}: StatementViewProps): React.JSX.Element {
  const resolved = useResolvedLocale(locale);
  const percent = (share: number): string =>
    new Intl.NumberFormat(resolved, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      share,
    );
  return (
    <section
      data-status={status}
      data-cents={total.cents}
      className={cn("flex min-w-0 flex-col gap-4", className)}
      {...props}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-medium">{title}</h2>
          {period ? <p className="text-xs text-muted-foreground">{period}</p> : null}
        </div>
        <StatusBadge tone={patronageStatusTone(status)}>{statusLabel}</StatusBadge>
      </div>
      <StatGrid cols={3}>
        <StatCard size="sm" tone="accent" label={labels.total} value={<MoneyAmount value={total} locale={locale} />} />
        <StatCard size="sm" label={labels.surplus} value={<MoneyAmount value={surplus} locale={locale} />} />
        <StatCard size="sm" label={labels.formula} value={<span className="text-sm">{formula}</span>} />
      </StatGrid>
      <Card size="sm">
        <CardHeader>
          <CardTitle>{labels.lines}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-3">
            {lines.map((line) => (
              <li
                {...lineProps}
                key={line.component}
                data-component={line.component}
                data-cents={line.amount.cents}
                data-share={line.share}
                data-cap-applied={String(line.capApplied)}
                className="flex min-w-0 flex-col gap-1.5 border-b pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2 text-xs font-medium">
                    {line.label}
                    {line.capApplied ? <StatusBadge tone="warning">{labels.capApplied}</StatusBadge> : null}
                  </span>
                  <MoneyAmount value={line.amount} locale={locale} className="text-xs font-medium" />
                </div>
                <p {...explanationProps} className="text-xs text-muted-foreground wrap-anywhere">
                  {line.explanation}
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  <span>{line.basis}</span>
                  {line.pool ? <span>{line.pool}</span> : null}
                  <span>
                    {labels.share} {percent(line.share)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {inputs && inputs.length > 0 ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{labels.inputs}</CardTitle>
          </CardHeader>
          <CardContent>
            <KeyValueList {...inputsProps} rows={[...inputs]} />
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

export interface StatementListItem {
  periodId: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** `PATRONAGE_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  /** The member's total; its cents are set as `data-cents`. */
  amount: MoneyValue;
  link: LinkTarget;
}

export interface StatementListProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  items: readonly StatementListItem[];
  /** `<EmptyState>` (e.g. with `patronage-empty`) when there are no statements. */
  empty?: React.ReactNode;
  /** Set on every item besides its `data-*` (e.g. `{ "data-testid": "patronage-item" }`). */
  itemProps?: DataAttributes;
  action?: React.ReactNode;
  locale?: string;
}

/** The member's patronage statements, newest first, each linking to its explanation. */
export function StatementList({
  title,
  description,
  items,
  empty,
  itemProps,
  action,
  locale,
  className,
  ...props
}: StatementListProps): React.JSX.Element {
  return (
    <Card size="sm" className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          empty
        ) : (
          <ItemGroup className="gap-2">
            {items.map((item) => (
              <Item
                {...itemProps}
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
                role="listitem"
                key={item.periodId}
                variant="outline"
                size="sm"
                data-period-id={item.periodId}
                data-status={item.status}
                data-cents={item.amount.cents}
              >
                <ItemContent className="min-w-0">
                  <ItemTitle>
                    <TargetLink target={item.link} className="hover:underline hover:underline-offset-4">
                      {item.title}
                    </TargetLink>
                  </ItemTitle>
                  {item.description ? <ItemDescription>{item.description}</ItemDescription> : null}
                </ItemContent>
                <ItemActions className="flex-col items-end gap-1">
                  <MoneyAmount value={item.amount} locale={locale} className="text-xs font-medium" />
                  <StatusBadge tone={patronageStatusTone(item.status)}>{item.statusLabel}</StatusBadge>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}
