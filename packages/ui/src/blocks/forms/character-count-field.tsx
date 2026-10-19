// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Textarea } from "@commonair/ui/components/textarea";

export interface CharacterCountFieldProps {
  label: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  maxLength: number;
  multiline?: boolean;
  hint?: React.ReactNode;
  errors?: string | readonly (string | { message?: string } | undefined)[];
  inputProps?: React.ComponentProps<typeof Input>;
  textareaProps?: React.ComponentProps<typeof Textarea>;
  "data-testid"?: string;
}
export function CharacterCountField({
  label,
  value,
  defaultValue = "",
  onValueChange,
  maxLength,
  multiline,
  hint,
  errors,
  inputProps,
  textareaProps,
  ...props
}: CharacterCountFieldProps): React.JSX.Element {
  const [inner, setInner] = React.useState(defaultValue);
  const current = value ?? inner;
  const set = (next: string): void => {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };
  const id = React.useId();
  const near = maxLength - current.length <= Math.max(10, Math.ceil(maxLength * 0.1));
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea
          {...textareaProps}
          id={id}
          maxLength={maxLength}
          value={current}
          onChange={(event) => set(event.currentTarget.value)}
        />
      ) : (
        <Input
          {...inputProps}
          id={id}
          maxLength={maxLength}
          value={current}
          onChange={(event) => set(event.currentTarget.value)}
        />
      )}
      <FieldDescription aria-live={near ? "polite" : undefined}>
        {hint}
        {hint ? " · " : ""}
        {current.length} / {maxLength}
      </FieldDescription>
      <FieldError errors={typeof errors === "string" ? [errors] : errors ? [...errors] : undefined} />
    </Field>
  );
}
