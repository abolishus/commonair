// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { UserRemove01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { cn } from "@commonair/ui/lib/utils";
import { formatDateTime } from "../../lib/format.ts";
import { useLocale } from "../../lib/locale.tsx";
import { ConfirmDialog } from "../../primitives/confirm-dialog.tsx";
import { SkeletonGroup, SkeletonText } from "../../primitives/skeletons.tsx";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";

/** `DELETION_STATUSES` → badge tone. */
export function deletionStatusTone(status: string): StatusTone {
  if (status === "scheduled") return "warning";
  if (status === "completed") return "danger";
  return "neutral";
}

export interface DeletionRequestView {
  /** `DELETION_STATUSES` value. */
  status: string;
  statusLabel: string;
  scheduledFor: string;
}

export interface DeletionPanelLabels {
  title: React.ReactNode;
  description?: React.ReactNode;
  request: string;
  confirmTitle: React.ReactNode;
  /** What is removed and what is kept, pseudonymized (ledger, votes, audit history). */
  confirmDescription: React.ReactNode;
  confirmLabel: string;
  /** Label of the typed confirmation ("Type your username to confirm"). */
  confirmUsername: React.ReactNode;
  /** Optional hint under it ("Your username is {username}"). */
  confirmUsernameHint?: (username: string) => React.ReactNode;
  /** "Your account will be deleted on {date}. Until then you can cancel." */
  scheduled: (date: React.ReactNode) => React.ReactNode;
  /** Shown after a cancel ("Deletion canceled. Your account stays."). */
  canceled?: React.ReactNode;
  cancel: string;
}

export interface DeletionPanelProps extends Omit<React.ComponentProps<"div">, "children" | "title" | "onError"> {
  /** The caller's latest deletion request; `null` when there is none. */
  request: DeletionRequestView | null;
  loading?: boolean;
  labels: DeletionPanelLabels;
  /** The caller's username: confirm stays disabled until the typed text matches it (any case). */
  username: string;
  /** Gets the typed username, sent as `me.deletion.request` `{ confirmUsername }`. */
  onRequest: (confirmUsername: string) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  locale?: string;
  timeZone?: string;
}

/**
 * Account deletion: request behind a `ConfirmDialog` that says what is kept, then the scheduled
 * date with a cancel while it is scheduled. Confirming requires typing the username
 * (`deletion-confirm-username`), as the contract's `confirmUsername` does. Renders `deletion-request`, `deletion-status`
 * (`data-status`, `data-scheduled-for`) and `deletion-cancel` (docs/testing/e6-selectors.md).
 */
export function DeletionPanel({
  request,
  loading = false,
  labels,
  username,
  onRequest,
  onCancel,
  onError,
  locale,
  timeZone,
  className,
  ...props
}: DeletionPanelProps): React.JSX.Element {
  const ctx = useLocale();
  const inputId = React.useId();
  const [typed, setTyped] = React.useState("");
  const typedName = typed.trim();
  const matches = typedName !== "" && typedName.toLowerCase() === username.trim().toLowerCase();
  const [canceling, setCanceling] = React.useState(false);
  const scheduled = request?.status === "scheduled";
  const canRequest = !loading && (request === null || request.status === "canceled");
  const cancel = async (): Promise<void> => {
    setCanceling(true);
    try {
      await onCancel();
    } catch (caught) {
      onError?.(caught);
    } finally {
      setCanceling(false);
    }
  };
  const date = request ? new Date(request.scheduledFor) : null;
  return (
    <Card className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        {labels.description ? <CardDescription>{labels.description}</CardDescription> : null}
        {request ? (
          <CardAction>
            <StatusBadge tone={deletionStatusTone(request.status)}>{request.statusLabel}</StatusBadge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading ? (
          <SkeletonGroup>
            <SkeletonText lines={2} />
          </SkeletonGroup>
        ) : request ? (
          <div
            data-testid="deletion-status"
            data-status={request.status}
            data-scheduled-for={request.scheduledFor}
            className="flex flex-col items-start gap-3 border border-warning p-3 text-xs"
          >
            {scheduled && date && !Number.isNaN(date.getTime()) ? (
              <p>
                {labels.scheduled(
                  <time dateTime={date.toISOString()} className="font-medium">
                    {formatDateTime(date, locale ?? ctx.locale, timeZone ?? ctx.timeZone)}
                  </time>,
                )}
              </p>
            ) : request.status === "canceled" && labels.canceled ? (
              <p>{labels.canceled}</p>
            ) : null}
            {scheduled ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="deletion-cancel"
                disabled={canceling}
                aria-busy={canceling || undefined}
                onClick={() => void cancel()}
              >
                {labels.cancel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      {canRequest ? (
        <CardFooter className="justify-end">
          <ConfirmDialog
            trigger={
              <Button type="button" variant="destructive" data-testid="deletion-request">
                {labels.request}
              </Button>
            }
            icon={UserRemove01Icon}
            title={labels.confirmTitle}
            description={labels.confirmDescription}
            confirmLabel={labels.confirmLabel}
            variant="destructive"
            confirmDisabled={!matches}
            onOpenChange={(open) => {
              if (!open) setTyped("");
            }}
            onConfirm={() => onRequest(typedName)}
            onError={onError}
          >
            <Field>
              <FieldLabel htmlFor={inputId}>{labels.confirmUsername}</FieldLabel>
              <Input
                id={inputId}
                data-testid="deletion-confirm-username"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.currentTarget.value)}
              />
              {labels.confirmUsernameHint ? (
                <FieldDescription>{labels.confirmUsernameHint(username)}</FieldDescription>
              ) : null}
            </Field>
          </ConfirmDialog>
        </CardFooter>
      ) : null}
    </Card>
  );
}
