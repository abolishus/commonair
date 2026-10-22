// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@commonair/ui/components/input-group";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { formatNumber } from "../../lib/format.ts";
import { useResolvedLocale } from "../../lib/locale.tsx";
import { MoneyAmount, type MoneyValue } from "../../primitives/money-amount.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { DataTable, type DataTableColumn } from "../data/data-table.tsx";
import { StatCard, StatGrid } from "../data/stat-card.tsx";
import { FormSection } from "../forms/form-section.tsx";
import { ConfirmedActionButton, type ConfirmedAction } from "./membership.tsx";
import { patronageStatusTone } from "./tones.ts";

export interface PatronageRunFormValues {
  /** `datetime-local` text, read as UTC by the page. */
  start: string;
  end: string;
  /** Currency units as typed; empty = all available surplus. */
  surplus: string;
}

export interface PatronageRunFormProps extends Omit<
  React.ComponentProps<"form">,
  "children" | "title" | "onSubmit" | "action"
> {
  title: React.ReactNode;
  description?: React.ReactNode;
  labels: {
    start: React.ReactNode;
    end: React.ReactNode;
    /** E.g. "Times are UTC". */
    timesHint?: React.ReactNode;
    surplus: React.ReactNode;
    /** E.g. "Leave empty to allocate all retained surplus". */
    surplusHint?: React.ReactNode;
    submit: string;
  };
  /** ISO 4217 code shown beside the surplus. */
  currency: string;
  values: PatronageRunFormValues;
  onValuesChange: (values: PatronageRunFormValues) => void;
  onSubmit: (values: PatronageRunFormValues) => void | Promise<void>;
  pending?: boolean;
  error?: React.ReactNode;
  startProps?: DataAttributes;
  endProps?: DataAttributes;
  surplusProps?: DataAttributes;
  submitProps?: DataAttributes;
}

/** Treasurer: compute a patronage run for a closed period. */
export function PatronageRunForm({
  title,
  description,
  labels,
  currency,
  values,
  onValuesChange,
  onSubmit,
  pending = false,
  error,
  startProps,
  endProps,
  surplusProps,
  submitProps,
  className,
  ...props
}: PatronageRunFormProps): React.JSX.Element {
  const id = React.useId();
  const set = (patch: Partial<PatronageRunFormValues>): void => onValuesChange({ ...values, ...patch });
  return (
    <FormSection
      {...props}
      className={className}
      title={title}
      description={description}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void onSubmit(values);
      }}
      actions={{
        saveLabel: labels.submit,
        disabled: pending || !values.start || !values.end,
        saveProps: submitProps,
      }}
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-start`}>{labels.start}</FieldLabel>
          <Input
            {...startProps}
            id={`${id}-start`}
            type="datetime-local"
            step={1}
            value={values.start}
            disabled={pending}
            onChange={(event) => set({ start: event.currentTarget.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-end`}>{labels.end}</FieldLabel>
          <Input
            {...endProps}
            id={`${id}-end`}
            type="datetime-local"
            step={1}
            value={values.end}
            disabled={pending}
            onChange={(event) => set({ end: event.currentTarget.value })}
          />
        </Field>
      </div>
      {labels.timesHint ? <FieldDescription>{labels.timesHint}</FieldDescription> : null}
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${id}-surplus`}>{labels.surplus}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            {...surplusProps}
            id={`${id}-surplus`}
            inputMode="decimal"
            value={values.surplus}
            disabled={pending}
            aria-invalid={error ? true : undefined}
            onChange={(event) => set({ surplus: event.currentTarget.value })}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>{currency.toUpperCase()}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        {labels.surplusHint ? <FieldDescription>{labels.surplusHint}</FieldDescription> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
    </FormSection>
  );
}

export interface PatronageRunResultProps extends Omit<React.ComponentProps<"section">, "children" | "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Members with an allocation; set as `data-members`. */
  members: number;
  /** Allocated total; its cents are set as `data-cents`. */
  total: MoneyValue;
  surplus: MoneyValue;
  retained?: MoneyValue;
  labels: { members: string; total: string; surplus: string; retained?: string };
  locale?: string;
}

/** The outcome of a run: members, total allocated, surplus used and retained. */
export function PatronageRunResult({
  title,
  description,
  members,
  total,
  surplus,
  retained,
  labels,
  locale,
  className,
  ...props
}: PatronageRunResultProps): React.JSX.Element {
  const resolved = useResolvedLocale(locale);
  return (
    <section
      aria-live="polite"
      data-members={members}
      data-cents={total.cents}
      className={cn("flex min-w-0 flex-col gap-3 border border-success p-3", className)}
      {...props}
    >
      <div>
        <h3 className="text-xs font-medium text-success">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <StatGrid cols={retained && labels.retained ? 4 : 3}>
        <StatCard size="sm" label={labels.members} value={formatNumber(members, resolved)} />
        <StatCard size="sm" label={labels.total} value={<MoneyAmount value={total} locale={locale} />} />
        <StatCard size="sm" label={labels.surplus} value={<MoneyAmount value={surplus} locale={locale} />} />
        {retained && labels.retained ? (
          <StatCard size="sm" label={labels.retained} value={<MoneyAmount value={retained} locale={locale} />} />
        ) : null}
      </StatGrid>
    </section>
  );
}

/** An action that may be unavailable to this viewer, with the reason shown next to it. */
export interface GuardedAction extends ConfirmedAction {
  /** When set, the button is disabled and described by this text (e.g. "You ran this period"). */
  disabledReason?: React.ReactNode;
}

function GuardedActionButton({ action }: { action: GuardedAction }): React.JSX.Element {
  const reasonId = React.useId();
  if (!action.disabledReason) return <ConfirmedActionButton action={action} />;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        {...action.triggerProps}
        type="button"
        size="sm"
        variant="outline"
        disabled
        focusableWhenDisabled
        aria-describedby={reasonId}
      >
        {action.label}
      </Button>
      <span id={reasonId} className="max-w-48 text-right text-xs text-muted-foreground">
        {action.disabledReason}
      </span>
    </div>
  );
}

export interface PatronagePeriodRow {
  id: string;
  /** "1–31 Oct 2026". */
  period: React.ReactNode;
  /** `PATRONAGE_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  members: number;
  /** Allocated total; its cents are set as `data-cents`. */
  total: MoneyValue;
  /** Who ran it (`data-computed-by` = id). */
  computedBy: { id: string; name: React.ReactNode } | null;
  approvedBy: { id: string; name: React.ReactNode } | null;
  /** `computed` rows: the approve action (disabled with a reason for the person who ran it). */
  approve?: GuardedAction;
}

