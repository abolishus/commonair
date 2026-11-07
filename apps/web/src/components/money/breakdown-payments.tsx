// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, MoneyAmount, RelativeTime } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Invoice01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { BreakdownOpenButton } from "./breakdown-dialog.tsx";
import type { PaymentBreakdownDto } from "./breakdown-table.tsx";
import { type Page, usePaged } from "./use-load.ts";

const PAGE = 20;

export type PaymentsLoader = (cursor: string | undefined) => Promise<Page<PaymentBreakdownDto>>;

const loadMine: PaymentsLoader = (cursor) =>
  api().money.paymentBreakdowns({ role: "payer", limit: PAGE, ...(cursor ? { cursor } : {}) });

export interface PaymentsTableProps {
  /** null while the first page loads. */
  items: PaymentBreakdownDto[] | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/** The payer's payments, each with its breakdown (already loaded: the dialog shows it as is). */
export function PaymentsTable({ items, hasMore, loadingMore, onLoadMore }: PaymentsTableProps): React.JSX.Element {
  const columns: DataTableColumn<PaymentBreakdownDto>[] = [
    {
      id: "date",
      header: t("breakdown.payments.date"),
      cell: ({ row }) => <RelativeTime date={row.original.succeededAt} />,
    },
    { id: "channel", header: t("breakdown.payments.channel"), cell: ({ row }) => row.original.channel.displayName },
    {
      id: "kind",
      header: t("breakdown.payments.kind"),
      cell: ({ row }) => t("breakdown.kind", { kind: row.original.kind }),
    },
    {
      id: "amount",
      header: t("breakdown.payments.amount"),
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={row.original.gross} />,
    },
    {
      id: "details",
      header: t("breakdown.payments.details"),
      cell: ({ row }) => <BreakdownOpenButton paymentId={row.original.paymentId} breakdown={row.original} />,
    },
  ];
  return (
    <DataTable
      caption={t("breakdown.payments.title")}
      columns={columns}
      rows={items ?? []}
      loading={items === null}
      loadingRows={3}
      getRowId={(b) => b.paymentId}
      rowProps={(b) => ({ "data-payment-id": b.paymentId })}
      empty={
        <EmptyState
          icon={Invoice01Icon}
          title={t("breakdown.payments.empty")}
          description={t("breakdown.payments.emptyHint")}
          headingLevel={3}
        />
      }
      footer={
        hasMore ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            aria-busy={loadingMore || undefined}
            onClick={onLoadMore}
          >
            {t("breakdown.payments.more")}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * "Your payments" on `/settings/subscriptions`: `money.paymentBreakdowns({ role: "payer" })`. A
 * busy (429) or unreachable first load retries by itself after the server's `retryAfterSeconds`
 * and says so; once the automatic retries run out, Retry is left, never a dead end.
 */
export function YourPayments({ load = loadMine }: { load?: PaymentsLoader }): React.JSX.Element {
  const paged = usePaged("payer", load, (err) => toastActionError(err, t("breakdown.payments.loadFailed")));
  return (
    <Section heading={t("breakdown.payments.title")} description={t("breakdown.payments.intro")}>
      {paged.items === null && paged.failed ? (
        <SectionLoadError
          section={t("breakdown.payments.title")}
          load={paged.first}
          headingLevel={3}
          data-testid="payments-load-error"
        />
      ) : (
        <PaymentsTable
          items={paged.items}
          hasMore={paged.hasMore}
          loadingMore={paged.loadingMore}
          onLoadMore={paged.loadMore}
        />
      )}
    </Section>
  );
}
