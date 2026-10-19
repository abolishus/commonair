// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A labelled single-choice `Select` (Field + FieldLabel + Select parts), used by many boards.
 * Stand-in until `packages/ui/src/blocks/forms` has a `SelectField` composition (contract request);
 * it composes shadcn parts only, with no styling of its own.
 */
import type * as React from "react";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  id: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  hint?: React.ReactNode;
  orientation?: "vertical" | "horizontal";
}

export function SelectField({
  id,
  label,
  value,
  options,
  onValueChange,
  hint,
  orientation = "vertical",
}: SelectFieldProps): React.JSX.Element {
  return (
    <Field orientation={orientation}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select items={[...options]} value={value} onValueChange={(next) => next && onValueChange(next)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}
