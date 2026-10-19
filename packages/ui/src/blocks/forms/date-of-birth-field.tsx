// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Field, FieldError, FieldLabel, FieldSet, FieldLegend } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";

export interface DateOfBirthFieldProps {
  label: React.ReactNode;
  value?: string;
  onValueChange?: (isoDate: string | undefined) => void;
  locale?: string;
  monthLabel: string;
  dayLabel: string;
  yearLabel: string;
  invalidDateMessage: string;
  years: readonly number[];
  "data-testid"?: string;
}
export function DateOfBirthField({
  label,
  value,
  onValueChange,
  locale = "en-US",
  monthLabel,
  dayLabel,
  yearLabel,
  invalidDateMessage,
  years,
  ...props
}: DateOfBirthFieldProps): React.JSX.Element {
  const id = React.useId();
  const parsed = value ? new Date(`${value}T00:00:00Z`) : undefined;
  const valid = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  const [innerParts, setInnerParts] = React.useState({
    year: valid ? parsed.getUTCFullYear() : 0,
    month: valid ? parsed.getUTCMonth() + 1 : 0,
    day: valid ? parsed.getUTCDate() : 0,
  });
  const parts =
    value !== undefined && valid && parsed
      ? { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate() }
      : value !== undefined && valid
        ? { year: 0, month: 0, day: 0 }
        : innerParts;
  const months = Array.from({ length: 12 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2020, index, 1))),
  );
  const emit = (next: typeof parts): void => {
    if (value === undefined || !valid) setInnerParts(next);
    if (next.year && next.month && next.day) {
      const date = new Date(Date.UTC(next.year, next.month - 1, next.day));
      if (
        date.getUTCFullYear() === next.year &&
        date.getUTCMonth() === next.month - 1 &&
        date.getUTCDate() === next.day
      )
        onValueChange?.(date.toISOString().slice(0, 10));
      else onValueChange?.(undefined);
    }
  };
  const dayCount = parts.month && parts.year ? new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate() : 31;
  return (
    <FieldSet data-testid={props["data-testid"]}>
      <FieldLegend>{label}</FieldLegend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {[
          [
            monthLabel,
            String(parts.month || ""),
            months.map((name, index) => [String(index + 1), name] as const),
            (month: number) => emit({ ...parts, month }),
          ],
          [
            dayLabel,
            String(parts.day || ""),
            Array.from({ length: dayCount }, (_, i) => [String(i + 1), String(i + 1)] as const),
            (day: number) => emit({ ...parts, day }),
          ],
          [
            yearLabel,
            String(parts.year || ""),
            years.map((year) => [String(year), String(year)] as const),
            (year: number) => emit({ ...parts, year }),
          ],
        ].map(([fieldLabel, selected, options, onSelect]) => (
          <Field key={String(fieldLabel)}>
            <FieldLabel htmlFor={`${id}-${String(fieldLabel)}`}>{String(fieldLabel)}</FieldLabel>
            <Select
              value={String(selected)}
              onValueChange={(next) => {
                if (next) (onSelect as (n: number) => void)(Number(next));
              }}
            >
              <SelectTrigger id={`${id}-${String(fieldLabel)}`} aria-label={String(fieldLabel)}>
                <SelectValue placeholder={String(fieldLabel)} />
              </SelectTrigger>
              <SelectContent>
                {(options as readonly (readonly [string, string])[]).map(([key, name]) => (
                  <SelectItem value={key} key={key}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ))}
      </div>
      {((value && !valid) || (parts.year && parts.month && parts.day && !isValidParts(parts))) && (
        <FieldError errors={[invalidDateMessage]} />
      )}
    </FieldSet>
  );
}

function isValidParts(parts: { year: number; month: number; day: number }): boolean {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return (
    date.getUTCFullYear() === parts.year && date.getUTCMonth() === parts.month - 1 && date.getUTCDate() === parts.day
  );
}
