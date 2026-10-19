// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";

export interface ChoiceToggleOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}
export interface ChoiceToggleProps {
  label: React.ReactNode;
  options: readonly ChoiceToggleOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "horizontal" | "vertical";
  "data-testid"?: string;
}
export function ChoiceToggle({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  ...props
}: ChoiceToggleProps): React.JSX.Element {
  const id = React.useId();
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup
        aria-labelledby={id}
        multiple={false}
        value={value ? [value] : undefined}
        defaultValue={defaultValue ? [defaultValue] : undefined}
        onValueChange={(next) => {
          const chosen = next.at(-1);
          if (chosen) onValueChange?.(chosen);
        }}
        orientation={orientation}
        variant="outline"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}
