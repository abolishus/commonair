// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { minorUnits } from "@commonair/contracts/currency";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@commonair/ui/components/input-group";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";

export interface AmountPreset {
  label: React.ReactNode;
  value: number;
}
export interface AmountFieldProps {
  label: React.ReactNode;
  currency: string;
  value: number;
  onValueChange: (minorValue: number) => void;
  locale?: string;
  presets?: readonly AmountPreset[];
  min?: number;
  max?: number;
  rangeError: React.ReactNode;
  errors?: string | readonly (string | { message?: string } | undefined)[];
  hint?: React.ReactNode;
  "data-testid"?: string;
  /** Forwarded to the `<input>`, which also carries `data-cents`: the current value in minor units. */
  inputProps?: React.ComponentProps<typeof InputGroupInput> & {
    "data-testid"?: string;
    [key: `data-${string}`]: unknown;
  };
}
function parseAmount(text: string, currency: string, locale: string): number | null {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const group = parts.find((part) => part.type === "group")?.value;
  let normalized = text.trim();
  if (group) normalized = normalized.split(group).join("");
  if (decimal !== ".") normalized = normalized.replace(decimal, ".");
  if (!/^\d*(?:\.\d*)?$/.test(normalized) || normalized === "" || normalized === ".") return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const digits = minorUnits(currency);
  if (fraction.length > digits) return null;
  const amount = Number(whole) * 10 ** digits + Number((fraction + "0".repeat(digits)).slice(0, digits) || 0);
  return Number.isSafeInteger(amount) ? amount : null;
}
function formatValue(value: number, currency: string, locale: string): string {
  const digits = minorUnits(currency);
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(value / 10 ** digits);
}
export function AmountField({
  label,
  currency,
  value,
  onValueChange,
  locale = "en-US",
  presets = [],
  min,
  max,
  rangeError,
  errors,
  hint,
  inputProps,
  ...props
}: AmountFieldProps): React.JSX.Element {
  const id = React.useId();
  const digits = minorUnits(currency);
  const [draft, setDraft] = React.useState<string | null>(null);
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).formatToParts(0);
  const symbol = parts.find((part) => part.type === "currency")?.value ?? currency;
  const invalid = value < (min ?? Number.MIN_SAFE_INTEGER) || value > (max ?? Number.MAX_SAFE_INTEGER);
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {presets.length > 0 && (
        <ToggleGroup
          aria-label={typeof label === "string" ? label : undefined}
          multiple={false}
          value={[String(value)]}
          onValueChange={(values) => {
            const next = values.at(-1);
            if (next) onValueChange(Number(next));
            setDraft(null);
          }}
        >
          {presets.map((preset) => (
            <ToggleGroupItem key={preset.value} value={String(preset.value)}>
              {preset.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>{symbol}</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          {...inputProps}
          id={id}
          data-cents={value}
          inputMode="decimal"
          value={draft ?? formatValue(value, currency, locale)}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDraft(text);
            const parsed = parseAmount(text, currency, locale);
            if (parsed !== null) onValueChange(parsed);
          }}
          onBlur={() => setDraft(null)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{currency.toUpperCase()}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {invalid && rangeError && <FieldError>{rangeError}</FieldError>}
      {typeof errors === "string" ? <FieldError errors={[errors]} /> : errors && <FieldError errors={[...errors]} />}
    </Field>
  );
}
