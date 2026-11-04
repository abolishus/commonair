// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A date and a time as design-system selects (F33), in the locale's date order, instead of the
 * browser's `datetime-local`. The date half is D4's birth-date field generalized (any years, an
 * optional value with a clear button); the time half is an hour and a minute. Each select has a
 * visible label, and the fieldset is described by the hint and the error.
 */
import { monthNames, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { dateFieldOrder, daysInMonth, type DatePart } from "../../lib/birth-date.ts";
import { EMPTY_DATE_TIME, HOURS, MINUTES, isEmptyDateTime, pad2, type DateTimeParts } from "./date-time.ts";

type Part = DatePart | "hour" | "minute";

export interface DateTimeFieldProps {
  legend: React.ReactNode;
  value: DateTimeParts;
  onValueChange: (next: DateTimeParts) => void;
  /** The years the year select offers. */
  years: readonly number[];
  hint?: React.ReactNode;
  error?: string | null;
  /** Prefix of each select's test id (`<prefix>-day`, `-month`, `-year`, `-hour`, `-minute`). */
  "data-testid"?: string;
}

export function DateTimeField({
  legend,
  value,
  onValueChange,
  years,
  hint,
  error,
  "data-testid": testId,
}: DateTimeFieldProps): React.JSX.Element {
  const { locale } = useLocale();
  const id = React.useId();
  const months = monthNames(locale);
  const order = dateFieldOrder(locale, months[10] ?? "");
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const options: Record<Part, { value: string; label: string }[]> = {
    day: Array.from({ length: daysInMonth(value.year, value.month) }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1),
    })),
    month: months.map((label, i) => ({ value: String(i + 1), label })),
    year: years.map((year) => ({ value: String(year), label: String(year) })),
    hour: HOURS.map((h) => ({ value: String(h), label: pad2(h) })),
    minute: MINUTES.map((m) => ({ value: String(m), label: pad2(m) })),
  };
  const labels: Record<Part, string> = {
    day: t("polish.birthDate.day"),
    month: t("polish.birthDate.month"),
    year: t("polish.birthDate.year"),
    hour: t("studio.dateTime.hour"),
    minute: t("studio.dateTime.minute"),
  };
  const current = (part: Part): string | null => {
    const v = value[part];
    if (part === "hour" || part === "minute") return v === null ? null : String(v);
    return v ? String(v) : null;
  };
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const select = (part: Part) => (
    <Field key={part} data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={`${id}-${part}`}>{labels[part]}</FieldLabel>
      <Select<string>
        value={current(part)}
        items={options[part]}
        onValueChange={(next) => {
          if (next === null) return;
          const n = Number(next);
          onValueChange({ ...value, [part]: n });
        }}
      >
        <SelectTrigger
          id={`${id}-${part}`}
          data-testid={testId ? `${testId}-${part}` : undefined}
          aria-invalid={error ? true : undefined}
          className="w-full"
        >
          <SelectValue placeholder={labels[part]} />
        </SelectTrigger>
        <SelectContent>
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
    <FieldSet data-testid={testId} data-order={order.join(",")} aria-describedby={describedBy}>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{order.map(select)}</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {select("hour")}
        {select("minute")}
      </div>
      {hint && <FieldDescription id={hintId}>{hint}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {!isEmptyDateTime(value) && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={testId ? `${testId}-clear` : undefined}
            onClick={() => onValueChange({ ...EMPTY_DATE_TIME })}
          >
            {t("studio.dateTime.clear")}
          </Button>
        </div>
      )}
    </FieldSet>
  );
}
