// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";

export interface ChoiceToggleOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  "data-testid"?: string;
}
export interface ChoiceToggleProps {
  label: React.ReactNode;
  options: readonly ChoiceToggleOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "horizontal" | "vertical";
  /** Wrap the options onto more rows instead of overflowing (many presets at 320 px). */
  wrap?: boolean;
  "data-testid"?: string;
}
export function ChoiceToggle({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  wrap = false,
  ...props
}: ChoiceToggleProps): React.JSX.Element {
  const id = React.useId();
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup
        aria-labelledby={id}
        multiple={false}
        // Controlled whenever `value` is passed: "" (nothing chosen) presses no item.
        value={value === undefined ? undefined : value ? [value] : []}
        defaultValue={defaultValue ? [defaultValue] : undefined}
        onValueChange={(next) => {
          const chosen = next.at(-1);
          if (chosen) onValueChange?.(chosen);
        }}
        orientation={orientation}
        variant="outline"
        className={wrap ? "flex-wrap" : undefined}
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            data-testid={option["data-testid"]}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}
