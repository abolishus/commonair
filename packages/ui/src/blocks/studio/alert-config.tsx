// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { cn } from "@commonair/ui/lib/utils";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { AmountField } from "../forms/amount-field.tsx";
import { SelectField, type SelectFieldOption } from "../forms/select-field.tsx";
import { SwitchField } from "../forms/switch-field.tsx";

/** `AlertTemplate.animation`. */
export type AlertAnimation = "fade" | "slide" | "none";

/** The editable part of an `AlertConfig` (the template's text fields flattened). */
export interface AlertConfigDraft {
  enabled: boolean;
  /** `template.message`, with `${user}`-style variables. */
  message: string;
  /** `template.showMessage`. */
  showMessage: boolean;
  minAmountCents: number;
  durationMs: number;
  animation: AlertAnimation;
}

/** The contract's bounds (`AlertConfig.durationMs`, `AlertTemplate.message`). */
export const ALERT_DURATION_MIN_MS = 1000;
export const ALERT_DURATION_MAX_MS = 30000;
export const ALERT_MESSAGE_MAX = 200;

/** Variables a template may use (`AlertTemplate.message`). */
export type AlertVariable = "user" | "amount" | "tier" | "viewers" | "message";

/**
 * Fills `${user}`-style variables for a preview. Unknown or missing variables stay as written,
 * so the streamer sees what will not be filled. The API renders the real alert.
 */
export function fillAlertTemplate(message: string, values: Partial<Record<AlertVariable, string>>): string {
  return message.replace(/\$\{(\w+)\}/g, (whole, name: string) => values[name as AlertVariable] ?? whole);
}

export interface AlertConfigLabels {
  enabled: string;
  /** Badge text for the saved state. */
  on: string;
  off: string;
  message: string;
  /** Introduces the variable chips ("Insert a variable"). */
  variables: string;
  messageError: React.ReactNode;
  showMessage?: React.ReactNode;
  minAmount: React.ReactNode;
  minAmountHint?: React.ReactNode;
  minAmountError: React.ReactNode;
  durationSeconds: React.ReactNode;
  durationError: React.ReactNode;
  animation: React.ReactNode;
  /** `fade`, `slide`, `none` with their labels. */
  animations: readonly SelectFieldOption[];
  save: string;
  test: string;
}

export interface AlertConfigCardProps extends Omit<React.ComponentProps<"div">, "children" | "title" | "onError"> {
  /** `ALERT_TYPES` value; set as `data-type`. */
  type: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The saved config: the form resets to it whenever it changes. */
  config: AlertConfigDraft;
  /** Variables offered as chips, e.g. `["user", "amount", "message"]` for tips. */
  variables: readonly AlertVariable[];
  currency: string;
  locale?: string;
  labels: AlertConfigLabels;
  /** Defaults to `type === "tip"`: only tips have an amount threshold. */
  showMinAmount?: boolean;
  /** Explains why the type cannot fire yet (raids); the form stays editable. */
  note?: React.ReactNode;
  onSave: (draft: AlertConfigDraft) => void | Promise<void>;
  onTest: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Live preview of the unsaved draft (e.g. an `<AlertPreview>` fed by `fillAlertTemplate`). */
  preview?: (draft: AlertConfigDraft) => React.ReactNode;
}

const sameDraft = (a: AlertConfigDraft, b: AlertConfigDraft): boolean =>
  a.enabled === b.enabled &&
  a.message === b.message &&
  a.showMessage === b.showMessage &&
  a.minAmountCents === b.minAmountCents &&
  a.durationMs === b.durationMs &&
  a.animation === b.animation;

const isAnimation = (value: string): value is AlertAnimation =>
  value === "fade" || value === "slide" || value === "none";

/**
 * One alert type's settings: enabled, message with variable chips, minimum amount (tips),
 * duration, animation, save and a test alert. Renders `alert-config` with `data-type` and
 * `data-enabled` (the saved state) and the `alert-*` field ids (docs/testing/e6-selectors.md).
 */
