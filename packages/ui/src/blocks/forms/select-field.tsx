// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import type { FormErrors } from "./shared.tsx";

export interface SelectFieldOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Forwarded to the option's `SelectItem` (e2e selectors for one item). */
  "data-testid"?: string;
}

export interface SelectFieldProps {
  label: React.ReactNode;
  options: readonly SelectFieldOption[];
  /** Controlled value; pair with `onValueChange`. */
  value?: string;
  /** Initial value when uncontrolled. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  description?: React.ReactNode;
  error?: FormErrors;
  orientation?: "vertical" | "horizontal" | "responsive";
  disabled?: boolean;
  /** Trigger id; generated when omitted. */
  id?: string;
  /** Form field name (submitted with a native form). */
  name?: string;
  /** Text shown when no option is selected. */
  placeholder?: string;
  className?: string;
  triggerProps?: Omit<React.ComponentProps<typeof SelectTrigger>, "id" | "children"> & {
    [key: `data-${string}`]: string | undefined;
  };
  [key: `data-${string}`]: string | undefined;
}

/**
 * A labelled single-choice `Select` on `Field`: the label names the trigger, the description and
 * error describe it, and an error marks the trigger invalid.
 */
export function SelectField({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  description,
  error,
  orientation = "vertical",
  disabled,
  id,
  name,
  placeholder,
  className,
  triggerProps,
  ...dataProps
}: SelectFieldProps): React.JSX.Element {
  const generated = React.useId();
  const triggerId = id ?? generated;
  const descriptionId = `${triggerId}-description`;
  const errorId = `${triggerId}-error`;
  const invalid = Boolean(error && (typeof error === "string" || error.length > 0));
  const describedBy = [description ? descriptionId : null, invalid ? errorId : null].filter(Boolean).join(" ");
  return (
    <Field
      orientation={orientation}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
      className={className}
      {...dataProps}
    >
      <FieldLabel htmlFor={triggerId}>{label}</FieldLabel>
      <Select
        items={options.map((option) => ({ value: option.value, label: option.label }))}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => {
          if (typeof next === "string") onValueChange?.(next);
        }}
        disabled={disabled}
        name={name}
      >
        <SelectTrigger
          {...triggerProps}
          id={triggerId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy || undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              data-testid={option["data-testid"]}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {invalid ? <FieldError id={errorId} errors={typeof error === "string" ? [error] : [...(error ?? [])]} /> : null}
    </Field>
  );
}
