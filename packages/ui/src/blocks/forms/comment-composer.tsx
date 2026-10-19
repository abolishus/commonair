// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";

export interface CommentComposerProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  placeholder?: string;
  submitLabel: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit: (value: string) => void | Promise<void>;
  disabled?: boolean;
  textareaProps?: React.ComponentProps<typeof Textarea>;
  buttonProps?: React.ComponentProps<typeof Button>;
  "data-testid"?: string;
  "data-textarea-testid"?: string;
  "data-submit-testid"?: string;
}
export function CommentComposer({
  label,
  hint,
  placeholder,
  submitLabel,
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  disabled,
  textareaProps,
  buttonProps,
  ...props
}: CommentComposerProps): React.JSX.Element {
  const [inner, setInner] = React.useState(defaultValue);
  const current = value ?? inner;
  const id = React.useId();
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        {...textareaProps}
        id={id}
        placeholder={placeholder}
        value={current}
        disabled={disabled}
        onChange={(event) => {
          if (value === undefined) setInner(event.currentTarget.value);
          onValueChange?.(event.currentTarget.value);
        }}
        data-testid={props["data-textarea-testid"]}
      />
      {hint && <FieldDescription>{hint}</FieldDescription>}
      <div className="flex justify-end">
        <Button
          {...buttonProps}
          type="button"
          disabled={disabled || !current.trim()}
          onClick={() => void onSubmit(current)}
          data-testid={props["data-submit-testid"]}
        >
          {submitLabel}
        </Button>
      </div>
    </Field>
  );
}
