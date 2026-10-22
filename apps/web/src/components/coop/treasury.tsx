// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, useLocale } from "@commonair/ui";
import {
  PatronagePeriodsTable,
  PatronageRunForm,
  PatronageRunResult,
  ShareRefundsTable,
  type PatronageRunFormValues,
  type PatronageRunSubmission,
} from "@commonair/ui/blocks/coop";
import { FilterBar } from "@commonair/ui/blocks/data";
import { PageTabs, Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Invoice01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  REFUND_NOTE_MAX,
  SHARE_STATUSES,
  patronageStatusLabel,
  shareStatusLabel,
  type PatronagePeriodDto,
  type ShareDto,
  type ShareStatus,
} from "../../lib/coop.ts";
import { periodText } from "./statements.tsx";

export type TreasuryCoopTab = "payments" | "payouts" | "accounts" | "costs" | "shares" | "patronage";

const TABS: readonly TreasuryCoopTab[] = ["payments", "payouts", "accounts", "costs", "shares", "patronage"];
const isTab = (value: unknown): value is TreasuryCoopTab => TABS.some((tab) => tab === value);

export type TreasuryPanels = Record<TreasuryCoopTab, React.ReactNode>;

/**
 * The treasury's tabs with the E5 `shares` and `patronage` panels after the E4b ones (same ids and
 * labels as `TreasuryTabs`, which has no room for more panels).
 */
export function TreasuryCoopTabs({
  value,
  onValueChange,
  panels,
}: {
  value: TreasuryCoopTab;
  onValueChange: (tab: TreasuryCoopTab) => void;
  panels: TreasuryPanels;
}): React.JSX.Element {
  const panel = (tab: TreasuryCoopTab) => <div className="flex flex-col gap-4 pt-4">{panels[tab]}</div>;
  return (
    <PageTabs
      value={value}
      onValueChange={(next) => isTab(next) && onValueChange(next)}
      items={[
        {
          id: "payments",
          label: t("treasury.tab.payments"),
          "data-testid": "treasury-tab-payments",
          content: panel("payments"),
        },
        {
          id: "payouts",
          label: t("treasury.tab.payouts"),
          "data-testid": "treasury-tab-payouts",
          content: panel("payouts"),
        },
        {
          id: "accounts",
          label: t("treasury.tab.accounts"),
          "data-testid": "treasury-tab-accounts",
          content: panel("accounts"),
        },
        { id: "costs", label: t("treasury.tab.costs"), "data-testid": "treasury-tab-costs", content: panel("costs") },
        {
          id: "shares",
          label: t("coop.treasury.tabShares"),
          "data-testid": "treasury-tab-shares",
          content: panel("shares"),
        },
        {
          id: "patronage",
          label: t("coop.treasury.tabPatronage"),
          "data-testid": "treasury-tab-patronage",
          content: panel("patronage"),
        },
      ]}
    />
  );
}

export interface SharesPanelProps {
  /** null while loading. */
  shares: ShareDto[] | null;
  status: ShareStatus;
  onStatusChange: (status: ShareStatus) => void;
  /** Records the refund as sent now, with the treasurer's note (to the audit reason). */
  onRefund: (share: ShareDto, note: string) => Promise<void>;
  onRefundError: (err: unknown) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

const parseShareStatus = (value: string): ShareStatus | null => SHARE_STATUSES.find((s) => s === value) ?? null;

/** Treasury `shares` tab: shares by status; `refund_pending` rows record the refund as sent. */
export function SharesPanel({
  shares,
  status,
  onStatusChange,
  onRefund,
  onRefundError,
  hasMore,
  loadingMore,
  onLoadMore,
}: SharesPanelProps): React.JSX.Element {
  return (
    <Section
      heading={t("coop.treasury.sharesTitle")}
      description={t("coop.treasury.sharesIntro")}
      action={
        <FilterBar
          filters={[
            {
              id: "share-status",
              label: t("coop.treasury.shareStatus"),
              value: status,
              options: SHARE_STATUSES.map((s) => ({ value: s, label: shareStatusLabel(s) })),
              onValueChange: (value) => onStatusChange(parseShareStatus(value) ?? "refund_pending"),
            },
          ]}
        />
      }
    >
      <ShareRefundsTable
        labels={{
          caption: t("coop.treasury.sharesTitle"),
          member: t("coop.treasury.member"),
          status: t("coop.treasury.status"),
          amount: t("coop.treasury.amount"),
          since: t("coop.treasury.since"),
          actions: t("coop.treasury.actions"),
        }}
        rowProps={{ "data-testid": "treasury-share-row" }}
        empty={
          <EmptyState
            icon={Invoice01Icon}
            headingLevel={3}
            title={shares === null ? t("coop.loading") : t("coop.treasury.sharesEmpty")}
            description={shares === null ? undefined : t("coop.treasury.sharesEmptyHint")}
          />
        }
        rows={(shares ?? []).map((share) => ({
          id: share.id,
          user: { id: share.user.id, name: share.user.displayName },
          status: share.status,
          statusLabel: shareStatusLabel(share.status),
          amount: share.amount,
          since: <RelativeTime date={share.purchasedAt ?? share.createdAt} />,
          refund:
            share.status === "refund_pending"
              ? {
                  label: t("coop.treasury.refund"),
                  title: t("coop.treasury.refundTitle", { name: share.user.displayName }),
                  description: t("coop.treasury.refundHint"),
                  noteLabel: t("coop.treasury.refundNote"),
                  noteHint: t("coop.treasury.refundNoteHint"),
                  maxLength: REFUND_NOTE_MAX,
                  submitLabel: t("coop.treasury.refundSubmit"),
                  errorText: t("coop.treasury.refundFailed"),
                  onSubmit: (note) => onRefund(share, note),
                  onError: onRefundError,
                  triggerProps: { "data-testid": "treasury-share-refund" },
                  noteProps: { "data-testid": "treasury-share-refund-note" },
                  submitProps: { "data-testid": "treasury-share-refund-submit" },
                }
              : undefined,
        }))}
      />
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {t("coop.loadMore")}
          </Button>
        </div>
      )}
    </Section>
  );
}

