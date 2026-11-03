// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sign-up date of birth (F17): three design-system `Select`s in the locale's order instead of
 * the native `mm/dd/yyyy` input, which looked and read differently in every browser. The fieldset
 * keeps the e1 test id `signup-birthdate`; each select has its own (`-day`, `-month`, `-year`), and
 * the form still submits one `birthDate` value.
 */
import { monthNames, useLocale } from "@commonair/ui";
import { FieldError, FieldLabel, FieldLegend, FieldSet, Field } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import * as React from "react";
import { t } from "../i18n/index.ts";
import {
  birthYears,
  dateFieldOrder,
  daysInMonth,
  isoFromParts,
  type DatePart,
  type DateParts,
} from "../lib/birth-date.ts";

export interface BirthDateFieldProps {
  value: DateParts;
  onValueChange: (next: DateParts) => void;
  /** Shown under the selects, and marks them invalid. */
  error?: string | null;
  /** For the year list; the request time on the server, so both renders agree. */
  now: Date;
}

export function BirthDateField({ value, onValueChange, error, now }: BirthDateFieldProps): React.JSX.Element {
  const { locale } = useLocale();
  const id = React.useId();
  const months = monthNames(locale);
  const order = dateFieldOrder(locale, months[10] ?? "");
  const errorId = `${id}-error`;
  // Written when the selects change, never by React's render: a hidden input's value is its
  // `value` attribute, so a `defaultValue` prop would reset it on every re-render, including a
  // value set on the input directly (a test, an autofill extension).
  const iso = isoFromParts(value);
  const hidden = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (hidden.current) hidden.current.value = iso;
  }, [iso]);
  const options: Record<DatePart, { value: string; label: string }[]> = {
    day: Array.from({ length: daysInMonth(value.year, value.month) }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1),
    })),
    month: months.map((label, i) => ({ value: String(i + 1), label })),
    year: birthYears(now).map((year) => ({ value: String(year), label: String(year) })),
  };
  const labels: Record<DatePart, string> = {
    day: t("polish.birthDate.day"),
    month: t("polish.birthDate.month"),
    year: t("polish.birthDate.year"),
  };
  const testIds: Record<DatePart, string> = {
    day: "signup-birthdate-day",
    month: "signup-birthdate-month",
    year: "signup-birthdate-year",
  };
  return (
    <FieldSet
      data-testid="signup-birthdate"
      data-order={order.join(",")}
      aria-describedby={error ? errorId : undefined}
    >
      <FieldLegend variant="label">{t("field.birthDate")}</FieldLegend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {order.map((part) => (
          <Field key={part} data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={`${id}-${part}`}>{labels[part]}</FieldLabel>
            <Select<string>
              value={value[part] ? String(value[part]) : null}
              items={options[part]}
              onValueChange={(next) => {
                if (next) onValueChange({ ...value, [part]: Number(next) });
              }}
            >
              <SelectTrigger
                id={`${id}-${part}`}
                data-testid={testIds[part]}
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
        ))}
      </div>
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {/* The form's one `birthDate` value (YYYY-MM-DD), as the native input sent it: the form reads
          it with FormData, so the three selects stay a presentation of a single field. */}
      <input ref={hidden} type="hidden" name="birthDate" />
    </FieldSet>
  );
}
