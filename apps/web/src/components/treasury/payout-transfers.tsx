// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PayoutTransferView } from "@commonair/contracts/dto";
import { EmptyState, MoneyAmount, RelativeTime, StatusBadge, type StatusTone } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { MoneySend01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import type { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { monthKey, monthLabel } from "../../lib/money.ts";
import { usePaged } from "../money/use-load.ts";

/**
 * Treasury `transfers` tab (batch 8, M1-connect; ADR 0007 Amendment 1): the Stripe Connect transfer
 * of each Stripe payout, newest first (`money.treasurer.transfers`), with the run, amounts, reversed
 * cents and what became of it. A failure shows only its opaque code, never Stripe's message.
 * Creators see nothing here: their payout simply turns `paid`.
 */

export type PayoutTransferDto = z.infer<typeof PayoutTransferView>;

const PAGE = 50;

/** The worker's codes for a transfer it could not settle (`PAYOUT_TRANSFER_CODES` in the ledger). */
const OUTCOME_UNKNOWN = "outcome_unknown";
const SENT_UNRECORDED = "sent_unrecorded";

export interface TransferStatusView {
  label: string;
  tone: StatusTone;
  /** What the treasurer should know, in words; null when the status says it all. */
  note: string | null;
}

const STATUS: Record<PayoutTransferDto["status"], { key: MessageKey; tone: StatusTone }> = {
  pending: { key: "payoutTransfers.status.pending", tone: "warning" },
  created: { key: "payoutTransfers.status.created", tone: "success" },
  failed: { key: "payoutTransfers.status.failed", tone: "danger" },
  reversed: { key: "payoutTransfers.status.reversed", tone: "neutral" },
};

const FAILURE_NOTES: Record<string, MessageKey> = {
  account_not_ready: "payoutTransfers.note.accountNotReady",
  held: "payoutTransfers.note.held",
};

/** The status chip and note of a transfer (pure; exported for tests). */
export function transferStatusView(
  tr: Pick<PayoutTransferDto, "status" | "failureCode" | "reversed" | "amount">,
): TransferStatusView {
  if (tr.status === "pending" && tr.failureCode === OUTCOME_UNKNOWN)
    return {
      label: t("payoutTransfers.status.outcomeUnknown"),
      tone: "danger",
      note: t("payoutTransfers.note.outcomeUnknown"),
    };
  if (tr.status === "pending" && tr.failureCode === SENT_UNRECORDED)
    return {
      label: t("payoutTransfers.status.sentUnrecorded"),
      tone: "warning",
      note: t("payoutTransfers.note.sentUnrecorded"),
    };
  const s = STATUS[tr.status];
  let note: string | null = null;
  if (tr.status === "failed") {
    const key = tr.failureCode ? FAILURE_NOTES[tr.failureCode] : undefined;
    note = key ? t(key) : t("payoutTransfers.note.code", { code: tr.failureCode ?? "" });
  } else if (tr.status === "created" && tr.reversed.cents > 0) {
    note = t("payoutTransfers.note.partlyReversed");
  }
  return { label: t(s.key), tone: s.tone, note };
}

export interface PayoutTransfersPanelProps {
  /** null while the first page loads. */
  transfers: PayoutTransferDto[] | null;
  failed?: boolean;
  onRetry?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

/** The transfers list from props (server-renderable with fixtures). */
export function PayoutTransfersPanel({
  transfers,
  failed = false,
  onRetry,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: PayoutTransfersPanelProps): React.JSX.Element {
  const columns: DataTableColumn<PayoutTransferDto>[] = [
    { id: "creator", header: t("payoutTransfers.col.creator"), cell: ({ row: { original: r } }) => r.user.username },
    {
      id: "run",
      header: t("payoutTransfers.col.run"),
      cell: ({ row: { original: r } }) => monthLabel(monthKey(Date.parse(r.periodStart))),
    },
    {
      id: "amount",
      header: t("payoutTransfers.col.amount"),
      align: "numeric",
      cell: ({ row: { original: r } }) => <MoneyAmount value={r.amount} />,
    },
    {
      id: "reversed",
      header: t("payoutTransfers.col.reversed"),
      align: "numeric",
      cell: ({ row: { original: r } }) =>
        r.reversed.cents > 0 ? (
          <MoneyAmount value={r.reversed} />
        ) : (
          <span className="text-muted-foreground">{t("payoutTransfers.none")}</span>
        ),
    },
    {
      id: "status",
      header: t("payoutTransfers.col.status"),
      cell: ({ row: { original: r } }) => {
        const view = transferStatusView(r);
        return (
          <div className="flex max-w-xs flex-col items-start gap-1">
            <StatusBadge
              data-testid="payout-transfer-status"
              data-status={r.status}
              data-reversed-cents={r.reversed.cents}
              data-failure-code={r.failureCode ?? ""}
              tone={view.tone}
            >
              {view.label}
            </StatusBadge>
            {view.note && <span className="text-xs text-muted-foreground">{view.note}</span>}
          </div>
        );
      },
    },
    {
      id: "updated",
      header: t("payoutTransfers.col.updated"),
      cell: ({ row: { original: r } }) => <RelativeTime date={r.updatedAt} />,
    },
  ];
  return (
    <div data-testid="payout-transfers" className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("payoutTransfers.hint")}</p>
      {failed && (
        <AlertCallout
          tone="danger"
          live
          title={t("payoutTransfers.loadFailed.title")}
          description={t("payoutTransfers.loadFailed.body")}
          action={
            onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                {t("payoutTransfers.retry")}
              </Button>
            ) : undefined
          }
        />
      )}
      {!(failed && transfers === null) && (
        <DataTable
          caption={t("payoutTransfers.caption")}
          columns={columns}
          rows={transfers ?? []}
          loading={transfers === null}
          loadingRows={3}
          getRowId={(r) => r.id}
          rowProps={(r) => ({
            "data-transfer-id": r.id,
            "data-payout-id": r.payoutId,
            "data-user-id": r.user.id,
            "data-status": r.status,
            "data-cents": r.amount.cents,
          })}
          empty={
            <EmptyState
              icon={MoneySend01Icon}
              headingLevel={3}
              title={t("payoutTransfers.empty.title")}
              description={t("payoutTransfers.empty.body")}
            />
          }
          footer={
            hasMore && onLoadMore ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={loadingMore}
                aria-busy={loadingMore || undefined}
                onClick={onLoadMore}
              >
                {t("payoutTransfers.loadMore")}
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

/** The tab with its data: every run's transfers, newest first, paged. */
export function PayoutTransfers(): React.JSX.Element {
  const transfers = usePaged(
    "payout-transfers",
    (cursor) => api().money.treasurer.transfers({ limit: PAGE, cursor }),
    (err) => toastActionError(err, t("payoutTransfers.loadMoreFailed")),
  );
  return (
    <PayoutTransfersPanel
      transfers={transfers.items}
      failed={transfers.failed}
      onRetry={transfers.reload}
      hasMore={transfers.hasMore}
      loadingMore={transfers.loadingMore}
      onLoadMore={transfers.loadMore}
    />
  );
}