export interface PatronageRunResultDto {
  periodId: string;
  members: number;
  total: { cents: number; currency: string };
  surplus: { cents: number; currency: string };
}

export interface PatronagePanelProps {
  /** The treasurer's user id: approve is disabled on the periods they ran. */
  meId: string;
  currency: string;
  values: PatronageRunFormValues;
  onValuesChange: (values: PatronageRunFormValues) => void;
  onRun: (submission: PatronageRunSubmission) => void | Promise<void>;
  running: boolean;
  /** Why the last run was refused (or the window is invalid). */
  runError: string | null;
  result: PatronageRunResultDto | null;
  /** null while loading. */
  periods: PatronagePeriodDto[] | null;
  onApprove: (period: PatronagePeriodDto) => Promise<void>;
  onApproveError: (err: unknown) => void;
}

/** Treasury `patronage` tab: run a period, the run's result, and every period with approval. */
export function PatronagePanel({
  meId,
  currency,
  values,
  onValuesChange,
  onRun,
  running,
  runError,
  result,
  periods,
  onApprove,
  onApproveError,
}: PatronagePanelProps): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <div className="flex flex-col gap-6">
      <PatronageRunForm
        data-testid="patronage-run-form"
        title={t("coop.patronageRun.title")}
        description={t("coop.patronageRun.intro")}
        currency={currency}
        labels={{
          start: t("coop.patronageRun.start"),
          end: t("coop.patronageRun.end"),
          timesHint: t("coop.patronageRun.timesHint"),
          surplus: t("coop.patronageRun.surplus"),
          surplusHint: t("coop.patronageRun.surplusHint"),
          surplusFormatError: t("coop.patronageRun.surplusFormat"),
          submit: t("coop.patronageRun.submit"),
        }}
        values={values}
        onValuesChange={onValuesChange}
        onSubmit={onRun}
        pending={running}
        error={runError ?? undefined}
        startProps={{ "data-testid": "patronage-run-start" }}
        endProps={{ "data-testid": "patronage-run-end" }}
        surplusProps={{ "data-testid": "patronage-run-surplus" }}
        submitProps={{ "data-testid": "patronage-run-submit" }}
      />
      {result && (
        <PatronageRunResult
          data-testid="patronage-run-result"
          data-period-id={result.periodId}
          title={t("coop.patronageRun.resultTitle")}
          description={t("coop.patronageRun.resultHint")}
          members={result.members}
          total={result.total}
          surplus={result.surplus}
          labels={{
            members: t("coop.patronageRun.members"),
            total: t("coop.patronageRun.total"),
            surplus: t("coop.patronageRun.surplusUsed"),
          }}
        />
      )}
      <Section heading={t("coop.periods.title")} description={t("coop.periods.intro")}>
        <PatronagePeriodsTable
          labels={{
            caption: t("coop.periods.title"),
            period: t("coop.periods.period"),
            status: t("coop.periods.status"),
            members: t("coop.periods.members"),
            total: t("coop.periods.total"),
            computedBy: t("coop.periods.computedBy"),
            approvedBy: t("coop.periods.approvedBy"),
            actions: t("coop.periods.actions"),
          }}
          rowProps={{ "data-testid": "patronage-period-row" }}
          empty={
            <EmptyState
              icon={Invoice01Icon}
              headingLevel={3}
              title={periods === null ? t("coop.loading") : t("coop.periods.empty")}
            />
          }
          rows={(periods ?? []).map((period) => ({
            id: period.id,
            period: periodText(period.periodStart, period.periodEnd, locale),
            status: period.status,
            statusLabel: patronageStatusLabel(period.status),
            members: period.members,
            total: period.total,
            computedBy: period.computedBy ? { id: period.computedBy.id, name: period.computedBy.username } : null,
            approvedBy: period.approvedBy ? { id: period.approvedBy.id, name: period.approvedBy.username } : null,
            approve:
              period.status === "computed"
                ? {
                    label: t("coop.periods.approve"),
                    confirmTitle: t("coop.periods.approveTitle"),
                    confirmDescription: t("coop.periods.approveHint"),
                    confirmLabel: t("coop.periods.approveConfirm"),
                    onConfirm: () => onApprove(period),
                    onError: onApproveError,
                    triggerProps: { "data-testid": "patronage-approve" },
                    disabledReason: period.computedBy?.id === meId ? t("coop.periods.secondApprover") : undefined,
                  }
                : undefined,
          }))}
        />
      </Section>
    </div>
  );
}
