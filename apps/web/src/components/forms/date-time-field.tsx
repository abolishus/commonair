// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A date and a time as design-system selects (F33), in the locale's date order, instead of the
 * browser's `datetime-local`. One field for the whole app: crew's split window (5-minute steps,
 * clearable, parts), `/admin/egress` and the legal queue's "Filed at" (every minute, the
 * `YYYY-MM-DDTHH:MM` text). Hours are on the locale's own clock (`formatHour`: "3 PM", "15").
 * Each select has a visible label; the fieldset is described by the hint and the error. Whether
 * the time is UTC or the viewer's own is the page's to say (`hint`).
 */
import { formatHour, monthNames, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { dateFieldOrder } from "../../lib/birth-date.ts";
import {
  EMPTY_DATE_TIME,
  HOURS,
  dateTimeParts,
  dateTimeValue,
  dateTimeYears,
  isEmptyDateTime,
  maxDay,
  minuteOptions,
  pad2,
  withOption,
  withPart,
  type DateTimePart,
  type DateTimeParts,
} from "./date-time.ts";

interface CommonProps {
  legend: React.ReactNode;
  /** Under the selects (kept when there is an error): say here whether the time is UTC or local. */
  hint?: React.ReactNode;
  /** Marks the selects invalid and is shown under them. */
  error?: string | null;
  /** Marks the selects invalid without a message of its own (a range error shown elsewhere). */
  invalid?: boolean;
  /** The years the year select offers, in the order given; `dateTimeYears(now)` by default. */
  years?: readonly number[];
  /** For the default year list; the mount time when absent. */
  now?: Date;
  /** The minute select's step: 1 (every minute, the default) or e.g. 5. Must divide 60. */
  minuteStep?: number;
  /** A Clear button once anything is chosen (an optional field). */
  clearable?: boolean;
  /**
   * Focus left the whole field (not into one of its own select popups): the form's "touched" cue
   * for showing errors after blur (F32 timing).
   */
  onBlur?: () => void;
  /** On the fieldset; each select gets `<id>-day|month|year|hour|minute`, Clear `<id>-clear`. */
  "data-testid"?: string;
}

export interface DateTimeFieldProps extends CommonProps {
  value: DateTimeParts;
  onValueChange: (next: DateTimeParts) => void;
  /** The fieldset's `data-value`; `dateTimeValue(value)` by default. */
  valueText?: string;
}

/** The field, controlled by its parts (each null until chosen). */
export function DateTimeField({
  legend,
  value,
  onValueChange,
  valueText,
  years,
  now,
  minuteStep = 1,
  clearable = false,
  hint,
  error,
  invalid = false,
  onBlur,
  "data-testid": testId,
}: DateTimeFieldProps): React.JSX.Element {
  const { locale } = useLocale();
  const id = React.useId();
  const months = monthNames(locale);
  const order = dateFieldOrder(locale, months[10] ?? "");
  const [mountedAt] = React.useState(() => now ?? new Date());
  const yearList = withOption(years ?? dateTimeYears(mountedAt), value.year);
  const minutes = withOption(minuteOptions(minuteStep), value.minute);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const bad = invalid || Boolean(error);
  const options: Record<DateTimePart, { value: string; label: string }[]> = {
    day: Array.from({ length: maxDay(value) }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
    month: months.map((label, i) => ({ value: String(i + 1), label })),
    year: yearList.map((year) => ({ value: String(year), label: String(year) })),
    hour: HOURS.map((h) => ({ value: String(h), label: formatHour(h, locale) })),
    minute: minutes.map((m) => ({ value: String(m), label: pad2(m) })),
  };
  const labels: Record<DateTimePart, string> = {
    day: t("polish.birthDate.day"),
    month: t("polish.birthDate.month"),
    year: t("polish.birthDate.year"),
    hour: t("time.field.hour"),
    minute: t("time.field.minute"),
  };
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const select = (part: DateTimePart) => (
    <Field key={part} data-invalid={bad || undefined} className="min-w-0">
      <FieldLabel htmlFor={`${id}-${part}`} className="text-xs font-normal text-muted-foreground">
        {labels[part]}
      </FieldLabel>
      <Select<string>
        value={value[part] === null ? null : String(value[part])}
        items={options[part]}
        onValueChange={(next) => {
          if (next !== null && next !== "") onValueChange(withPart(value, part, Number(next)));
        }}
      >
        <SelectTrigger
          id={`${id}-${part}`}
          data-testid={testId ? `${testId}-${part}` : undefined}
          aria-invalid={bad || undefined}
          className="w-full"
        >
          <SelectValue placeholder={labels[part]} />
        </SelectTrigger>
        <SelectContent data-field={id}>
          {options[part].map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
  return (
    <FieldSet
      data-testid={testId}
      data-order={order.join(",")}
      data-value={valueText ?? dateTimeValue(value)}
      data-minute-step={minuteStep}
      aria-describedby={describedBy}
      className="min-w-0 gap-2"
      onBlur={(e) => {
        const next = e.relatedTarget;
        // Opening one of this field's selects moves focus into its (portalled) popup: still inside
        // the field. Another field's popup is outside it.
        const popup = next instanceof Element ? next.closest('[data-slot="select-content"]') : null;
        if (next instanceof Element && (e.currentTarget.contains(next) || popup?.getAttribute("data-field") === id))
          return;
        onBlur?.();
      }}
    >
      <FieldLegend variant="label">{legend}</FieldLegend>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">{order.map(select)}</div>
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
        {select("hour")}
        {select("minute")}
      </div>
      {hint && <FieldDescription id={hintId}>{hint}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {clearable && !isEmptyDateTime(value) && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={testId ? `${testId}-clear` : undefined}
            onClick={() => onValueChange({ ...EMPTY_DATE_TIME })}
          >
            {t("time.field.clear")}
          </Button>
        </div>
      )}
    </FieldSet>
  );
}

export interface DateTimeTextFieldProps extends CommonProps {
  /** `YYYY-MM-DDTHH:MM`, or "" while not every part is chosen. */
  value: string;
  onValueChange: (value: string) => void;
}

/**
 * The field over the `YYYY-MM-DDTHH:MM` text the native input produced, so the pages' parsing
 * (`fromUtcInput`, `localDateTimeToIso`) is unchanged. It emits "" until every part is chosen, and
 * keeps a half-filled date meanwhile.
 */
export function DateTimeTextField({ value, onValueChange, ...rest }: DateTimeTextFieldProps): React.JSX.Element {
  const [state, setState] = React.useState(() => ({ value, parts: dateTimeParts(value) }));
  let draft = state.parts;
  if (state.value !== value) {
    // A value from outside (a reset, a default range) replaces the draft; our own echo keeps it.
    draft = dateTimeValue(state.parts) === value ? state.parts : dateTimeParts(value);
    setState({ value, parts: draft });
  }
  return (
    <DateTimeField
      {...rest}
      value={draft}
      valueText={value}
      onValueChange={(parts) => {
        const text = dateTimeValue(parts);
        setState({ value: text, parts });
        onValueChange(text);
      }}
    />
  );
}
