// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Add01Icon, ArrowRight02Icon, Delete02Icon, SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { IconButton } from "../../primitives/icon-button.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { SelectField } from "../forms/select-field.tsx";

/** Pretty JSON for a setting value (2-space indent); `undefined` shows as `null`. */
export function formatSettingValue(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2) ?? "null";
}

/** A setting value as a code block that wraps instead of scrolling the page sideways. */
export function SettingValue({
  value,
  className,
  ...props
}: { value: unknown } & Omit<React.ComponentProps<"pre">, "children">): React.JSX.Element {
  return (
    <pre
      className={cn(
        "min-w-0 bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere tabular-nums",
        className,
      )}
      {...props}
    >
      {formatSettingValue(value)}
    </pre>
  );
}

export interface ProposalKindBadgeProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** `ordinary` or `protected`; set as `data-kind`. */
  kind: string;
  /** "Ordinary decision" / "Protected decision". */
  label: string;
}

/** The derived kind of a proposal; protected decisions carry the lock. */
export function ProposalKindBadge({ kind, label, ...props }: ProposalKindBadgeProps): React.JSX.Element {
  return (
    <StatusBadge
      data-kind={kind}
      tone={kind === "protected" ? "warning" : "neutral"}
      icon={kind === "protected" ? SquareLock01Icon : undefined}
      {...props}
    >
      {label}
    </StatusBadge>
  );
}

export interface ProposalChangeKeyOption {
  value: string;
  label: string;
  /** The key is protected (a change to it makes the proposal protected). */
  protected: boolean;
  /** Set on the option (e.g. `proposal-change-key-<key>`). */
  "data-testid"?: string;
}

export interface ProposalChangeDraft {
  /** Stable row id (not the setting key: a row may not have one yet). */
  id: string;
  /** Chosen setting key, or "" while none is chosen. */
  key: string;
  /** The JSON text of the new value. */
  value: string;
  /** E.g. "Not valid JSON", "Already changed in another row". */
  error?: React.ReactNode;
}

export interface ProposalChangeEditorLabels {
  key: string;
  keyPlaceholder: string;
  value: string;
  valueHint?: React.ReactNode;
  /** The protected badge on a row whose key is protected. */
  protected: string;
  /** Accessible name and tooltip of the remove button. */
  remove: string;
  add: string;
  /** Shown when there are no rows (ordinary proposals may change nothing). */
  empty?: React.ReactNode;
}

