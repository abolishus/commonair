// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings page pattern (overhaul wave 4, D7.1; account-admin.md P1): every `/settings/*`
 * page is a `PageHeader` then `SettingsSection`s holding `SettingsRow`s (label and hint on the
 * left, the control on the right, stacked below `sm`). A destructive section is last, as a
 * `DangerZone`: a destructive ring and title, no fill and never the brand.
 */
import type * as React from "react";
import { useId } from "react";
import { Label } from "@commonair/ui/components/label";
import { cn } from "@commonair/ui/lib/utils";

export interface SettingsSectionProps extends Omit<React.ComponentProps<"section">, "title"> {
  title: React.ReactNode;
  /** What changes for the member ("Channels see this name in chat and on your profile"). */
  description?: React.ReactNode;
  /** A control beside the title (for example "Sign out everywhere else"). */
  action?: React.ReactNode;
  children: React.ReactNode;
  /** Extra classes for the title (the danger zone's destructive colour). */
  titleClassName?: string;
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
  titleClassName,
  ...props
}: SettingsSectionProps): React.JSX.Element {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-slot="settings-section"
      className={cn("min-w-0 bg-card text-card-foreground ring-1 ring-foreground/10", className)}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 id={id} className={cn("text-lg font-medium", titleClassName)}>
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="divide-y">{children}</div>
    </section>
  );
}

export interface SettingsRowProps extends Omit<React.ComponentProps<"div">, "title"> {
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** The control (switch, select, button). Label it by `controlId` or its own aria-label. */
  children?: React.ReactNode;
  /** The control's id, so the label is a real `<label for>`. */
  controlId?: string;
}

export function SettingsRow({
  label,
  hint,
  children,
  controlId,
  className,
  ...props
}: SettingsRowProps): React.JSX.Element {
  const hintId = useId();
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 sm:max-w-prose">
        {controlId ? (
          <Label htmlFor={controlId} className="text-sm font-medium">
            {label}
          </Label>
        ) : (
          <div className="text-sm font-medium">{label}</div>
        )}
        {hint ? (
          <p id={hintId} className="mt-1 text-sm text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

export interface DangerZoneProps extends SettingsSectionProps {}

/** The last section of a page, for destructive actions: a destructive ring and title, no fill. */
export function DangerZone({ className, ...props }: DangerZoneProps): React.JSX.Element {
  return (
    <SettingsSection
      data-slot="danger-zone"
      className={cn("ring-destructive/60", className)}
      titleClassName="text-destructive"
      {...props}
    />
  );
}
