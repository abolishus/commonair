// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { ArrowDown01Icon, ArrowRight02Icon, SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { SettingValue } from "./proposal-changes.tsx";

export interface ProtectedBadgeProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** "Protected". */
  label: string;
}

/**
 * The lock on a protected setting or decision (overhaul D6.2): neutral, an icon and the word,
 * never the brand and never a warning (a protected rule is not a problem).
 */
export function ProtectedBadge({ label, ...props }: ProtectedBadgeProps): React.JSX.Element {
  return (
    <StatusBadge data-slot="protected-badge" tone="neutral" icon={SquareLock01Icon} {...props}>
      {label}
    </StatusBadge>
  );
}

export interface SettingChangeField {
  id: string;
  label: React.ReactNode;
  /** Formatted current value; null when the setting does not have the field yet. */
  from: React.ReactNode | null;
  to: React.ReactNode | null;
}

export interface SettingChangeLabels {
  /** Screen-reader word between the two values ("to"). */
  to: string;
  /** Shown for a missing side ("not set"). */
  none: string;
  /** "Technical details" (the raw values). */
  technical: string;
  /** Inside the details: "Current value" / "Proposed value". */
  currentValue: string;
  proposedValue: string;
  /** "Setting key" before the raw key. */
  key: string;
}

export interface SettingChangeViewProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  settingKey: string;
  title: React.ReactNode;
  /** The whole setting before and after, in one line each. */
  fromSummary: React.ReactNode;
  toSummary: React.ReactNode;
  /** The fields that change ("Creator share: 90% → 85%"). */
  fields: readonly SettingChangeField[];
  /** A note under the fields ("Other technical fields change too"). */
  note?: React.ReactNode;
  /** The lock badge when the setting is protected. */
  protectedLabel?: string;
  from: unknown;
  to: unknown;
  labels: SettingChangeLabels;
  /** Set on the technical details trigger. */
  detailsTriggerProps?: DataAttributes;
}

/** "90% → 85%", the new value marked; the arrow is decorative and read as "to". */
export function ChangeArrow({
  from,
  to,
  labels,
}: {
  from: React.ReactNode | null;
  to: React.ReactNode | null;
  labels: Pick<SettingChangeLabels, "to" | "none">;
}): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 tabular-nums">
      <span data-slot="change-from" className="text-muted-foreground line-through decoration-muted-foreground/60">
        {from ?? labels.none}
      </span>
      <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden className="size-3.5 shrink-0 rtl:rotate-180" />
      <span className="sr-only">{labels.to}</span>
      <mark data-slot="change-to" className="bg-accent px-1 font-medium text-accent-foreground">
        {to ?? labels.none}
      </mark>
    </span>
  );
}

/** Raw values behind a disclosure: for the curious and for auditing, never the main reading. */
export function TechnicalDetails({
  settingKey,
  values,
  labels,
  triggerProps,
}: {
  settingKey: string;
  values: readonly { label: React.ReactNode; value: unknown }[];
  labels: Pick<SettingChangeLabels, "technical" | "key">;
  triggerProps?: DataAttributes;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger
        {...triggerProps}
        render={<Button type="button" variant="ghost" size="xs" className="-ms-2 text-muted-foreground" />}
      >
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          aria-hidden
          data-icon="inline-start"
          className={cn("transition-transform motion-reduce:transition-none", !open && "-rotate-90")}
        />
        {labels.technical}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col gap-2 pt-2">
        <p className="text-xs text-muted-foreground">
          {labels.key} <code className="font-mono wrap-anywhere">{settingKey}</code>
        </p>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {values.map((v, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">{v.label}</span>
              <SettingValue value={v.value} />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One setting a proposal changes, in words (overhaul D6.2): the title, the whole setting before →
 * after, each changed field as "90% → 85%" with the new value marked, and the raw JSON only under
 * "Technical details".
 */
export function SettingChangeView({
  settingKey,
  title,
  fromSummary,
  toSummary,
  fields,
  note,
  protectedLabel,
  from,
  to,
  labels,
  detailsTriggerProps,
  className,
  ...props
}: SettingChangeViewProps): React.JSX.Element {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 border p-3", className)} {...props}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 text-sm font-medium wrap-anywhere">{title}</span>
        {protectedLabel ? <ProtectedBadge label={protectedLabel} /> : null}
      </div>
      <p className="text-sm wrap-anywhere">
        <ChangeArrow from={fromSummary} to={toSummary} labels={labels} />
      </p>
      {fields.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1.5 text-xs">
          {fields.map((f) => (
            <li key={f.id} data-field={f.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-muted-foreground">{f.label}</span>
              <ChangeArrow from={f.from} to={f.to} labels={labels} />
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      <TechnicalDetails
        settingKey={settingKey}
        labels={labels}
        triggerProps={detailsTriggerProps}
        values={[
          { label: labels.currentValue, value: from },
          { label: labels.proposedValue, value: to },
        ]}
      />
    </div>
  );
}
