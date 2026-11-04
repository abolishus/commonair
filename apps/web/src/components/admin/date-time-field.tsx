// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A date and time from design-system `Select`s (F33), for `/admin/egress` and the legal queue's
 * "Filed at", instead of the browser's `datetime-local` ("mm/dd/yyyy, --:-- --"). It follows D4's
 * date of birth (`birth-date-field.tsx`): day, month and year in the locale's order, then hour and
 * minute (24 h). The value is the same `YYYY-MM-DDTHH:MM` text the native input produced, so the
 * pages' parsing (`fromUtcInput`, `localDateTimeToIso`) is unchanged; it is "" until every part is
 * chosen. Whether that text is UTC or local time is the page's to say (`description`).
 */
import { monthNames, useLocale } from "@commonair/ui";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { dateFieldOrder, daysInMonth } from "../../lib/birth-date.ts";

export type DateTimePart = "day" | "month" | "year" | "hour" | "minute";

/** null = not chosen. */
export type DateTimeParts = Record<DateTimePart, number | null>;

export const EMPTY_DATE_TIME: DateTimeParts = { day: null, month: null, year: null, hour: null, minute: null };

const VALUE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** The parts of a `YYYY-MM-DDTHH:MM` value; all null for anything else. */
export function dateTimeParts(value: string): DateTimeParts {
  const m = VALUE.exec(value.trim());
  if (!m) return { ...EMPTY_DATE_TIME };
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) };
}

/** `YYYY-MM-DDTHH:MM` for complete parts (the day clamped to the month), or "". */
export function dateTimeValue(parts: DateTimeParts): string {
  const { year, month, day, hour, minute } = parts;
  if (year === null || month === null || day === null || hour === null || minute === null) return "";
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const d = Math.min(day, daysInMonth(year, month));
  return `${pad(year, 4)}-${pad(month)}-${pad(d)}T${pad(hour)}:${pad(minute)}`;
}

/** Years to offer, newest first: `before` years back to `after` years ahead of `now`'s year. */
export function dateTimeYears(now: Date, before = 2, after = 0): number[] {
  const current = now.getUTCFullYear();
  return Array.from({ length: before + after + 1 }, (_, i) => current + after - i);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export interface DateTimeFieldProps {
  label: string;
  /** Under the selects: say here whether the time is UTC or the viewer's own. */
  description?: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Marks the selects invalid and is shown under them. */
  error?: string | null;
  invalid?: boolean;
  /** The year list; `dateTimeYears(now)` by default. */
  years?: readonly number[];
  now?: Date;
  /** On the fieldset; each select gets `<id>-<part>`. */
  "data-testid"?: string;
}

export function DateTimeField({
  label,
  description,
  value,
  onValueChange,
  error,
  invalid = false,
  years,
  now,
  "data-testid": testId,
}: DateTimeFieldProps): React.JSX.Element {
  const { locale } = useLocale();
  const id = React.useId();
  const months = monthNames(locale);
  const dateOrder = dateFieldOrder(locale, months[10] ?? "");
  // Parts chosen so far: a half-filled date has no value yet, but must not lose what was picked.
  const [state, setState] = React.useState(() => ({ value, parts: dateTimeParts(value) }));
  let draft = state.parts;
  if (state.value !== value) {
    // A value from outside (a reset, a default range) replaces the draft; our own echo keeps it.
    draft = dateTimeValue(state.parts) === value ? state.parts : dateTimeParts(value);
    setState({ value, parts: draft });
  }
  const [mountedAt] = React.useState(() => now ?? new Date());
  const yearList = years ?? dateTimeYears(mountedAt);
  const days = daysInMonth(draft.year ?? 0, draft.month ?? 0);
  const options: Record<DateTimePart, { value: string; label: string }[]> = {
    day: Array.from({ length: days }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
    month: months.map((name, i) => ({ value: String(i + 1), label: name })),
    year: yearList.map((y) => ({ value: String(y), label: String(y) })),
    hour: Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: pad2(i) })),
    minute: Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: pad2(i) })),
  };
  const labels: Record<DateTimePart, string> = {
    day: t("polish.birthDate.day"),
    month: t("polish.birthDate.month"),
    year: t("polish.birthDate.year"),
    hour: t("settings.dateTime.hour"),
    minute: t("settings.dateTime.minute"),
  };
  const bad = invalid || Boolean(error);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const choose = (part: DateTimePart, next: number) => {
    const parts = { ...draft, [part]: next };
    // A shorter month pulls the day back to its last day rather than dropping it.
    if (parts.day !== null && parts.year !== null && parts.month !== null)
      parts.day = Math.min(parts.day, daysInMonth(parts.year, parts.month));
    const text = dateTimeValue(parts);
    setState({ value: text, parts });
    onValueChange(text);
  };
  const select = (part: DateTimePart) => (
    <Field key={part} data-invalid={bad || undefined} className="min-w-0">
      <FieldLabel htmlFor={`${id}-${part}`} className="text-xs font-normal text-muted-foreground">
        {labels[part]}
      </FieldLabel>
      <Select<string>
        value={draft[part] === null ? null : String(draft[part])}
        items={options[part]}
        onValueChange={(next) => {
          if (next !== null && next !== "") choose(part, Number(next));
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
    <FieldSet
      data-testid={testId}
      data-value={value}
      aria-describedby={error ? errorId : description ? hintId : undefined}
      className="min-w-0 gap-2"
    >
      <FieldLegend variant="label">{label}</FieldLegend>
      <div className="grid min-w-0 grid-cols-3 gap-2">{dateOrder.map(select)}</div>
      <div className="grid min-w-0 grid-cols-3 gap-2">
        {select("hour")}
        {select("minute")}
      </div>
      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : description ? (
        <FieldDescription id={hintId}>{description}</FieldDescription>
      ) : null}
    </FieldSet>
  );
}
