// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Privacy & data's danger zone (D7.4, account-admin.md P6, journey J6): the grace period stated up
 * front, then one AlertDialog in three steps: (1) what changes, from `me.deletion.preview` (what
 * the deletion job really does: services/worker/src/deletion/money.ts), (2) "I downloaded my data
 * or don't need it", with Download now inline, (3) the username typed. While a deletion is
 * scheduled the zone shows its date and Cancel deletion instead.
 */
import type { DeletionPreview } from "@commonair/contracts/dto";
import { ConfirmDialog, MoneyAmount, SkeletonText, StatusBadge } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { DangerZone } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Label } from "@commonair/ui/components/label";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { errorRequirement } from "../../lib/coop.ts";
import { fillNode } from "../../lib/fill.tsx";
import { exportRows } from "../../lib/privacy.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { onExportError, type ExportsState } from "../privacy-panels.tsx";
import { DeletionDate } from "./deletion-banner.tsx";
import { scheduledRequest, useDeletion, type DeletionClient } from "./deletion-state.tsx";
import { canConfirm, impactLines, type ImpactLine } from "./delete-model.ts";

/** The configured grace when the preview has not answered (services/api `DELETION_GRACE_DAYS`). */
const FALLBACK_GRACE_DAYS = 30;

/**
 * Why the request failed: the provider could not stop a subscription renewing (ADR 0042), so
 * nothing was scheduled; anything else is the general failure.
 */
export function deletionRequestErrorText(err: unknown): string {
  return errorRequirement(err) === "payment_provider"
    ? t("w5Deletion.renewalStopFailed")
    : t("privacy.deletion.failed");
}

export type PreviewLoader = () => Promise<DeletionPreview>;
const loadPreview: PreviewLoader = () => Promise.resolve().then(() => api().me.deletion.preview());

function ImpactItem({ line }: { line: ImpactLine }): React.JSX.Element {
  switch (line.kind) {
    case "removed":
      return <>{t("d7Settings.delete.impact.removed")}</>;
    case "kept":
      return <>{t("d7Settings.delete.impact.kept")}</>;
    case "subscriptions":
      return (
        <>
          {t("w5Deletion.impact.subscriptions", { count: line.count })}{" "}
          <Link to="/settings/subscriptions" className="underline underline-offset-4">
            {t("w5Deletion.impact.subscriptionsLink")}
          </Link>
        </>
      );
    case "channelSubscriptions":
      return <>{t("w5Deletion.impact.channelSubscriptions", { count: line.count })}</>;
    case "endingEarly":
      return <>{t("w5Deletion.impact.endingEarly", { count: line.count })}</>;
    case "payout":
      return <>{fillNode(t("d7Settings.delete.impact.payout"), "amount", <MoneyAmount value={line.amount} />)}</>;
    case "membership":
      return line.share ? (
        <>{fillNode(t("w5Deletion.impact.share"), "amount", <MoneyAmount value={line.share} />)}</>
      ) : (
        <>{t("d7Settings.delete.impact.membership")}</>
      );
    case "legalHold":
      return <>{t("d7Settings.delete.impact.legalHold")}</>;
  }
}

function StepLabel({ n, children, htmlFor }: { n: number; children: React.ReactNode; htmlFor?: string }) {
  const content = (
    <>
      <span aria-hidden className="me-2 inline-flex size-5 items-center justify-center rounded-full border text-xs">
        {n}
      </span>
      {children}
    </>
  );
  return htmlFor ? (
    <FieldLabel htmlFor={htmlFor}>{content}</FieldLabel>
  ) : (
    <p className="flex items-center text-sm font-medium">{content}</p>
  );
}

