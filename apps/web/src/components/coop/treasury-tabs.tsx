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
  type ShareDto,
  type ShareStatus,
} from "../../lib/coop.ts";
import { usePaged } from "../money/use-load.ts";
import { PayoutTransfers } from "../treasury/payout-transfers.tsx";
import { RefundRequests } from "../treasury/refund-requests.tsx";
import { LeavingSharesPanel, leavingShares, loadLeavingShares } from "../treasury/share-refund-leaving.tsx";
import { CoopLoadError } from "./load-error.tsx";
import { PatronagePanel, SharesPanel, type PatronageRunResultDto } from "./treasury.tsx";
import { coopLoads, pagedLoad, useCoopLoad } from "./use-coop.ts";

const PAGE = 50;

/** Members leaving first (their deletion date, soonest first), then the rest in list order (pure). */
export function leavingFirst(shares: ShareDto[] | null): ShareDto[] | null {
  if (shares === null) return null;
  const leaving = leavingShares(shares) ?? [];
  return [...leaving, ...shares.filter((s) => s.deletionScheduledFor === null)];
}

/**
 * Treasury `shares` tab with its data: members leaving with a share (ADR 0042: ask for refund
 * details before their deletion date), then shares by status, refunds recorded as sent now. Every
 * page of held shares loads with the tab (`loadLeavingShares`), so a treasurer sees everyone leaving
 * whatever the status filter and however many shares the co-op holds.
 */
export function CoopSharesTab(): React.JSX.Element {
  const [status, setStatus] = React.useState<ShareStatus>("refund_pending");
  const shares = usePaged(
    `shares|${status}`,
    (cursor) => api().coop.shares.list({ status, limit: PAGE, cursor }),
    (err) => toastActionError(err, t("treasury.loadMoreFailed")),
  );
  const leaving = useCoopLoad("shares|held|leaving", () =>
    loadLeavingShares((cursor, limit) => api().coop.shares.list({ status: "held", limit, cursor })),
  );
  const loads = coopLoads([pagedLoad(shares), leaving]);
  if (loads.failed) return <CoopLoadError onRetry={loads.retry} />;
  return (
    <div className="flex flex-col gap-6">
      {loads.stale && <CoopLoadError onRetry={loads.retry} />}
      <LeavingSharesPanel
        shares={leaving.data?.shares ?? null}
        truncated={leaving.data?.truncated ?? false}
        onAsk={async (share) => {
          await api().coop.shares.askRefundDetails({ shareId: share.id });
          leaving.reload();
        }}
      />
      <SharesPanel
        shares={leavingFirst(shares.items)}
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
    </div>
  );
}

/** Treasury `refunds` tab (batch 8): refund requests, M1-gifts-refunds' component, which loads its own data. */
export function TreasuryRefundRequestsTab(): React.JSX.Element {
  return <RefundRequests />;
}

/** Treasury `transfers` tab (batch 8): payout transfers, M1-connect's component, which loads its own data. */
export function TreasuryPayoutTransfersTab(): React.JSX.Element {
  return <PayoutTransfers />;
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
  const periods = useCoopLoad("patronage-periods", () => api().coop.patronage.periods());

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

  const loads = coopLoads([periods]);
  if (loads.failed) return <CoopLoadError onRetry={loads.retry} />;
  return (
    <>
      {loads.stale && <CoopLoadError onRetry={loads.retry} />}
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
        periods={periods.data}
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
