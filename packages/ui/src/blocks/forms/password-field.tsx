// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { EyeIcon, EyeOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { InputGroup, InputGroupButton, InputGroupInput } from "@commonair/ui/components/input-group";
import { Progress, ProgressValue } from "@commonair/ui/components/progress";

export interface PasswordFieldProps {
  label: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  showLabel: string;
  hideLabel: string;
  strength?: { value: number; label: string };
  "data-testid"?: string;
  inputProps?: React.ComponentProps<typeof InputGroupInput>;
}
export function PasswordField({
  label,
  value,
  defaultValue = "",
  onValueChange,
  showLabel,
  hideLabel,
  strength,
  inputProps,
  ...props
}: PasswordFieldProps): React.JSX.Element {
  const [inner, setInner] = React.useState(defaultValue);
  const [visible, setVisible] = React.useState(false);
  const current = value ?? inner;
  const id = React.useId();
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          {...inputProps}
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          value={current}
          onChange={(event) => {
            if (value === undefined) setInner(event.currentTarget.value);
            onValueChange?.(event.currentTarget.value);
          }}
        />
        <InputGroupButton aria-label={visible ? hideLabel : showLabel} onClick={() => setVisible((shown) => !shown)}>
          <HugeiconsIcon icon={visible ? EyeOffIcon : EyeIcon} strokeWidth={2} aria-hidden />
        </InputGroupButton>
      </InputGroup>
      {strength && (
        <Progress value={strength.value} aria-label={strength.label}>
          <ProgressValue>{() => strength.label}</ProgressValue>
        </Progress>
      )}
    </Field>
  );
}
