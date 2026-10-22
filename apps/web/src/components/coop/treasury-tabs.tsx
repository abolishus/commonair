// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PatronageRunFormValues, PatronageRunSubmission } from "@commonair/ui/blocks/coop";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import {
  defaultRunWindow,
  errorRequirement,
  isSecondApproverRefusal,
  runWindow,
  runWindowErrorText,
  type ShareStatus,
} from "../../lib/coop.ts";
import { FormError } from "../form-error.tsx";
import { useLoad, usePaged } from "../money/use-load.ts";
import { PatronagePanel, SharesPanel, type PatronageRunResultDto } from "./treasury.tsx";

const PAGE = 50;

/** Treasury `shares` tab with its data: shares by status, refunds recorded as sent now. */
export function CoopSharesTab(): React.JSX.Element {
  const [status, setStatus] = React.useState<ShareStatus>("refund_pending");
  const shares = usePaged(
    `shares|${status}`,
    (cursor) => api().coop.shares.list({ status, limit: PAGE, cursor }),
    (err) => toastActionError(err, t("treasury.loadMoreFailed")),
  );
  return (
    <>
      {shares.failed && <FormError>{t("coop.loadFailed")}</FormError>}
      <SharesPanel
        shares={shares.items ?? (shares.failed ? [] : null)}
        status={status}
        onStatusChange={setStatus}
        hasMore={shares.hasMore}
        loadingMore={shares.loadingMore}
        onLoadMore={shares.loadMore}
        onRefund={async (share, note) => {
          await api().coop.shares.refund({
            shareId: share.id,
            sentAt: new Date().toISOString(),
            ...(note ? { note } : {}),
          });
          toast.success(t("coop.treasury.refunded"));
          shares.reload();
        }}
        onRefundError={(err) => {
          if (isSessionExpired(err)) toastActionError(err, t("coop.treasury.refundFailed"));
          else if (errorCode(err) === "CONFLICT") shares.reload();
        }}
      />
    </>
  );
}

/** Why `coop.patronage.run` was refused, in words. */
function runError(err: unknown): string {
  const code = errorCode(err);
  if (code === "PRECONDITION_FAILED" && errorRequirement(err) === "surplus") return t("coop.patronageRun.noSurplus");
  if (code === "CONFLICT") return t("coop.patronageRun.overlap");
  if (code === "BAD_REQUEST") return t("coop.patronageRun.invalidTimes");
  return t("coop.patronageRun.failed");
}

/** Treasury `patronage` tab with its data: run, result and periods with approval. */
export function CoopPatronageTab({ meId, currency }: { meId: string; currency: string }): React.JSX.Element {
  const [values, setValues] = React.useState<PatronageRunFormValues>(() => ({
    ...defaultRunWindow(Date.now()),
    surplus: "",
  }));
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<PatronageRunResultDto | null>(null);
  const periods = useLoad("patronage-periods", () => api().coop.patronage.periods());

  const run = async (submission: PatronageRunSubmission) => {
    if (running) return;
    const period = runWindow(submission.start, submission.end, Date.now());
    if ("error" in period) {
      setError(runWindowErrorText(period.error));
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const out = await api().coop.patronage.run({
        ...period,
        ...(submission.surplusCents === null ? {} : { surplusCents: submission.surplusCents }),
      });
      setResult(out);
      toast.success(t("coop.patronageRun.done"));
      periods.reload();
    } catch (err) {
      if (isSessionExpired(err)) toastActionError(err, t("coop.patronageRun.failed"));
      else setError(runError(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      {periods.failed && <FormError>{t("coop.loadFailed")}</FormError>}
      <PatronagePanel
        meId={meId}
        currency={currency}
        values={values}
        onValuesChange={(next) => {
          setValues(next);
          setError(null);
        }}
        onRun={run}
        running={running}
        runError={error}
        result={result}
        periods={periods.data ?? (periods.failed ? [] : null)}
        onApprove={async (period) => {
          await api().coop.patronage.approve({ periodId: period.id });
          toast.success(t("coop.periods.approved"));
          periods.reload();
        }}
        onApproveError={(err) => {
          // The API (and the trigger) refuse the person who ran it: say why, as the disabled button does.
          if (isSecondApproverRefusal(err)) toast.error(t("coop.periods.secondApprover"));
          else toastActionError(err, t("coop.periods.approveFailed"));
        }}
      />
    </>
  );
}