export function AlertConfigCard({
  type,
  title,
  description,
  config,
  variables,
  currency,
  locale,
  labels,
  showMinAmount = type === "tip",
  note,
  onSave,
  onTest,
  onError,
  preview,
  className,
  ...props
}: AlertConfigCardProps): React.JSX.Element {
  const id = React.useId();
  const [saved, setSaved] = React.useState(config);
  const [draft, setDraft] = React.useState(config);
  const [durationText, setDurationText] = React.useState(String(config.durationMs / 1000));
  const [amountValid, setAmountValid] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  // A new saved config from the server replaces the draft (adjusting state during render).
  if (!sameDraft(saved, config)) {
    setSaved(config);
    setDraft(config);
    setDurationText(String(config.durationMs / 1000));
  }
  const messageInvalid = draft.message.trim() === "" || draft.message.length > ALERT_MESSAGE_MAX;
  const durationSeconds = Number(durationText);
  const durationInvalid =
    durationText.trim() === "" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds * 1000 < ALERT_DURATION_MIN_MS ||
    durationSeconds * 1000 > ALERT_DURATION_MAX_MS;
  const invalid = messageInvalid || durationInvalid || (showMinAmount && (!amountValid || draft.minAmountCents < 0));
  const dirty = !sameDraft(saved, draft);
  const update = (patch: Partial<AlertConfigDraft>): void => setDraft((current) => ({ ...current, ...patch }));

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (invalid || saving) return;
    setSaving(true);
    try {
      await onSave({ ...draft, message: draft.message.trim() });
    } catch (caught) {
      onError?.(caught);
    } finally {
      setSaving(false);
    }
  };
  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      await onTest();
    } catch (caught) {
      onError?.(caught);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      data-testid="alert-config"
      data-type={type}
      data-enabled={String(saved.enabled)}
      data-dirty={dirty || undefined}
      className={cn("min-w-0", className)}
      {...props}
    >
      <form aria-labelledby={`${id}-title`} onSubmit={(event) => void save(event)} className="contents">
        <CardHeader>
          <CardTitle id={`${id}-title`}>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
          <CardAction>
            <StatusBadge tone={saved.enabled ? "success" : "neutral"}>
              {saved.enabled ? labels.on : labels.off}
            </StatusBadge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
          {preview ? preview(draft) : null}
          <FieldGroup>
            <SwitchField
              label={labels.enabled}
              checked={draft.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
              switchProps={{ "data-testid": "alert-enabled" }}
            />
            <Field data-invalid={messageInvalid || undefined}>
              <FieldLabel htmlFor={`${id}-message`}>{labels.message}</FieldLabel>
              <Input
                id={`${id}-message`}
                data-testid="alert-message"
                maxLength={ALERT_MESSAGE_MAX}
                value={draft.message}
                aria-invalid={messageInvalid || undefined}
                aria-describedby={`${id}-variables`}
                onChange={(event) => update({ message: event.currentTarget.value })}
              />
              <div id={`${id}-variables`} className="flex flex-wrap items-center gap-1">
                <FieldDescription>{labels.variables}</FieldDescription>
                {variables.map((variable) => (
                  <Button
                    key={variable}
                    type="button"
                    variant="outline"
                    size="xs"
                    className="font-mono"
                    data-variable={variable}
                    onClick={() => update({ message: `${draft.message}\${${variable}}`.slice(0, ALERT_MESSAGE_MAX) })}
                  >
                    {`\${${variable}}`}
                  </Button>
                ))}
              </div>
              {messageInvalid ? <FieldError>{labels.messageError}</FieldError> : null}
            </Field>
            {labels.showMessage ? (
              <SwitchField
                label={labels.showMessage}
                checked={draft.showMessage}
                onCheckedChange={(showMessage) => update({ showMessage })}
              />
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {showMinAmount ? (
                <AmountField
                  data-testid="alert-min-amount"
                  label={labels.minAmount}
                  currency={currency}
                  locale={locale}
                  value={draft.minAmountCents}
                  min={0}
                  onValueChange={(minAmountCents) => update({ minAmountCents })}
                  onValidityChange={setAmountValid}
                  rangeError={labels.minAmountError}
                  hint={labels.minAmountHint}
                />
              ) : null}
              <Field data-invalid={durationInvalid || undefined}>
                <FieldLabel htmlFor={`${id}-duration`}>{labels.durationSeconds}</FieldLabel>
                <Input
                  id={`${id}-duration`}
                  data-testid="alert-duration"
                  data-ms={durationInvalid ? "" : Math.round(durationSeconds * 1000)}
                  type="number"
                  inputMode="decimal"
                  min={ALERT_DURATION_MIN_MS / 1000}
                  max={ALERT_DURATION_MAX_MS / 1000}
                  step={0.5}
                  value={durationText}
                  aria-invalid={durationInvalid || undefined}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setDurationText(text);
                    const seconds = Number(text);
                    if (text.trim() !== "" && Number.isFinite(seconds))
                      update({ durationMs: Math.round(seconds * 1000) });
                  }}
                />
                {durationInvalid ? <FieldError>{labels.durationError}</FieldError> : null}
              </Field>
              <SelectField
                label={labels.animation}
                options={labels.animations.map((option) => ({
                  ...option,
                  "data-testid": `alert-animation-option-${option.value}`,
                }))}
                value={draft.animation}
                onValueChange={(value) => {
                  if (isAnimation(value)) update({ animation: value });
                }}
                data-testid="alert-animation"
                data-value={draft.animation}
              />
            </div>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="alert-test"
            disabled={testing}
            aria-busy={testing || undefined}
            onClick={() => void test()}
          >
            {labels.test}
          </Button>
          <Button type="submit" data-testid="alert-save" disabled={invalid || saving} aria-busy={saving || undefined}>
            {labels.save}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
