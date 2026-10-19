// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { EyeIcon, EyeOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
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
  description?: React.ReactNode;
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
  description,
  inputProps,
  ...props
}: PasswordFieldProps): React.JSX.Element {
  const [inner, setInner] = React.useState(defaultValue);
  const [visible, setVisible] = React.useState(false);
  const current = value ?? inner;
  const id = React.useId();
  const descriptionId = `${id}-description`;
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          aria-describedby={description ? descriptionId : undefined}
          {...inputProps}
          id={id}
          type={visible ? "text" : "password"}
          // Sign-up default; sign-in passes inputProps.autoComplete="current-password".
          autoComplete={inputProps?.autoComplete ?? "new-password"}
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
      {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      {strength && (
        <Progress value={strength.value} aria-label={strength.label}>
          <ProgressValue>{() => strength.label}</ProgressValue>
        </Progress>
      )}
    </Field>
  );
}
