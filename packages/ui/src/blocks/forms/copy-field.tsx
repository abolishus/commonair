// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Copy01Icon, EyeIcon, EyeOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@commonair/ui/components/input-group";
import { Button } from "@commonair/ui/components/button";
import { ConfirmDialog } from "../../primitives/confirm-dialog.tsx";
import { toast } from "@commonair/ui/toast";
import { Hint, FormError, type FormErrors } from "./shared.tsx";

export interface CopyAction {
  label: string;
  confirmTitle?: string;
  confirmDescription?: string;
  destructive?: boolean;
  onAction: () => void | Promise<void>;
  buttonProps?: Omit<React.ComponentProps<typeof Button>, "size">;
}
export interface CopyFieldProps {
  label: string;
  value: string;
  copiedLabel: string;
  copyLabel: string;
  copyFailedLabel: string;
  secret?: boolean;
  showLabel?: string;
  hideLabel?: string;
  hint?: React.ReactNode;
  actions?: readonly CopyAction[];
  valueProps?: React.ComponentProps<typeof InputGroupInput>;
  copyButtonProps?: Omit<React.ComponentProps<typeof Button>, "size">;
  errors?: FormErrors;
  "data-testid"?: string;
  "data-value-testid"?: string;
  "data-copy-testid"?: string;
}
export function CopyField({
  label,
  value,
  copiedLabel,
  copyLabel,
  copyFailedLabel,
  secret,
  showLabel = "Show",
  hideLabel = "Hide",
  hint,
  actions,
  valueProps,
  copyButtonProps,
  errors,
  ...dataProps
}: CopyFieldProps): React.JSX.Element {
  const [visible, setVisible] = React.useState(!secret);
  const [copyError, setCopyError] = React.useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(false);
      toast.success(copiedLabel);
    } catch {
      setCopyError(true);
      toast.error(copyFailedLabel);
    }
  };
  return (
    <div className="flex w-full flex-col gap-1.5" data-testid={dataProps["data-testid"]}>
      <label className="text-xs font-medium">{label}</label>
      <InputGroup>
        <InputGroupInput
          {...valueProps}
          value={visible ? value : "•".repeat(Math.max(8, Math.min(value.length, 32)))}
          readOnly
          data-testid={dataProps["data-value-testid"]}
          data-secret={secret || undefined}
        />
        {secret && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton aria-label={visible ? hideLabel : showLabel} onClick={() => setVisible((show) => !show)}>
              <HugeiconsIcon icon={visible ? EyeOffIcon : EyeIcon} strokeWidth={2} aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        )}
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            {...copyButtonProps}
            aria-label={copyLabel}
            onClick={() => void copy()}
            data-testid={dataProps["data-copy-testid"]}
          >
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden />
            {copyLabel}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {(hint || errors || copyError) && (
        <>
          <Hint>{hint}</Hint>
          <FormError errors={copyError ? copyFailedLabel : errors} />
        </>
      )}
      {actions?.map((action) => (
        <React.Fragment key={action.label}>
          {action.destructive || action.confirmTitle ? (
            <ConfirmDialog
              trigger={
                <Button type="button" variant={action.destructive ? "destructive" : "outline"} {...action.buttonProps}>
                  {action.label}
                </Button>
              }
              title={action.confirmTitle ?? action.label}
              description={action.confirmDescription}
              confirmLabel={action.label}
              variant={action.destructive ? "destructive" : "default"}
              onConfirm={action.onAction}
            />
          ) : (
            <Button type="button" variant="outline" onClick={() => void action.onAction()} {...action.buttonProps}>
              {action.label}
            </Button>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
