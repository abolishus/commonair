// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { MoneyAmount, type MoneyValue } from "../../primitives/money-amount.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { DataTable, type DataTableColumn } from "../data/data-table.tsx";
import { FormSection } from "../forms/form-section.tsx";
import { NoteDialog, type NoteDialogProps } from "../forms/note-dialog.tsx";
import { shareStatusTone } from "./tones.ts";

export interface ShareRefundAction extends Omit<NoteDialogProps, "trigger"> {
  /** The trigger button's text ("Mark refund sent"). */
  label: string;
  /** Set on the trigger button (e.g. `treasury-share-refund`). */
  triggerProps?: DataAttributes;
}

export interface ShareRefundRow {
  id: string;
  user: { id: string; name: React.ReactNode };
  /** `SHARE_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  /** Its cents are set as `data-cents`. */
  amount: MoneyValue;
  /** When the share was bought / the refund requested (`RelativeTime` or text). */
  since?: React.ReactNode;
  /** `refund_pending` rows: record the refund as sent, with the treasurer's note. */
  refund?: ShareRefundAction;
}

export interface ShareRefundsTableProps extends Omit<React.ComponentProps<"div">, "children"> {
  rows: readonly ShareRefundRow[];
  labels: { caption: string; member: string; status: string; amount: string; since: string; actions: string };
  empty?: React.ReactNode;
  /** Set on every row besides its `data-*` (e.g. `{ "data-testid": "treasury-share-row" }`). */
  rowProps?: DataAttributes;
  locale?: string;
}

/** The treasury's member shares by status, with "refund sent" on those awaiting a refund. */
export function ShareRefundsTable({
  rows,
  labels,
  empty,
  rowProps,
  locale,
  ...props
}: ShareRefundsTableProps): React.JSX.Element {
  const columns: DataTableColumn<ShareRefundRow>[] = [
    { id: "member", header: labels.member, cell: ({ row }) => row.original.user.name },
    {
      id: "status",
      header: labels.status,
      cell: ({ row }) => (
        <StatusBadge tone={shareStatusTone(row.original.status)}>{row.original.statusLabel}</StatusBadge>
      ),
    },
    {
      id: "amount",
      header: labels.amount,
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={row.original.amount} locale={locale} />,
    },
    { id: "since", header: labels.since, cell: ({ row }) => row.original.since ?? "–" },
    {
      id: "actions",
      header: () => <span className="sr-only">{labels.actions}</span>,
      cell: ({ row }) => {
        const refund = row.original.refund;
        if (!refund) return null;
        const { label, triggerProps, ...dialog } = refund;
        return (
          <div className="flex justify-end">
            <NoteDialog
              {...dialog}
              trigger={
                <Button {...triggerProps} type="button" size="sm">
                  {label}
                </Button>
              }
            />
          </div>
        );
      },
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
        "data-share-id": row.id,
        "data-user-id": row.user.id,
        "data-status": row.status,
        "data-cents": row.amount.cents,
      })}
    />
  );
}

export interface AppointWorkerFormValues {
  username: string;
  /** The board minute reference (goes to the audit reason). */
  minute: string;
}

export interface AppointWorkerFormProps extends Omit<
  React.ComponentProps<"form">,
  "children" | "title" | "onSubmit" | "action"
> {
  title: React.ReactNode;
  description?: React.ReactNode;
  labels: {
    username: React.ReactNode;
    usernameHint?: React.ReactNode;
    minute: React.ReactNode;
    minuteHint?: React.ReactNode;
    submit: string;
  };
  values: AppointWorkerFormValues;
  onValuesChange: (values: AppointWorkerFormValues) => void;
  onSubmit: (values: AppointWorkerFormValues) => void | Promise<void>;
  pending?: boolean;
  error?: React.ReactNode;
  usernameProps?: DataAttributes;
  minuteProps?: DataAttributes;
  submitProps?: DataAttributes;
  "data-testid"?: string;
}

/** Admin: record a board decision appointing a worker member. */
export function AppointWorkerForm({
  title,
  description,
  labels,
  values,
  onValuesChange,
  onSubmit,
  pending = false,
  error,
  usernameProps,
  minuteProps,
  submitProps,
  ...props
}: AppointWorkerFormProps): React.JSX.Element {
  const id = React.useId();
  const ready = values.username.trim().length > 0 && values.minute.trim().length > 0;
  return (
    <FormSection
      {...props}
      title={title}
      description={description}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) void onSubmit({ username: values.username.trim(), minute: values.minute.trim() });
      }}
      actions={{ saveLabel: labels.submit, disabled: pending || !ready, saveProps: submitProps }}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-username`}>{labels.username}</FieldLabel>
        <Input
          {...usernameProps}
          id={`${id}-username`}
          autoComplete="off"
          spellCheck={false}
          value={values.username}
          disabled={pending}
          onChange={(event) => onValuesChange({ ...values, username: event.currentTarget.value })}
        />
        {labels.usernameHint ? <FieldDescription>{labels.usernameHint}</FieldDescription> : null}
      </Field>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${id}-minute`}>{labels.minute}</FieldLabel>
        <Input
          {...minuteProps}
          id={`${id}-minute`}
          maxLength={200}
          value={values.minute}
          disabled={pending}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onValuesChange({ ...values, minute: event.currentTarget.value })}
        />
        {labels.minuteHint ? <FieldDescription>{labels.minuteHint}</FieldDescription> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
    </FormSection>
  );
}
