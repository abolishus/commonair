// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Switch } from "@commonair/ui/components/switch";

export interface SwitchFieldProps extends Omit<
  React.ComponentProps<typeof Switch>,
  "checked" | "defaultChecked" | "onCheckedChange"
> {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  trailing?: React.ReactNode;
  comingLater?: React.ReactNode;
  switchProps?: Omit<
    React.ComponentProps<typeof Switch>,
    "id" | "checked" | "defaultChecked" | "disabled" | "onCheckedChange"
  > & {
    "data-testid"?: string;
  };
  "data-testid"?: string;
}

export function SwitchField({
  label,
  description,
  trailing,
  comingLater,
  disabled,
  switchProps,
  ...props
}: SwitchFieldProps): React.JSX.Element {
  const id = React.useId();
  return (
    <Field
      orientation="horizontal"
      data-testid={props["data-testid"]}
      data-disabled={disabled || comingLater || undefined}
    >
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {(description || comingLater) && (
          <FieldDescription>
            {description}
            {comingLater && (
              <>
                {" "}
                {description ? "· " : ""}
                {comingLater}
              </>
            )}
          </FieldDescription>
        )}
      </FieldContent>
      {trailing && <div className="shrink-0">{trailing}</div>}
      <Switch id={id} {...props} {...switchProps} disabled={disabled || Boolean(comingLater)} />
    </Field>
  );
}
