// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { ACCENTS } from "@commonair/contracts/shapes";
import type { Accent } from "../../primitives/channel-avatar.tsx";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";

export interface AccentPickerProps {
  label: React.ReactNode;
  value?: Accent;
  defaultValue?: Accent;
  onValueChange?: (value: Accent) => void;
  labels: Readonly<Record<Accent, string>>;
  "data-testid"?: string;
}
export function AccentPicker({
  label,
  value,
  defaultValue,
  onValueChange,
  labels,
  ...props
}: AccentPickerProps): React.JSX.Element {
  const id = React.useId();
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel id={id}>{label}</FieldLabel>
      <RadioGroup
        aria-labelledby={id}
        className="grid grid-cols-4 gap-2 sm:grid-cols-6"
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => onValueChange?.(next as Accent)}
      >
        {ACCENTS.map((accent) => (
          <FieldLabel
            key={accent}
            htmlFor={`${id}-${accent}`}
            className="flex flex-col items-center gap-1.5 rounded-none border p-2"
          >
            <RadioGroupItem id={`${id}-${accent}`} value={accent} className="sr-only" />
            <span
              aria-hidden
              data-accent={accent}
              className="size-6 rounded-full bg-channel-accent ring-1 ring-foreground/20"
            />
            <span>{labels[accent]}</span>
          </FieldLabel>
        ))}
      </RadioGroup>
    </Field>
  );
}