export interface ProposalChangeEditorProps extends Omit<React.ComponentProps<"div">, "children" | "onChange"> {
  rows: readonly ProposalChangeDraft[];
  keyOptions: readonly ProposalChangeKeyOption[];
  onRowChange: (id: string, patch: Partial<Omit<ProposalChangeDraft, "id">>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  labels: ProposalChangeEditorLabels;
  disabled?: boolean;
  /** The derived kind (`ProposalKindBadge` is shown above the rows). */
  kind?: { kind: string; label: string; description?: React.ReactNode; props?: DataAttributes };
  /** Set on every row besides `data-key` / `data-protected` (e.g. `{ "data-testid": "proposal-change" }`). */
  rowProps?: DataAttributes;
  keyTriggerProps?: { [key: `data-${string}`]: string | undefined };
  valueProps?: DataAttributes;
  removeProps?: DataAttributes;
  addProps?: DataAttributes;
}

/**
 * The setting changes of a proposal draft: per row a key (`SelectField`), its JSON value and the
 * protected badge, plus add/remove; the derived kind sits on top.
 */
export function ProposalChangeEditor({
  rows,
  keyOptions,
  onRowChange,
  onRemove,
  onAdd,
  labels,
  disabled = false,
  kind,
  rowProps,
  keyTriggerProps,
  valueProps,
  removeProps,
  addProps,
  className,
  ...props
}: ProposalChangeEditorProps): React.JSX.Element {
  const baseId = React.useId();
  const protectedKeys = new Set(keyOptions.filter((option) => option.protected).map((option) => option.value));
  const taken = new Set(rows.map((row) => row.key).filter(Boolean));
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} {...props}>
      {kind ? (
        <div className="flex flex-wrap items-center gap-2">
          <ProposalKindBadge {...kind.props} kind={kind.kind} label={kind.label} />
          {kind.description ? <p className="text-xs text-muted-foreground">{kind.description}</p> : null}
        </div>
      ) : null}
      {rows.length === 0 && labels.empty ? <p className="text-xs text-muted-foreground">{labels.empty}</p> : null}
      {rows.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {rows.map((row, index) => {
            const isProtected = row.key ? protectedKeys.has(row.key) : undefined;
            const valueId = `${baseId}-${row.id}-value`;
            return (
              <li
                {...rowProps}
                key={row.id}
                data-key={row.key || undefined}
                data-protected={isProtected === undefined ? undefined : String(isProtected)}
                className="flex min-w-0 flex-col gap-3 border p-3"
              >
                <div className="flex min-w-0 items-end gap-2">
                  <SelectField
                    className="min-w-0 flex-1"
                    id={`${baseId}-${row.id}-key`}
                    label={labels.key}
                    placeholder={labels.keyPlaceholder}
                    disabled={disabled}
                    options={keyOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                      // A key may appear once per proposal.
                      disabled: option.value !== row.key && taken.has(option.value),
                      "data-testid": option["data-testid"],
                    }))}
                    value={row.key || null}
                    onValueChange={(key) => onRowChange(row.id, { key })}
                    triggerProps={keyTriggerProps}
                  />
                  <IconButton
                    {...removeProps}
                    label={`${labels.remove} ${index + 1}`}
                    tooltip={labels.remove}
                    icon={Delete02Icon}
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onRemove(row.id)}
                  />
                </div>
                {isProtected ? (
                  <StatusBadge tone="warning" icon={SquareLock01Icon}>
                    {labels.protected}
                  </StatusBadge>
                ) : null}
                <Field data-invalid={row.error ? true : undefined}>
                  <FieldLabel htmlFor={valueId}>{labels.value}</FieldLabel>
                  <Textarea
                    {...valueProps}
                    id={valueId}
                    value={row.value}
                    disabled={disabled}
                    spellCheck={false}
                    aria-invalid={row.error ? true : undefined}
                    className="font-mono text-xs"
                    onChange={(event) => onRowChange(row.id, { value: event.currentTarget.value })}
                  />
                  {labels.valueHint ? <FieldDescription>{labels.valueHint}</FieldDescription> : null}
                  {row.error ? <FieldError>{row.error}</FieldError> : null}
                </Field>
              </li>
            );
          })}
        </ol>
      ) : null}
      <div>
        <Button
          {...addProps}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || taken.size >= keyOptions.length}
          onClick={onAdd}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {labels.add}
        </Button>
      </div>
    </div>
  );
}

export interface ProposalChangeSummaryItem {
  key: string;
  /** Display name of the key; defaults to the key itself. */
  label?: React.ReactNode;
  from: unknown;
  to: unknown;
  protected: boolean;
}

export interface ProposalChangeSummaryProps extends Omit<React.ComponentProps<"ul">, "children"> {
  items: readonly ProposalChangeSummaryItem[];
  labels: { from: string; to: string; protected: string; empty?: React.ReactNode };
  /** Set on every item besides `data-key` / `data-protected` (e.g. `proposal-change-summary`). */
  itemProps?: DataAttributes;
}

/** What a proposal changes, read-only: key, current → proposed value, protected badge. */
export function ProposalChangeSummary({
  items,
  labels,
  itemProps,
  className,
  ...props
}: ProposalChangeSummaryProps): React.JSX.Element {
  if (items.length === 0 && labels.empty) return <p className="text-xs text-muted-foreground">{labels.empty}</p>;
  return (
    <ul className={cn("flex min-w-0 flex-col gap-3", className)} {...props}>
      {items.map((item) => (
        <li
          {...itemProps}
          key={item.key}
          data-key={item.key}
          data-protected={String(item.protected)}
          className="flex min-w-0 flex-col gap-2 border p-3"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code className="min-w-0 text-xs font-medium wrap-anywhere">{item.label ?? item.key}</code>
            {item.protected ? (
              <StatusBadge tone="warning" icon={SquareLock01Icon}>
                {labels.protected}
              </StatusBadge>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">{labels.from}</span>
              <SettingValue value={item.from} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden className="size-3" />
                {labels.to}
              </span>
              <SettingValue value={item.to} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