export function DeleteAccountSection({
  username,
  exports,
  preview: previewLoader = loadPreview,
  client,
}: {
  username: string;
  /** The page's export state, for step 2's Download now. */
  exports: ExportsState;
  preview?: PreviewLoader;
  client?: DeletionClient;
}): React.JSX.Element {
  const deletion = useDeletion(client);
  const [open, setOpen] = React.useState(false);
  const [openedAt, setOpenedAt] = React.useState(0);
  const [preview, setPreview] = React.useState<DeletionPreview | null>(null);
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const [downloaded, setDownloaded] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [canceling, setCanceling] = React.useState(false);
  const [requesting, setRequesting] = React.useState(false);
  const inputId = React.useId();
  const checkId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    previewLoader().then(
      (p) => live && setPreview(p),
      () => live && setPreviewFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, previewLoader]);

  const graceDays = preview?.graceDays ?? FALLBACK_GRACE_DAYS;
  const request = deletion.request;
  const scheduled = scheduledRequest(request);

  if (request === undefined && deletion.failed)
    return (
      <AlertCallout
        data-testid="deletion-load-error"
        tone="danger"
        live
        description={t("privacy.deletion.loadFailed")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={deletion.reload}>
            {t("common.retry")}
          </Button>
        }
      />
    );

  const cancel = async () => {
    setCanceling(true);
    try {
      await deletion.cancel();
    } catch (err) {
      toastActionError(err, t("d7Settings.delete.cancelFailed"));
    } finally {
      setCanceling(false);
    }
  };

  // The dialog's open time is "now" for the link's expiry (stable across renders).
  const account = exports.exports
    ? (exportRows(exports.exports, openedAt).find((r) => r.kind === "account") ?? null)
    : null;
  const downloadNow = async () => {
    setRequesting(true);
    try {
      await exports.request("account");
    } catch (err) {
      onExportError(exports, err);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <DangerZone
      id="delete-account"
      data-testid="privacy-delete"
      title={t("d7Settings.delete.title")}
      description={t("d7Settings.delete.intro", { days: graceDays })}
    >
      <div className="flex flex-col items-start gap-3 px-4 py-4 sm:px-6">
        {request === undefined ? (
          <SkeletonText lines={1} />
        ) : request && request.status !== "completed" ? (
          <div
            data-testid="deletion-status"
            data-status={request.status}
            data-scheduled-for={request.scheduledFor}
            className="flex flex-col items-start gap-2 text-sm"
          >
            {scheduled ? (
              <p>{fillNode(t("d7Settings.banner.title"), "date", <DeletionDate iso={scheduled.scheduledFor} />)}</p>
            ) : (
              <p className="flex items-center gap-2">
                <StatusBadge tone="neutral">{t("privacy.deletion.status.canceled")}</StatusBadge>
                {t("privacy.deletion.canceled")}
              </p>
            )}
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
                {t("privacy.deletion.cancel")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {request !== undefined && !scheduled ? (
          <ConfirmDialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next) {
                setOpenedAt(Date.now());
                setPreviewFailed(false);
                trackUi("deletion", "view");
              } else {
                setTyped("");
                setDownloaded(false);
              }
            }}
            trigger={
              <Button type="button" variant="destructive" size="sm" data-testid="deletion-request">
                {t("privacy.deletion.request")}
              </Button>
            }
            variant="destructive"
            title={t("privacy.deletion.confirmTitle")}
            description={t("d7Settings.delete.dialogIntro", { username, days: graceDays })}
            cancelLabel={t("d7Settings.delete.keep")}
            confirmLabel={t("d7Settings.delete.confirm", { days: graceDays })}
            confirmDisabled={!canConfirm({ downloaded, typed, username })}
            onConfirm={() => deletion.schedule(typed.trim())}
            onError={(err) => {
              trackUi("deletion", "error");
              toastActionError(err, deletionRequestErrorText(err));
            }}
            contentProps={{ "data-testid": "deletion-dialog" }}
          >
            <div className="flex max-h-sheet flex-col gap-5 overflow-y-auto text-sm">
              <div className="flex flex-col gap-2">
                <StepLabel n={1}>{t("d7Settings.delete.step.impact")}</StepLabel>
                {preview === null && !previewFailed ? (
                  <SkeletonText data-testid="deletion-preview-loading" lines={3} />
                ) : null}
                <ul data-testid="deletion-impact" className="flex flex-col divide-y">
                  {impactLines(preview).map((line) => (
                    <li key={line.kind} data-testid="deletion-impact-line" data-kind={line.kind} className="py-2">
                      <ImpactItem line={line} />
                    </li>
                  ))}
                </ul>
                {previewFailed ? (
                  <p data-testid="deletion-preview-error" className="text-muted-foreground">
                    {t("d7Settings.delete.previewFailed")}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <StepLabel n={2}>{t("d7Settings.delete.step.download")}</StepLabel>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={checkId}
                    data-testid="deletion-downloaded"
                    checked={downloaded}
                    onCheckedChange={(on) => setDownloaded(on === true)}
                  />
                  <Label htmlFor={checkId} className="font-normal">
                    {t("d7Settings.delete.downloaded")}
                  </Label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {account?.downloadUrl ? (
                    <Button
                      size="sm"
                      variant="outline"
                      nativeButton={false}
                      render={
                        <a
                          href={account.downloadUrl}
                          rel="noreferrer noopener"
                          download
                          aria-label={t("privacy.export.download")}
                        />
                      }
                      data-testid="deletion-download"
                    >
                      {t("privacy.export.download")}
                    </Button>
                  ) : account && (account.status === "queued" || account.status === "running") ? (
                    <span data-testid="deletion-download-preparing" className="text-muted-foreground">
                      {t("d7Settings.delete.preparing")}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="deletion-download-now"
                      disabled={requesting}
                      aria-busy={requesting || undefined}
                      onClick={() => void downloadNow()}
                    >
                      {t("d7Settings.delete.downloadNow")}
                    </Button>
                  )}
                </div>
              </div>
              <Field>
                <StepLabel n={3} htmlFor={inputId}>
                  {t("privacy.deletion.confirmUsername")}
                </StepLabel>
                <Input
                  id={inputId}
                  data-testid="deletion-confirm-username"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={username}
                  value={typed}
                  onChange={(event) => setTyped(event.currentTarget.value)}
                />
              </Field>
            </div>
          </ConfirmDialog>
        ) : null}
      </div>
    </DangerZone>
  );
}
