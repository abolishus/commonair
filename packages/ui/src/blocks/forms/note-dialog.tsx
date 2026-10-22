// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@commonair/ui/components/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { useUiMessages } from "../../lib/locale.tsx";

export interface NoteDialogProps {
  /** Element that opens the dialog (e.g. a `<Button data-testid="…">`). */
  trigger: React.ReactElement;
  title: React.ReactNode;
  description?: React.ReactNode;
  noteLabel: React.ReactNode;
  noteHint?: React.ReactNode;
  notePlaceholder?: string;
  /** The note may be left empty (default) or must be written first. */
  noteRequired?: boolean;
  maxLength?: number;
  submitLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * Runs with the trimmed note. A returned promise keeps the dialog open (buttons disabled) until
   * it settles; it closes on success and stays open, showing `errorText`, on failure.
   */
  onSubmit: (note: string) => void | Promise<void>;
  /** Shown when `onSubmit` rejects. */
  errorText?: React.ReactNode;
  onError?: (error: unknown) => void;
  /** Set on the dialog, the note textarea and the submit button (test ids). */
  contentProps?: DataAttributes;
  noteProps?: DataAttributes;
  submitProps?: DataAttributes;
}

/** A confirmation that also takes a short note for the audit reason (a refund note, a minute reference). */
export function NoteDialog({
  trigger,
  title,
  description,
  noteLabel,
  noteHint,
  notePlaceholder,
  noteRequired = false,
  maxLength = 500,
  submitLabel,
  cancelLabel,
  destructive = false,
  onSubmit,
  errorText,
  onError,
  contentProps,
  noteProps,
  submitProps,
}: NoteDialogProps): React.JSX.Element {
  const messages = useUiMessages();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const noteId = React.useId();
  const ready = !noteRequired || note.trim().length > 0;
  const submit = async (): Promise<void> => {
    if (pending || !ready) return;
    setPending(true);
    setFailed(false);
    try {
      await onSubmit(note.trim());
      setOpen(false);
      setNote("");
    } catch (error) {
      setFailed(true);
      onError?.(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        setOpen(next);
        if (!next) setFailed(false);
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent {...contentProps}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <Field data-invalid={failed || undefined}>
            <FieldLabel htmlFor={noteId}>{noteLabel}</FieldLabel>
            <Textarea
              {...noteProps}
              id={noteId}
              value={note}
              maxLength={maxLength}
              placeholder={notePlaceholder}
              required={noteRequired}
              disabled={pending}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            {noteHint ? <FieldDescription>{noteHint}</FieldDescription> : null}
            {failed && errorText ? <FieldError>{errorText}</FieldError> : null}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              {cancelLabel ?? messages.cancel}
            </DialogClose>
            <Button
              {...submitProps}
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={pending || !ready}
              aria-busy={pending || undefined}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
