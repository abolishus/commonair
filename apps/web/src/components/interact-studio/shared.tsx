// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pieces `/interact` and `/bot` share: labelled fields, the load error, section cards and polling. */
import { ConfirmDialog, IconButton } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { SwitchField } from "@commonair/ui/blocks/forms";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Textarea } from "@commonair/ui/components/textarea";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import * as React from "react";
import type { Api } from "../../lib/api.ts";

/** The parts of the API the studio pages call (tests pass a fake). */
export type StudioApi = Pick<Api, "interact" | "bot" | "channels">;

export interface TextFieldProps {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** The field's e2e id, set on the input itself. */
  "data-testid": string;
  error?: string;
  description?: React.ReactNode;
  /** Numeric keypad on phones; the value stays text and is parsed on submit. */
  numeric?: boolean;
  /** A keypad with a decimal separator (amounts in major units). */
  decimal?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

/** A labelled input (or textarea) with its description and error wired for assistive tech. */
export function TextField({
  label,
  value,
  onChange,
  "data-testid": testId,
  error,
  description,
  numeric = false,
  decimal = false,
  multiline = false,
  disabled,
  placeholder,
}: TextFieldProps): React.JSX.Element {
  const id = React.useId();
  const describedBy = [description ? `${id}-description` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  const shared = {
    id,
    value,
    disabled,
    placeholder,
    autoComplete: "off",
    "data-testid": testId,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
  };
  return (
    <Field data-invalid={error ? true : undefined} data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea {...shared} rows={3} onChange={(e) => onChange(e.currentTarget.value)} />
      ) : (
        <Input
          {...shared}
          type="text"
          inputMode={decimal ? "decimal" : numeric ? "numeric" : undefined}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
      {description ? <FieldDescription id={`${id}-description`}>{description}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A labelled switch; the test id sits on the switch itself (what a person clicks). */
export function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled,
  "data-testid": testId,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "data-testid": string;
}): React.JSX.Element {
  return (
    <SwitchField
      label={label}
      description={description}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      switchProps={{ "data-testid": testId }}
    />
  );
}

/**
 * An icon-only control that asks first (remove a command or a timer). `IconButton` wraps its
 * button in a tooltip, so the dialog is controlled here instead of using it as the trigger.
 */
export function ConfirmIconButton({
  icon,
  label,
  title,
  description,
  confirmLabel,
  onConfirm,
  onError,
  "data-testid": testId,
}: {
  icon: IconSvgElement;
  label: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onError: (err: unknown) => void;
  "data-testid": string;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <IconButton type="button" icon={icon} label={label} data-testid={testId} onClick={() => setOpen(true)} />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        variant="destructive"
        onConfirm={onConfirm}
        onError={onError}
      />
    </>
  );
}

/** A section of a studio page: a card with an icon, a title and an optional header action. */
export function StudioSection({
  icon,
  title,
  description,
  action,
  children,
  ...props
}: {
  icon: IconSvgElement;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  "data-testid"?: string;
}): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0" {...props}>
      <Card className="h-full">
        <CardHeader>
          <CardTitle id={headingId} className="flex items-center gap-2">
            <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden className="size-4 shrink-0" />
            {title}
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
          {action ? <CardAction>{action}</CardAction> : null}
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-6">{children}</CardContent>
      </Card>
    </section>
  );
}

/** A page's load error (`interact-load-error`, `bot-load-error`) with its retry button. */
export function StudioLoadError({
  message,
  retry,
  ...props
}: {
  message: string;
  /** The retry button (it carries its own test id). */
  retry: React.ReactNode;
  "data-testid": string;
}): React.JSX.Element {
  return <AlertCallout tone="danger" live description={message} action={retry} {...props} />;
}

/**
 * Call `refresh` every `ms` while `active` (live counts, a raid countdown). A failed refresh is
 * ignored: the next one tries again, and the last good state stays on screen.
 */
export function usePolling(active: boolean, ms: number, refresh: () => Promise<void>): void {
  const ref = React.useRef(refresh);
  React.useEffect(() => {
    ref.current = refresh;
  });
  React.useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      timer = setTimeout(() => {
        ref
          .current()
          .catch(() => undefined)
          .finally(() => {
            if (!stopped) tick();
          });
      }, ms);
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, ms]);
}

/**
 * State that both actions and a background refresh write. A refresh that started before the
 * latest action is dropped, so a slow poll never puts back what an action just replaced.
 */
export function useLiveState<T>(
  initial: T,
): [T, (next: React.SetStateAction<T>) => void, (load: () => Promise<T>) => Promise<void>] {
  const [value, setValue] = React.useState(initial);
  const version = React.useRef(0);
  const set = React.useCallback((next: React.SetStateAction<T>) => {
    version.current++;
    setValue(next);
  }, []);
  const refresh = React.useCallback(async (load: () => Promise<T>) => {
    const started = version.current;
    const next = await load();
    if (started === version.current) setValue(next);
  }, []);
  return [value, set, refresh];
}

/** The current time, re-read every `ms` while `active` (a cooldown that ends on its own). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
