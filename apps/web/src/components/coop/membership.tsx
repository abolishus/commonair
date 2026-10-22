// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, Skeleton, SkeletonGroup, formatMoney, formatNumber, useLocale } from "@commonair/ui";
import { EligibilityList, MembershipList, ShareCard, ShareInstructions } from "@commonair/ui/blocks/coop";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  basisLabel,
  canBuyShare,
  classLabel,
  exitRefundsShare,
  membershipStatusLabel,
  shareStatusLabel,
  type EligibilityDto,
  type MemberClass,
  type MembershipViewDto,
} from "../../lib/coop.ts";
import { CoopTabs } from "./nav.tsx";

/** What `coop.buyShare` returned with the manual provider. */
export interface ShareInstructionsDto {
  paymentId: string;
  reference: string;
  instructions: string;
  amount: { cents: number; currency: string };
}

export interface MembershipPanelProps {
  /** null while loading. */
  view: MembershipViewDto | null;
  /** From `membership.classes`; null while the settings load (or when unreadable). */
  rules: { shareCents: number; refundableOnExit: boolean } | null;
  /** Instance currency (the share's price before one exists). */
  currency: string;
  /** Set after buying; a pending share loaded later carries the same details in `view.share`. */
  instructions: ShareInstructionsDto | null;
  buying: boolean;
  onBuy: () => void | Promise<void>;
  onExit: (cls: MemberClass) => Promise<void>;
  onExitError: (err: unknown) => void;
}

function progressText(e: EligibilityDto, currency: string, locale: string): string {
  if (!e.progress) return "";
  if (e.progress.unit === "cents")
    return t("coop.eligibility.cents", {
      have: formatMoney(Math.round(e.progress.have), currency, locale),
      need: formatMoney(Math.round(e.progress.need), currency, locale),
    });
  return t("coop.eligibility.hours", {
    have: formatNumber(e.progress.have, locale),
    need: formatNumber(e.progress.need, locale),
  });
}

/** `/coop/membership`: memberships with exit, eligibility per class, and the member share. */
export function MembershipPanel({
  view,
  rules,
  currency,
  instructions: bought,
  buying,
  onBuy,
  onExit,
  onExitError,
}: MembershipPanelProps): React.JSX.Element {
  const { locale } = useLocale();
  const share = view?.share ?? null;
  const instructions: ShareInstructionsDto | null =
    bought ??
    (share?.status === "pending" && share.paymentId && share.reference && share.instructions
      ? {
          paymentId: share.paymentId,
          reference: share.reference,
          instructions: share.instructions,
          amount: share.amount,
        }
      : null);
  const shareStatus = instructions && !share ? "pending" : (share?.status ?? "none");
  const price = rules ? { cents: rules.shareCents, currency } : null;
  const amount = share?.amount ?? instructions?.amount ?? price;
  const shareNote =
    shareStatus === "none"
      ? t("coop.share.noteNone")
      : shareStatus === "pending"
        ? t("coop.share.notePending")
        : shareStatus === "held"
          ? rules?.refundableOnExit === false
            ? t("coop.share.noteHeldKept")
            : t("coop.share.noteHeld")
          : shareStatus === "refund_pending"
            ? t("coop.share.noteRefundPending")
            : undefined;
  return (
    <PageContainer data-testid="membership" width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("coop.membership.title")}
        description={t("coop.membership.intro")}
        tabs={<CoopTabs current="membership" />}
      />
      {view === null ? (
        <SkeletonGroup label={t("coop.loading")}>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </SkeletonGroup>
      ) : (
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <Section heading={t("coop.membership.memberships")}>
                <MembershipList
                  label={t("coop.membership.memberships")}
                  itemProps={{ "data-testid": "membership-row" }}
                  empty={
                    <EmptyState
                      icon={UserGroupIcon}
                      headingLevel={3}
                      title={t("coop.membership.emptyTitle")}
                      description={t("coop.membership.emptyHint")}
                    />
                  }
                  items={view.memberships.map((m) => ({
                    id: m.id,
                    memberClass: m.class,
                    classLabel: classLabel(m.class),
                    status: m.status,
                    statusLabel: membershipStatusLabel(m.status),
                    basis: m.basis,
                    basisLabel: basisLabel(m.basis),
                    since: <RelativeTime date={m.joinedAt} />,
                    exit:
                      m.status === "active"
                        ? {
                            label: t("coop.exit.label"),
                            confirmTitle: t("coop.exit.title", { class: classLabel(m.class) }),
                            confirmDescription: exitRefundsShare(view, m.class, rules?.refundableOnExit ?? null)
                              ? t("coop.exit.refunded")
                              : m.class === "viewer" && view.share?.status === "held"
                                ? t("coop.exit.notRefunded")
                                : t("coop.exit.noShare"),
                            confirmLabel: t("coop.exit.confirm"),
                            destructive: true,
                            onConfirm: () => onExit(m.class),
                            onError: onExitError,
                            triggerProps: { "data-testid": `membership-exit-${m.class}` },
                            dialogProps: { "data-testid": "membership-exit-confirm" },
                          }
                        : undefined,
                  }))}
                />
              </Section>
              <Section heading={t("coop.eligibility.title")} description={t("coop.eligibility.intro")}>
                <EligibilityList
                  itemProps={{ "data-testid": "membership-eligibility" }}
                  items={view.eligibility.map((e) => ({
                    memberClass: e.class,
                    classLabel: classLabel(e.class),
                    eligible: e.eligible,
                    statusLabel: e.eligible ? t("coop.eligibility.eligible") : t("coop.eligibility.notYet"),
                    basis: e.basis,
                    basisLabel: e.basis ? basisLabel(e.basis) : undefined,
                    progress: e.progress
                      ? {
                          label:
                            e.progress.unit === "hours"
                              ? t("coop.eligibility.hoursLabel")
                              : t("coop.eligibility.centsLabel"),
                          have: e.progress.have,
                          need: e.progress.need,
                          unit: e.progress.unit,
                          valueText: progressText(e, currency, locale),
                        }
                      : null,
                    detail: e.detail || undefined,
                  }))}
                />
              </Section>
            </div>
          }
          aside={
            <ShareCard
              data-testid="membership-share"
              title={t("coop.share.title")}
              description={t("coop.share.description")}
              status={shareStatus}
              statusLabel={shareStatusLabel(shareStatus)}
              amount={amount}
              amountLabel={t("coop.share.amount")}
              note={shareNote}
              buy={
                canBuyShare(view) && !instructions
                  ? {
                      label: t("coop.share.buy"),
                      onBuy,
                      pending: buying,
                      props: { "data-testid": "membership-buy-share" },
                    }
                  : undefined
              }
              instructions={
                instructions ? (
                  <ShareInstructions
                    data-testid="membership-share-instructions"
                    title={t("coop.share.instructionsTitle")}
                    instructions={instructions.instructions}
                    amount={instructions.amount}
                    amountLabel={t("coop.share.amount")}
                    reference={instructions.reference}
                    referenceLabel={t("coop.share.reference")}
                    copyLabel={t("coop.share.copy")}
                    copiedLabel={t("coop.share.copied")}
                    copyFailedLabel={t("coop.share.copyFailed")}
                    paymentId={instructions.paymentId}
                  />
                ) : undefined
              }
            />
          }
        />
      )}
    </PageContainer>
  );
}
