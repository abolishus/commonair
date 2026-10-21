// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { REPORT_REASONS } from "@commonair/contracts/enums";
import { SelectField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@commonair/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { Flag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { reportClient, type ReportClient, type ReportReason, type ReportSubject } from "./client.ts";
import { reportReasonLabel } from "./labels.ts";

export const REPORT_DETAILS_MAX = 5000;

export interface ReportButtonProps {
  signedIn: boolean;
  subjectType: ReportSubject;
  subjectId: string;
  client?: ReportClient;
}

/**
 * `report-open`: signed out a link to /signin; signed in it opens the report dialog. After a
 * report is filed the button carries its id (`data-report-id`).
 */
export function ReportButton({
  signedIn,
  subjectType,
  subjectId,
  client = reportClient(),
}: ReportButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [reportId, setReportId] = React.useState<string | undefined>(undefined);
  const content = (
    <>
      <HugeiconsIcon icon={Flag01Icon} strokeWidth={2} aria-hidden />
      {t("safety.report.open")}
    </>
  );
  if (!signedIn)
    return (
      <Button data-testid="report-open" variant="outline" size="sm" nativeButton={false} render={<Link to="/signin" />}>
        {content}
      </Button>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button data-testid="report-open" data-report-id={reportId} variant="outline" size="sm" />}
      >
        {content}
      </DialogTrigger>
      {open && (
        <DialogContent
          data-testid="report-dialog"
          data-subject-type={subjectType}
          data-subject-id={subjectId}
          className="max-h-svh overflow-y-auto sm:max-w-lg"
        >
          <ReportForm
            onSubmit={async (reason, details) => {
              const created = await client.report({ subjectType, subjectId, reason, details });
              setReportId(created.id);
              setOpen(false);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

export function ReportForm({
  onSubmit,
}: {
  onSubmit: (reason: ReportReason, details: string) => Promise<void>;
}): React.JSX.Element {
  const [reason, setReason] = React.useState<ReportReason | "">("");
  const [details, setDetails] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const detailsId = React.useId();
  const reasons = REPORT_REASONS.map((r) => ({
    value: r,
    label: reportReasonLabel(r),
    "data-testid": `report-reason-${r}`,
  }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (reason === "" || pending) return;
    setPending(true);
    try {
      await onSubmit(reason, details.trim());
      toast.success(t("safety.report.done"));
    } catch (err) {
      if (errorCode(err) === "CONFLICT") toast.error(t("safety.report.duplicate"));
      else toastActionError(err, t("safety.report.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("safety.report.title")}</DialogTitle>
        <DialogDescription>{t("safety.report.description")}</DialogDescription>
      </DialogHeader>
      <SelectField
        label={t("safety.report.reason")}
        options={reasons}
        value={reason === "" ? undefined : reason}
        placeholder={t("safety.report.reasonPlaceholder")}
        onValueChange={(next) => {
          const found = REPORT_REASONS.find((r) => r === next);
          if (found) setReason(found);
        }}
        triggerProps={reasonTrigger}
      />
      <Field>
        <FieldLabel htmlFor={detailsId}>{t("safety.report.details")}</FieldLabel>
        <Textarea
          id={detailsId}
          data-testid="report-details"
          value={details}
          maxLength={REPORT_DETAILS_MAX}
          rows={4}
          onChange={(e) => setDetails(e.currentTarget.value)}
        />
        <FieldDescription>{t("safety.report.detailsHint")}</FieldDescription>
      </Field>
      <DialogFooter>
        <Button
          data-testid="report-submit"
          type="submit"
          disabled={reason === "" || pending}
          aria-busy={pending || undefined}
        >
          {t("safety.report.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// A variable, not an inline literal: a `data-testid` key in a literal is an excess property.
const reasonTrigger = { "data-testid": "report-reason" };
