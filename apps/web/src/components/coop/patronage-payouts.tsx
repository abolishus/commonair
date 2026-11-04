// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PatronagePayoutView } from "@commonair/contracts/dto";
import {
  ConfirmDialog,
  EmptyState,
  MoneyAmount,
  StatusBadge,
  formatMoney,
  useLocale,
  type StatusTone,
} from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Input } from "@commonair/ui/components/input";
import { Label } from "@commonair/ui/components/label";
import { PageContainer } from "@commonair/ui/layouts";
import { MoneySend01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";

/**
 * The period page's payout section (batch 8, M1-coop-money; docs/testing/b8-selectors.md
 * `patronage-payouts`, `patronage-pay`): for treasurers, the period's payout rows and "Pay out",
 * which asks for or gives the second approval (`coop.patronage.pay`) behind a `ConfirmDialog`; a
 * manual row is marked paid with the treasurer's reference. A member sees only their own payout.
 */

export type PatronagePayoutDto = z.infer<typeof PatronagePayoutView>;

/** The co-op's convention for an account that was deleted (`unknownUser` in the API). */
const DELETED = "deleted";
export const isDeletedMember = (r: Pick<PatronagePayoutDto, "user">): boolean => r.user.username === DELETED;

const STATUS: Record<PatronagePayoutDto["status"], { key: MessageKey; tone: StatusTone }> = {
  pending: { key: "coopMoney.payouts.status.pending", tone: "warning" },
  paid: { key: "coopMoney.payouts.status.paid", tone: "success" },
  failed: { key: "coopMoney.payouts.status.failed", tone: "danger" },
  reversed: { key: "coopMoney.payouts.status.reversed", tone: "neutral" },
};
const MINE: Record<PatronagePayoutDto["status"], MessageKey> = {
  pending: "coopMoney.mine.pending",
  paid: "coopMoney.mine.paid",
  failed: "coopMoney.mine.failed",
  reversed: "coopMoney.mine.reversed",
};
const METHOD: Record<PatronagePayoutDto["provider"], MessageKey> = {
  manual: "coopMoney.payouts.method.manual",
  stripe: "coopMoney.payouts.method.stripe",
};

export const payoutStatusLabel = (s: PatronagePayoutDto["status"]): string => t(STATUS[s].key);

/** Whether a row can be marked paid by hand: pending, by bank transfer, the account not deleted (pure). */
export const canMarkPaid = (r: PatronagePayoutDto): boolean =>
  r.status === "pending" && r.provider === "manual" && !isDeletedMember(r);

/** The treasurer's reference, as the API accepts it (`MANUAL_REFERENCE`). */
export const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/;

function MarkPaid({
  row,
  onMarkPaid,
  onError,
}: {
  row: PatronagePayoutDto;
  onMarkPaid: (payoutId: string, reference: string) => Promise<void>;
  onError?: ((err: unknown) => void) | undefined;
}): React.JSX.Element {
  const [reference, setReference] = React.useState("");
  const id = React.useId();
  const valid = REFERENCE.test(reference.trim());
  return (
    <ConfirmDialog
      trigger={
        <Button data-testid="patronage-payout-mark-paid" data-payout-id={row.id} variant="outline" size="sm">
          {t("coopMoney.markPaid.button")}
        </Button>
      }
      title={t("coopMoney.markPaid.title")}
      description={t("coopMoney.markPaid.description")}
      confirmLabel={t("coopMoney.markPaid.confirm")}
      confirmDisabled={!valid}
      onConfirm={() => onMarkPaid(row.id, reference.trim())}
      {...(onError ? { onError } : {})}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{t("coopMoney.markPaid.reference")}</Label>
        <Input
          id={id}
          value={reference}
          maxLength={64}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          onChange={(e) => setReference(e.target.value)}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {t("coopMoney.markPaid.referenceHint")}
        </p>
      </div>
    </ConfirmDialog>
  );
}

export interface PatronagePayoutsPanelProps {
  periodId: string;
  /** null while loading. */
  rows: PatronagePayoutDto[] | null;
  failed?: boolean;
  onRetry?: () => void;
  onPay: () => Promise<void>;
  onPayError?: (err: unknown) => void;
  /** Mark a manual row paid; omitted until the procedure exists (then no button shows). */
  onMarkPaid?: (payoutId: string, reference: string) => Promise<void>;
  onMarkPaidError?: (err: unknown) => void;
}

/** The treasurer's payout section, from props (server-renderable with fixtures). */
export function PatronagePayoutsPanel({
  periodId,
  rows,
  failed = false,
  onRetry,
  onPay,
  onPayError,
  onMarkPaid,
  onMarkPaidError,
}: PatronagePayoutsPanelProps): React.JSX.Element {
  const columns: DataTableColumn<PatronagePayoutDto>[] = [
    {
      id: "member",
      header: t("coopMoney.payouts.col.member"),
      cell: ({ row: { original: r } }) =>
        isDeletedMember(r) ? (
          <span className="text-muted-foreground">{t("coopMoney.payouts.deleted")}</span>
        ) : (
          r.user.username
        ),
    },
    {
      id: "amount",
      header: t("coopMoney.payouts.col.amount"),
      align: "numeric",
      cell: ({ row: { original: r } }) => <MoneyAmount value={r.amount} />,
    },
    {
      id: "method",
      header: t("coopMoney.payouts.col.method"),
      cell: ({ row: { original: r } }) => t(METHOD[r.provider]),
    },
    {
      id: "status",
      header: t("coopMoney.payouts.col.status"),
      cell: ({ row: { original: r } }) => (
        <div className="flex flex-col items-start gap-2">
          <StatusBadge tone={STATUS[r.status].tone}>{payoutStatusLabel(r.status)}</StatusBadge>
          {onMarkPaid && canMarkPaid(r) && <MarkPaid row={r} onMarkPaid={onMarkPaid} onError={onMarkPaidError} />}
        </div>
      ),
    },
    {
      id: "reference",
      header: t("coopMoney.payouts.col.reference"),
      cell: ({ row: { original: r } }) =>
        r.reference ? (
          <span className="break-all">{r.reference}</span>
        ) : (
          <span className="text-muted-foreground">{t("coopMoney.payouts.none")}</span>
        ),
    },
  ];
  return (
    <PageContainer width="default" className="pb-8">
      <Section
        heading={t("coopMoney.payouts.title")}
        description={t("coopMoney.payouts.description")}
        action={
          <ConfirmDialog
            trigger={
              <Button data-testid="patronage-pay" data-period-id={periodId}>
                {t("coopMoney.pay.button")}
              </Button>
            }
            title={t("coopMoney.pay.title")}
            description={t("coopMoney.pay.description")}
            confirmLabel={t("coopMoney.pay.confirm")}
            onConfirm={onPay}
            {...(onPayError ? { onError: onPayError } : {})}
          />
        }
      >
        <div data-testid="patronage-payouts" className="flex min-w-0 flex-col gap-4">
          {failed && (
            <AlertCallout
              tone="danger"
              live
              title={t("coopMoney.payouts.loadFailed")}
              action={
                onRetry ? (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    {t("coopMoney.payouts.retry")}
                  </Button>
                ) : undefined
              }
            />
          )}
          {!(failed && rows === null) && (
            <DataTable
              caption={t("coopMoney.payouts.caption")}
              columns={columns}
              rows={rows ?? []}
              loading={rows === null}
              loadingRows={3}
              getRowId={(r) => r.id}
              rowProps={(r) => ({
                "data-payout-id": r.id,
                "data-user-id": r.user.id,
                "data-status": r.status,
                "data-amount-cents": r.amount.cents,
                "data-provider": r.provider,
              })}
              empty={
                <EmptyState
                  icon={MoneySend01Icon}
                  headingLevel={3}
                  title={t("coopMoney.payouts.empty.title")}
                  description={t("coopMoney.payouts.empty.body")}
                />
              }
            />
          )}
        </div>
      </Section>
    </PageContainer>
  );
}

/** A member's own payout for the period (only ever theirs). */
export function MemberPayoutStatus({
  payout,
}: {
  payout: Pick<PatronagePayoutDto, "status" | "amount"> | null;
}): React.JSX.Element {
  const { locale } = useLocale();
  const amount = payout ? formatMoney(payout.amount.cents, payout.amount.currency, locale) : "";
  const text = payout ? t(MINE[payout.status], { amount }) : t("coopMoney.mine.none");
  return (
    <PageContainer width="default" className="pb-8">
      <Section heading={t("coopMoney.mine.title")}>
        <div
          data-testid="patronage-payout-mine"
          data-status={payout?.status ?? "none"}
          className="flex flex-wrap items-center gap-3"
        >
          {payout && <StatusBadge tone={STATUS[payout.status].tone}>{payoutStatusLabel(payout.status)}</StatusBadge>}
          <p className="text-sm">{text}</p>
        </div>
      </Section>
    </PageContainer>
  );
}