export interface PatronagePeriodsTableProps extends Omit<React.ComponentProps<"div">, "children"> {
  rows: readonly PatronagePeriodRow[];
  labels: {
    caption: string;
    period: string;
    status: string;
    members: string;
    total: string;
    computedBy: string;
    approvedBy: string;
    actions: string;
  };
  empty?: React.ReactNode;
  /** Set on every row besides its `data-*` (e.g. `{ "data-testid": "patronage-period-row" }`). */
  rowProps?: DataAttributes;
  locale?: string;
}

/** Every patronage period, newest first: status, totals, who ran and approved it, and approval. */
export function PatronagePeriodsTable({
  rows,
  labels,
  empty,
  rowProps,
  locale,
  ...props
}: PatronagePeriodsTableProps): React.JSX.Element {
  const resolved = useResolvedLocale(locale);
  const columns: DataTableColumn<PatronagePeriodRow>[] = [
    { id: "period", header: labels.period, cell: ({ row }) => row.original.period },
    {
      id: "status",
      header: labels.status,
      cell: ({ row }) => (
        <StatusBadge tone={patronageStatusTone(row.original.status)}>{row.original.statusLabel}</StatusBadge>
      ),
    },
    {
      id: "members",
      header: labels.members,
      align: "numeric",
      cell: ({ row }) => formatNumber(row.original.members, resolved),
    },
    {
      id: "total",
      header: labels.total,
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={row.original.total} locale={locale} />,
    },
    { id: "computedBy", header: labels.computedBy, cell: ({ row }) => row.original.computedBy?.name ?? "–" },
    { id: "approvedBy", header: labels.approvedBy, cell: ({ row }) => row.original.approvedBy?.name ?? "–" },
    {
      id: "actions",
      header: () => <span className="sr-only">{labels.actions}</span>,
      cell: ({ row }) =>
        row.original.approve ? (
          <div className="flex justify-end">
            <GuardedActionButton action={row.original.approve} />
          </div>
        ) : null,
    },
  ];
  return (
    <DataTable
      {...props}
      caption={labels.caption}
      columns={columns}
      rows={[...rows]}
      empty={empty}
      getRowId={(row) => row.id}
      rowProps={(row) => ({
        ...rowProps,
        "data-period-id": row.id,
        "data-status": row.status,
        "data-cents": row.total.cents,
        "data-computed-by": row.computedBy?.id ?? "",
        "data-approved-by": row.approvedBy?.id ?? "",
      })}
    />
  );
}

export { GuardedActionButton };
