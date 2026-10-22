// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/alert-dialog.tsx";
import { useUiMessages } from "../lib/locale.tsx";
import type { DataAttributes } from "../lib/data-attributes.ts";

export interface ConfirmDialogProps {
  /** Element that opens the dialog (rendered as the trigger, e.g. a `<Button>`). Omit when controlled. */
  trigger?: React.ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Extra content between the description and the buttons. */
  children?: React.ReactNode;
  icon?: IconSvgElement;
  /** Defaults to `messages.confirm`; prefer a verb ("Delete clip"). */
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  /**
   * Runs on confirm. A returned promise keeps the dialog open, with both buttons
   * disabled, until it settles; it closes on success and stays open on failure.
   */
  onConfirm: () => void | Promise<void>;
  /** Called when `onConfirm` throws or rejects (show a toast, for example). */
  onError?: (error: unknown) => void;
  /** `data-*` attributes for the dialog itself (e.g. a test id for this particular dialog). */
  contentProps?: DataAttributes;
}

/** Destructive or consequential confirmation. Use instead of `window.confirm`. */
export function ConfirmDialog({
  trigger,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  title,
  description,
  children,
  icon,
  confirmLabel,
  cancelLabel,
  variant = "default",
  onConfirm,
  onError,
  contentProps,
}: ConfirmDialogProps): React.JSX.Element {
  const messages = useUiMessages();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const [pending, setPending] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const open = openProp ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const handleOpenChange = (next: boolean): void => {
    // While the action runs, Escape and Cancel must not orphan it.
    if (!next && pending) return;
    setOpen(next);
  };

  const handleConfirm = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      if (mounted.current) setOpen(false);
    } catch (error) {
      onError?.(error);
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <AlertDialogTrigger render={trigger} />}
      {/* Focus starts on Cancel: Enter right after opening must never confirm by accident. */}
      <AlertDialogContent {...contentProps} initialFocus={cancelRef}>
        <AlertDialogHeader>
          {icon && (
            <AlertDialogMedia className={variant === "destructive" ? "text-destructive" : undefined}>
              <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden />
            </AlertDialogMedia>
          )}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          {/* Stable test ids: e2e scenarios confirm any dialog the same way (docs/testing). */}
          <AlertDialogCancel ref={cancelRef} disabled={pending} data-testid="confirm-dialog-cancel">
            {cancelLabel ?? messages.cancel}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-dialog-confirm"
            variant={variant === "destructive" ? "destructive" : "default"}
            disabled={pending}
            focusableWhenDisabled
            aria-busy={pending || undefined}
            onClick={() => void handleConfirm()}
          >
            {pending && <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} aria-hidden className="animate-spin" />}
            {confirmLabel ?? messages.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
